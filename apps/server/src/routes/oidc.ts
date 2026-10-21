import type { FastifyInstance, FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { createSession, setSessionCookie } from "../auth.js";
import { randomToken } from "../crypto.js";
import { notFound } from "../errors.js";
import { exchangeCode, getDiscovery, pkceChallenge } from "../oidc.js";
import { provisionUser } from "../provisioning.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

export const OIDC_COOKIE = "opensiel_oidc";

function fail(reply: FastifyReply, message: string) {
  return reply.redirect(`/login?sso_error=${encodeURIComponent(message)}`);
}

export function registerOidcRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/auth/oidc/start", async (_request, reply) => {
    const config = deps.env.oidc;
    if (!config) throw notFound("SSO is not configured");

    const discovery = await getDiscovery(config.issuer);
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(32);

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");

    const key = new TextEncoder().encode(deps.env.jwtSecret);
    const cookie = await new SignJWT({ typ: "oidc", state, nonce, verifier })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("opensiel-oidc")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);

    reply.setCookie(OIDC_COOKIE, cookie, {
      path: "/api/auth/oidc",
      httpOnly: true,
      sameSite: "lax",
      secure: deps.env.secureCookies,
      maxAge: 600,
    });

    return reply.redirect(url.toString());
  });

  app.get("/api/auth/oidc/callback", async (request, reply) => {
    const config = deps.env.oidc;
    if (!config) throw notFound("SSO is not configured");

    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    if (query.error) return fail(reply, query.error_description ?? query.error);
    if (!query.code || !query.state) return fail(reply, "missing code or state");

    const cookies = (request as typeof request & { cookies?: Record<string, string | undefined> })
      .cookies;
    const cookie = cookies?.[OIDC_COOKIE];
    if (!cookie) return fail(reply, "SSO session expired; try again");

    let payload;
    try {
      const verified = await jwtVerify(cookie, new TextEncoder().encode(deps.env.jwtSecret), {
        issuer: "opensiel-oidc",
        algorithms: ["HS256"],
      });
      payload = verified.payload;
    } catch {
      return fail(reply, "invalid SSO session; try again");
    }

    if (payload.typ !== "oidc" || payload.state !== query.state) {
      return fail(reply, "state mismatch; try again");
    }

    reply.clearCookie(OIDC_COOKIE, { path: "/api/auth/oidc" });

    let claims;
    try {
      const discovery = await getDiscovery(config.issuer);
      claims = await exchangeCode(
        config,
        discovery,
        query.code,
        String(payload.verifier ?? ""),
        String(payload.nonce ?? ""),
      );
    } catch (error) {
      return fail(reply, error instanceof Error ? error.message : "SSO login failed");
    }

    if (config.allowedDomains.length > 0) {
      const domain = claims.email.split("@")[1] ?? "";
      if (!config.allowedDomains.includes(domain)) {
        return fail(reply, `email domain '${domain}' is not allowed`);
      }
    }

    let provisioned;
    try {
      provisioned = await provisionUser(deps, config, claims.email, claims.name);
    } catch (error) {
      return fail(reply, error instanceof Error ? error.message : "could not provision account");
    }

    const token = await createSession(deps.db, provisioned.userId);
    setSessionCookie(reply, token, deps.env.secureCookies);

    await writeAudit(deps, {
      orgId: provisioned.orgId,
      actorType: "user",
      actorId: provisioned.userId,
      actorName: provisioned.userName,
      action: "auth.oidc.login",
      resourceType: "session",
      resourceId: provisioned.userId,
      metadata: { issuer: config.issuer, email: claims.email },
      ip: request.ip,
    });

    return reply.redirect("/app");
  });
}

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { createSession, hashPassword, setSessionCookie } from "../auth.js";
import { createProject } from "../projects-service.js";
import { slugify, uniqueOrgSlug } from "../access.js";
import { randomToken } from "../crypto.js";
import { forbidden, notFound } from "../errors.js";
import { orgInvites, orgMembers, orgs, users } from "../db/schema.js";
import { exchangeCode, getDiscovery, pkceChallenge } from "../oidc.js";
import type { OidcConfig } from "../env.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

export const OIDC_COOKIE = "opensiel_oidc";

interface Provisioned {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
}

async function provisionUser(
  deps: Deps,
  config: OidcConfig,
  email: string,
  name: string,
): Promise<Provisioned> {
  const existingRows = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existingRows[0];

  if (user) {
    const membership = await deps.db
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.userId, user.id))
      .limit(1);
    if (membership[0]) {
      const orgRows = await deps.db.select().from(orgs).where(eq(orgs.id, membership[0].orgId)).limit(1);
      if (orgRows[0]) {
        return { userId: user.id, userName: user.name, orgId: orgRows[0].id, orgName: orgRows[0].name };
      }
    }
  }

  const invites = await deps.db
    .select({ invite: orgInvites, org: orgs })
    .from(orgInvites)
    .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
    .where(
      and(
        eq(orgInvites.email, email),
        isNull(orgInvites.acceptedAt),
        gt(orgInvites.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(orgInvites.createdAt))
    .limit(1);

  const invite = invites[0];

  if (!user) {
    if (!invite && !config.autoCreate) {
      throw forbidden("no account or invite exists for this email");
    }
    const passwordHash = await hashPassword(randomToken(32));
    try {
      const inserted = await deps.db
        .insert(users)
        .values({ email, passwordHash, name })
        .returning();
      user = inserted[0];
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
        const retry = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
        user = retry[0];
        if (!user) throw error;
      } else {
        throw error;
      }
    }
  }

  if (invite) {
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(orgMembers)
        .values({ orgId: invite.org.id, userId: user!.id, role: invite.invite.role })
        .onConflictDoNothing();
      await tx
        .update(orgInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(orgInvites.id, invite.invite.id));
    });
    return {
      userId: user.id,
      userName: user.name,
      orgId: invite.org.id,
      orgName: invite.org.name,
    };
  }

  if (!config.autoCreate) {
    throw forbidden("no account or invite exists for this email");
  }

  const orgSlug = await uniqueOrgSlug(deps.db, slugify(`${name || email}-org`));
  const orgRows = await deps.db
    .insert(orgs)
    .values({ name: `${name || email}'s org`, slug: orgSlug })
    .returning();
  const org = orgRows[0];

  await deps.db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
  await createProject(deps, org.id, "default");

  return { userId: user.id, userName: user.name, orgId: org.id, orgName: org.name };
}

function fail(reply: FastifyReply, message: string) {
  return reply.redirect(`/?sso_error=${encodeURIComponent(message)}`);
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

    const cookies = (request as typeof request & { cookies?: Record<string, string | undefined> }).cookies;
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

    let provisioned: Provisioned;
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

    return reply.redirect("/");
  });
}

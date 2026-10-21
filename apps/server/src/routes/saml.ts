import type { FastifyInstance, FastifyReply } from "fastify";
import { createSession, setSessionCookie } from "../auth.js";
import { notFound } from "../errors.js";
import { getSaml } from "../saml.js";
import { provisionUser } from "../provisioning.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

function fail(reply: FastifyReply, message: string) {
  return reply.redirect(`/?sso_error=${encodeURIComponent(message)}`);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function registerSamlRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/auth/saml/metadata", async (_request, reply) => {
    const config = deps.env.saml;
    if (!config) throw notFound("SAML is not configured");
    const metadata = getSaml(config).generateServiceProviderMetadata(null, null);
    return reply.type("application/xml").send(metadata);
  });

  app.get("/api/auth/saml/start", async (request, reply) => {
    const config = deps.env.saml;
    if (!config) throw notFound("SAML is not configured");
    const url = await getSaml(config).getAuthorizeUrlAsync("", request.hostname, {});
    return reply.redirect(url);
  });

  app.post(
    "/api/auth/saml/callback",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const config = deps.env.saml;
      if (!config) throw notFound("SAML is not configured");

      const body = request.body as { SAMLResponse?: string } | undefined;
      if (!body?.SAMLResponse) return fail(reply, "missing SAMLResponse");

      let result;
      try {
        result = await getSaml(config).validatePostResponseAsync({
          SAMLResponse: body.SAMLResponse,
        });
      } catch (error) {
        return fail(
          reply,
          error instanceof Error ? `SAML login failed: ${error.message}` : "SAML login failed",
        );
      }

      const profile = (result.profile ?? {}) as Record<string, unknown>;
      const email = firstString(profile, ["email", "mail", "nameID", "nameId"])?.toLowerCase();
      if (!email || !email.includes("@")) {
        return fail(reply, "the SAML assertion did not contain an email address");
      }

      const name =
        firstString(profile, ["name", "displayName", "cn", "givenName"]) ?? email.split("@")[0];

      if (config.allowedDomains.length > 0) {
        const domain = email.split("@")[1] ?? "";
        if (!config.allowedDomains.includes(domain)) {
          return fail(reply, `email domain '${domain}' is not allowed`);
        }
      }

      let provisioned;
      try {
        provisioned = await provisionUser(deps, config, email, name);
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
        action: "auth.saml.login",
        resourceType: "session",
        resourceId: provisioned.userId,
        metadata: { issuer: config.issuer, email },
        ip: request.ip,
      });

      return reply.redirect("/");
    },
  );
}

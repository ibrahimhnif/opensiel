import { and, count, eq, gte } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  acceptInviteSchema,
  loginSchema,
  signupSchema,
  tokenRequestSchema,
} from "@opensiel/shared";
import {
  clearSessionCookie,
  createSession,
  hashPassword,
  ipAllowed,
  requireActor,
  requireUser,
  revokeSession,
  setSessionCookie,
  signMachineToken,
  verifyMachineSecret,
  verifyPassword,
  SESSION_COOKIE,
} from "../auth.js";
import { sha256 } from "../crypto.js";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  parse,
  unauthorized,
} from "../errors.js";
import {
  auditLogs,
  orgInvites,
  orgMembers,
  orgs,
  users,
  identities,
  identityScopes,
  projects,
} from "../db/schema.js";
import { createProject, DEFAULT_ENVIRONMENTS } from "../projects-service.js";
import { slugify, uniqueOrgSlug } from "../access.js";
import { writeAudit } from "../audit.js";
import type { Actor, Deps } from "../types.js";

function userDto(actor: Extract<Actor, { type: "user" }>) {
  return {
    id: actor.id,
    email: actor.email,
    name: actor.name,
    role: actor.role,
    orgId: actor.orgId,
    orgName: actor.orgName,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/auth/config", async () => {
    const rows = await deps.db.select({ total: count() }).from(users);
    const initialized = Number(rows[0]?.total ?? 0) > 0;
    return {
      initialized,
      signupEnabled: deps.env.allowSignup || !initialized,
      version: "0.1.0",
      oidc: deps.env.oidc
        ? { enabled: true, name: new URL(deps.env.oidc.issuer).host }
        : { enabled: false },
      saml: deps.env.saml
        ? { enabled: true, name: new URL(deps.env.saml.entryPoint).host }
        : { enabled: false },
    };
  });

  app.post(
    "/api/auth/signup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(signupSchema, request.body);
      const rows = await deps.db.select({ total: count() }).from(users);
      const initialized = Number(rows[0]?.total ?? 0) > 0;
      if (initialized && !deps.env.allowSignup) {
        throw new AppError(
          403,
          "this instance is invite-only; ask an owner for an invite link",
          "signup_disabled",
        );
      }

      const passwordHash = await hashPassword(input.password);
      let user;
      try {
        const inserted = await deps.db
          .insert(users)
          .values({ email: input.email, passwordHash, name: input.name })
          .returning();
        user = inserted[0];
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("email is already registered");
        throw error;
      }

      const orgSlug = await uniqueOrgSlug(deps.db, slugify(input.orgName ?? `${input.name}-org`));
      const orgRows = await deps.db
        .insert(orgs)
        .values({ name: input.orgName ?? `${input.name}'s org`, slug: orgSlug })
        .returning();
      const org = orgRows[0];
      await deps.db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });

      const project = await createProject(deps, org.id, "default");

      const token = await createSession(deps.db, user.id);
      setSessionCookie(reply, token, deps.env.secureCookies);

      return reply.code(201).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: "owner",
          orgId: org.id,
          orgName: org.name,
        },
        projectId: project.id,
        environments: DEFAULT_ENVIRONMENTS,
      });
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(loginSchema, request.body);
      const rows = await deps.db
        .select({ user: users, member: orgMembers, org: orgs })
        .from(users)
        .innerJoin(orgMembers, eq(orgMembers.userId, users.id))
        .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
        .where(eq(users.email, input.email))
        .limit(1);
      const row = rows[0];
      const valid = row ? await verifyPassword(row.user.passwordHash, input.password) : false;
      if (!row || !valid) throw unauthorized("invalid email or password");

      const token = await createSession(deps.db, row.user.id);
      setSessionCookie(reply, token, deps.env.secureCookies);

      return {
        token,
        user: {
          id: row.user.id,
          email: row.user.email,
          name: row.user.name,
          role: row.member.role,
          orgId: row.org.id,
          orgName: row.org.name,
        },
      };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
      .cookies;
    const token = cookies?.[SESSION_COOKIE];
    if (token) await revokeSession(deps.db, token);
    clearSessionCookie(reply, deps.env.secureCookies);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    return { user: userDto(actor) };
  });

  app.get(
    "/api/auth/invite",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const token = (request.query as { token?: string }).token;
      if (!token) throw badRequest("token is required");

      const rows = await deps.db
        .select({ invite: orgInvites, org: orgs })
        .from(orgInvites)
        .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
        .where(eq(orgInvites.tokenHash, sha256(token)))
        .limit(1);
      const row = rows[0];
      if (!row || row.invite.acceptedAt) throw notFound("invite not found");
      if (row.invite.expiresAt.getTime() <= Date.now()) {
        throw new AppError(410, "this invite has expired", "invite_expired");
      }

      return {
        invite: {
          email: row.invite.email,
          role: row.invite.role,
          orgName: row.org.name,
          orgSlug: row.org.slug,
          expiresAt: row.invite.expiresAt.toISOString(),
        },
      };
    },
  );

  app.post(
    "/api/auth/accept-invite",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parse(acceptInviteSchema, request.body);

      const rows = await deps.db
        .select({ invite: orgInvites, org: orgs })
        .from(orgInvites)
        .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
        .where(eq(orgInvites.tokenHash, sha256(input.token)))
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("invite not found");
      if (row.invite.acceptedAt) throw conflict("this invite has already been used");
      if (row.invite.expiresAt.getTime() <= Date.now()) {
        throw new AppError(410, "this invite has expired", "invite_expired");
      }

      const existingRows = await deps.db
        .select()
        .from(users)
        .where(eq(users.email, row.invite.email))
        .limit(1);
      const existing = existingRows[0];

      let user;
      if (existing) {
        if (!input.password) throw badRequest("password is required for an existing account");
        const valid = await verifyPassword(existing.passwordHash, input.password);
        if (!valid) throw unauthorized("invalid password");
        const membership = await deps.db
          .select({ orgId: orgMembers.orgId })
          .from(orgMembers)
          .where(eq(orgMembers.userId, existing.id))
          .limit(1);
        if (membership.length > 0)
          throw conflict("this account already belongs to an organization");
        user = existing;
      } else {
        if (!input.name || !input.password) throw badRequest("name and password are required");
        const passwordHash = await hashPassword(input.password);
        try {
          const inserted = await deps.db
            .insert(users)
            .values({ email: row.invite.email, passwordHash, name: input.name })
            .returning();
          user = inserted[0];
        } catch (error) {
          if (isUniqueViolation(error)) throw conflict("email is already registered");
          throw error;
        }
      }

      await deps.db.transaction(async (tx) => {
        await tx.insert(orgMembers).values({
          orgId: row.org.id,
          userId: user.id,
          role: row.invite.role,
        });
        await tx
          .update(orgInvites)
          .set({ acceptedAt: new Date() })
          .where(eq(orgInvites.id, row.invite.id));
      });

      const token = await createSession(deps.db, user.id);
      setSessionCookie(reply, token, deps.env.secureCookies);

      await writeAudit(deps, {
        orgId: row.org.id,
        actorType: "user",
        actorId: user.id,
        actorName: user.name,
        action: "org.invite.accept",
        resourceType: "invite",
        resourceId: row.invite.id,
        metadata: { email: user.email, role: row.invite.role },
        ip: request.ip,
      });

      return reply.code(201).send({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: row.invite.role,
          orgId: row.org.id,
          orgName: row.org.name,
        },
      });
    },
  );

  app.post(
    "/api/auth/token",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const input = parse(tokenRequestSchema, request.body);
      const rows = await deps.db
        .select()
        .from(identities)
        .where(eq(identities.clientId, input.clientId))
        .limit(1);
      const identity = rows[0];
      if (
        !identity ||
        identity.revokedAt ||
        !verifyMachineSecret(identity.secretHash, input.clientSecret)
      ) {
        throw unauthorized("invalid client credentials");
      }

      const projectRows = await deps.db
        .select()
        .from(projects)
        .where(eq(projects.id, identity.projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) throw unauthorized("invalid client credentials");

      if (!ipAllowed(identity.ipAllowlist, request.ip)) {
        await writeAudit(deps, {
          orgId: project.orgId,
          projectId: project.id,
          actorType: "machine",
          actorId: identity.id,
          actorName: identity.name,
          action: "identity.token.denied",
          resourceType: "identity",
          resourceId: identity.id,
          metadata: { reason: "ip_not_allowed", ip: request.ip },
          ip: request.ip,
        });
        throw forbidden("this identity may not issue tokens from this address");
      }

      if (identity.hourlyTokenCap !== null) {
        const since = new Date(Date.now() - 60 * 60 * 1000);
        const tally = await deps.db
          .select({ total: count() })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.action, "identity.token"),
              eq(auditLogs.resourceId, identity.id),
              gte(auditLogs.createdAt, since),
            ),
          );
        if (Number(tally[0]?.total ?? 0) >= identity.hourlyTokenCap) {
          throw new AppError(
            429,
            "token issuance limit reached for this identity",
            "token_limit_reached",
          );
        }
      }

      const scopes = await deps.db
        .select()
        .from(identityScopes)
        .where(eq(identityScopes.identityId, identity.id));

      const accessToken = await signMachineToken(
        deps.env,
        {
          identityId: identity.id,
          name: identity.name,
          role: identity.role,
          projectId: identity.projectId,
          orgId: project.orgId,
          envIds: scopes.map((scope) => scope.environmentId),
          tokenVersion: identity.tokenVersion,
        },
        identity.tokenTtlSeconds,
      );

      await writeAudit(deps, {
        orgId: project.orgId,
        projectId: project.id,
        actorType: "machine",
        actorId: identity.id,
        actorName: identity.name,
        action: "identity.token",
        resourceType: "identity",
        resourceId: identity.id,
        metadata: {
          clientId: sha256(input.clientId).slice(0, 12),
          ttlSeconds: identity.tokenTtlSeconds,
          ip: request.ip,
        },
        ip: request.ip,
      });

      return {
        accessToken,
        expiresIn: identity.tokenTtlSeconds,
        tokenType: "Bearer",
      };
    },
  );
}

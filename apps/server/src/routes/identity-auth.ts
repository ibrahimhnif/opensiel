import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityAuthMethodDto } from "@opensiel/shared";
import { createIdentityAuthMethodSchema, identityJwtTokenSchema } from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { notFound, parse, unauthorized } from "../errors.js";
import { identities, identityAuthMethods, projects } from "../db/schema.js";
import type { IdentityAuthMethodRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { issueIdentityToken } from "../identity-token.js";
import type { Deps } from "../types.js";

const ALLOWED_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

function methodDto(row: IdentityAuthMethodRow): IdentityAuthMethodDto {
  return {
    id: row.id,
    type: row.type,
    issuer: row.issuer,
    audience: row.audience,
    jwksUri: row.jwksUri,
    allowedSubjects: row.allowedSubjects ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadIdentity(deps: Deps, projectId: string, identityId: string) {
  const rows = await deps.db
    .select()
    .from(identities)
    .where(and(eq(identities.id, identityId), eq(identities.projectId, projectId)))
    .limit(1);
  const identity = rows[0];
  if (!identity) throw notFound("identity not found");
  return identity;
}

export function registerIdentityAuthRoutes(app: FastifyInstance, deps: Deps): void {
  app.post(
    "/api/auth/token/jwt",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const input = parse(identityJwtTokenSchema, request.body);
      const identityRows = await deps.db
        .select()
        .from(identities)
        .where(eq(identities.clientId, input.clientId))
        .limit(1);
      const identity = identityRows[0];
      if (!identity || identity.revokedAt) throw unauthorized("token verification failed");

      const projectRows = await deps.db
        .select()
        .from(projects)
        .where(eq(projects.id, identity.projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) throw unauthorized("token verification failed");

      const methods = await deps.db
        .select()
        .from(identityAuthMethods)
        .where(eq(identityAuthMethods.identityId, identity.id));

      let verified = false;
      for (const method of methods) {
        if (method.type !== "jwt") continue;
        try {
          const { payload } = await jwtVerify(input.jwt, jwksFor(method.jwksUri), {
            issuer: method.issuer,
            audience: method.audience,
            algorithms: ALLOWED_ALGORITHMS,
            clockTolerance: 30,
          });
          const subject = String(payload.sub ?? "");
          if (
            method.allowedSubjects &&
            method.allowedSubjects.length > 0 &&
            !method.allowedSubjects.includes(subject)
          ) {
            continue;
          }
          verified = true;
          break;
        } catch {
          continue;
        }
      }

      if (!verified) {
        await writeAudit(deps, {
          orgId: project.orgId,
          projectId: project.id,
          actorType: "machine",
          actorId: identity.id,
          actorName: identity.name,
          action: "identity.token.denied",
          resourceType: "identity",
          resourceId: identity.id,
          metadata: { reason: "auth_method_failed", method: "jwt", ip: request.ip },
          ip: request.ip,
        });
        throw unauthorized("token verification failed");
      }

      return issueIdentityToken(deps, identity, project, request.ip, "jwt");
    },
  );

  app.get("/api/projects/:projectId/identities/:identityId/auth-methods", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const { projectId, identityId } = request.params as {
      projectId: string;
      identityId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    await loadIdentity(deps, project.id, identityId);

    const rows = await deps.db
      .select()
      .from(identityAuthMethods)
      .where(eq(identityAuthMethods.identityId, identityId))
      .orderBy(identityAuthMethods.createdAt);

    return { methods: rows.map(methodDto) };
  });

  app.post(
    "/api/projects/:projectId/identities/:identityId/auth-methods",
    async (request, reply) => {
      const actor = await requireActor(deps, request);
      assertCanAdmin(actor);
      const { projectId, identityId } = request.params as {
        projectId: string;
        identityId: string;
      };
      const project = await loadProject(deps, actor, projectId);
      const identity = await loadIdentity(deps, project.id, identityId);
      const input = parse(createIdentityAuthMethodSchema, request.body);

      const inserted = await deps.db
        .insert(identityAuthMethods)
        .values({
          identityId: identity.id,
          type: input.type,
          issuer: input.issuer,
          audience: input.audience,
          jwksUri: input.jwksUri,
          allowedSubjects: input.allowedSubjects ?? null,
        })
        .returning();

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "identity.auth_method.create",
        resourceType: "identity",
        resourceId: identity.id,
        metadata: {
          method: input.type,
          issuer: input.issuer,
          audience: input.audience,
        },
        ip: request.ip,
      });

      return reply.code(201).send({ method: methodDto(inserted[0]) });
    },
  );

  app.delete(
    "/api/projects/:projectId/identities/:identityId/auth-methods/:methodId",
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanAdmin(actor);
      const { projectId, identityId, methodId } = request.params as {
        projectId: string;
        identityId: string;
        methodId: string;
      };
      const project = await loadProject(deps, actor, projectId);
      const identity = await loadIdentity(deps, project.id, identityId);

      const rows = await deps.db
        .select()
        .from(identityAuthMethods)
        .where(
          and(
            eq(identityAuthMethods.id, methodId),
            eq(identityAuthMethods.identityId, identity.id),
          ),
        )
        .limit(1);
      const method = rows[0];
      if (!method) throw notFound("auth method not found");

      await deps.db.delete(identityAuthMethods).where(eq(identityAuthMethods.id, method.id));

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "identity.auth_method.delete",
        resourceType: "identity",
        resourceId: identity.id,
        metadata: { method: method.type, issuer: method.issuer },
        ip: request.ip,
      });

      return { ok: true };
    },
  );
}

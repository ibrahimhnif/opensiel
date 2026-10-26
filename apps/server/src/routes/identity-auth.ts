import { and, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IdentityAuthMethodDto } from "@opensiel/shared";
import {
  createIdentityAuthMethodSchema,
  identityAwsTokenSchema,
  identityJwtTokenSchema,
} from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { notFound, parse, unauthorized } from "../errors.js";
import { awsAuthNonces, identities, identityAuthMethods, projects } from "../db/schema.js";
import type { IdentityAuthMethodRow } from "../db/schema.js";
import { sha256 } from "../crypto.js";
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
    allowedArns: (row.config as { allowedArns?: string[] } | null)?.allowedArns ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function arnMatches(pattern: string, arn: string): boolean {
  if (pattern === arn) return true;
  if (pattern.endsWith("*")) return arn.startsWith(pattern.slice(0, -1));
  return false;
}

function roleArnFromSession(arn: string): string | null {
  const match = /^arn:(aws[a-zA-Z-]*):sts::(\d+):assumed-role\/([^/]+)\/.+$/.exec(arn);
  if (!match) return null;
  return `arn:${match[1]}:iam::${match[2]}:role/${match[3]}`;
}

function parseAmzDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return Number.NaN;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

function currentMethodMatches(method: IdentityAuthMethodRow, arn: string): boolean {
  const allowed = (method.config as { allowedArns?: string[] } | null)?.allowedArns ?? [];
  const candidates = [arn, roleArnFromSession(arn)].filter((value): value is string =>
    Boolean(value),
  );
  return allowed.some((pattern) => candidates.some((candidate) => arnMatches(pattern, candidate)));
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
        if (method.type !== "jwt" || !method.issuer || !method.audience || !method.jwksUri) {
          continue;
        }
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

  app.post(
    "/api/auth/token/aws",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const input = parse(identityAwsTokenSchema, request.body);
      const identityRows = await deps.db
        .select()
        .from(identities)
        .where(eq(identities.clientId, input.clientId))
        .limit(1);
      const identity = identityRows[0];
      if (!identity || identity.revokedAt) throw unauthorized("AWS identity verification failed");

      const projectRows = await deps.db
        .select()
        .from(projects)
        .where(eq(projects.id, identity.projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project) throw unauthorized("AWS identity verification failed");

      const methods = await deps.db
        .select()
        .from(identityAuthMethods)
        .where(eq(identityAuthMethods.identityId, identity.id));
      const awsMethods = methods.filter((method) => method.type === "aws");
      if (awsMethods.length === 0) throw unauthorized("AWS identity verification failed");

      const stamp = parseAmzDate(input.amzDate);
      if (Number.isNaN(stamp) || Math.abs(Date.now() - stamp) > 5 * 60_000) {
        throw unauthorized("stale or invalid AWS request date");
      }

      const sigHash = sha256(input.authorization);
      await deps.db.delete(awsAuthNonces).where(lt(awsAuthNonces.expiresAt, new Date()));
      const claimed = await deps.db
        .insert(awsAuthNonces)
        .values({ sigHash, expiresAt: new Date(Date.now() + 10 * 60_000) })
        .onConflictDoNothing()
        .returning();
      if (claimed.length === 0) throw unauthorized("this signed request was already used");

      let arn: string | undefined;
      try {
        const headers: Record<string, string> = {
          authorization: input.authorization,
          "x-amz-date": input.amzDate,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        };
        if (input.securityToken) headers["x-amz-security-token"] = input.securityToken;

        const response = await fetch(deps.env.awsStsEndpoint, {
          method: "POST",
          headers,
          body: "Action=GetCallerIdentity&Version=2011-06-15",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`sts responded ${response.status}`);
        const text = await response.text();
        arn = /<Arn>([^<]+)<\/Arn>/.exec(text)?.[1];
        if (!arn) throw new Error("sts response has no arn");
      } catch {
        await deps.db.delete(awsAuthNonces).where(eq(awsAuthNonces.sigHash, sigHash));
        await writeAudit(deps, {
          orgId: project.orgId,
          projectId: project.id,
          actorType: "machine",
          actorId: identity.id,
          actorName: identity.name,
          action: "identity.token.denied",
          resourceType: "identity",
          resourceId: identity.id,
          metadata: { reason: "aws_sts_failed", method: "aws", ip: request.ip },
          ip: request.ip,
        });
        throw unauthorized("AWS identity verification failed");
      }

      if (!awsMethods.some((method) => currentMethodMatches(method, arn!))) {
        await writeAudit(deps, {
          orgId: project.orgId,
          projectId: project.id,
          actorType: "machine",
          actorId: identity.id,
          actorName: identity.name,
          action: "identity.token.denied",
          resourceType: "identity",
          resourceId: identity.id,
          metadata: { reason: "aws_arn_not_allowed", method: "aws", arn, ip: request.ip },
          ip: request.ip,
        });
        throw unauthorized("AWS identity is not allowed for this identity");
      }

      return issueIdentityToken(deps, identity, project, request.ip, "aws");
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
        .values(
          input.type === "aws"
            ? {
                identityId: identity.id,
                type: "aws",
                config: { allowedArns: input.allowedArns },
              }
            : {
                identityId: identity.id,
                type: "jwt",
                issuer: input.issuer,
                audience: input.audience,
                jwksUri: input.jwksUri,
                allowedSubjects: input.allowedSubjects ?? null,
              },
        )
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
        metadata:
          input.type === "aws"
            ? { method: "aws", allowedArns: input.allowedArns }
            : {
                method: "jwt",
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

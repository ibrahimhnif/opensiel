import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createIdentitySchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { badRequest, forbidden, notFound, parse } from "../errors.js";
import { randomToken, sha256 } from "../crypto.js";
import { environments, identities, identityScopes } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

function identityDto(identity: typeof identities.$inferSelect, environmentIds: string[]) {
  return {
    id: identity.id,
    name: identity.name,
    clientId: identity.clientId,
    role: identity.role,
    environmentIds,
    createdAt: identity.createdAt.toISOString(),
    revokedAt: identity.revokedAt?.toISOString() ?? null,
  };
}

export function registerIdentityRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/identities", async (request) => {
    const actor = await requireActor(deps, request);
    if (actor.type === "machine") throw forbidden("a user session is required");
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(identities)
      .where(eq(identities.projectId, project.id))
      .orderBy(identities.createdAt);

    if (rows.length === 0) return { identities: [] };
    const scopes = await deps.db
      .select()
      .from(identityScopes)
      .where(
        inArray(
          identityScopes.identityId,
          rows.map((row) => row.id),
        ),
      );

    return {
      identities: rows.map((identity) =>
        identityDto(
          identity,
          scopes
            .filter((scope) => scope.identityId === identity.id)
            .map((scope) => scope.environmentId),
        ),
      ),
    };
  });

  app.post("/api/projects/:projectId/identities", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createIdentitySchema, request.body);

    const envRows = await deps.db
      .select()
      .from(environments)
      .where(
        and(eq(environments.projectId, project.id), inArray(environments.id, input.environmentIds)),
      );
    if (envRows.length !== new Set(input.environmentIds).size) {
      throw badRequest("one or more environments do not belong to this project");
    }

    const clientId = `osl_${randomToken(12)}`;
    const clientSecret = `oss_${randomToken(32)}`;

    const inserted = await deps.db
      .insert(identities)
      .values({
        projectId: project.id,
        name: input.name,
        clientId,
        secretHash: sha256(clientSecret),
        role: input.role,
      })
      .returning();
    const identity = inserted[0];

    await deps.db.insert(identityScopes).values(
      Array.from(new Set(input.environmentIds)).map((environmentId) => ({
        identityId: identity.id,
        environmentId,
      })),
    );

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "identity.create",
      resourceType: "identity",
      resourceId: identity.id,
      metadata: { name: identity.name, role: identity.role, environmentIds: input.environmentIds },
      ip: request.ip,
    });

    return reply.code(201).send({
      identity: {
        ...identityDto(identity, input.environmentIds),
        clientSecret,
      },
    });
  });

  app.post("/api/projects/:projectId/identities/:identityId/revoke", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, identityId } = request.params as { projectId: string; identityId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(identities)
      .where(and(eq(identities.id, identityId), eq(identities.projectId, project.id)))
      .limit(1);
    const identity = rows[0];
    if (!identity) throw notFound("identity not found");

    await deps.db
      .update(identities)
      .set({ revokedAt: new Date() })
      .where(eq(identities.id, identity.id));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "identity.revoke",
      resourceType: "identity",
      resourceId: identity.id,
      metadata: { name: identity.name },
      ip: request.ip,
    });

    return { ok: true };
  });
}

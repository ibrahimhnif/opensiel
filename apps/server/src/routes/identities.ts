import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createIdentitySchema, updateIdentitySchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { badRequest, forbidden, notFound, parse } from "../errors.js";
import { randomToken, sha256 } from "../crypto.js";
import { environments, identities, identityScopes } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { paginate, paginationSchema, sortRows } from "../pagination.js";
import type { Deps } from "../types.js";

function identityDto(identity: typeof identities.$inferSelect, environmentIds: string[]) {
  return {
    id: identity.id,
    name: identity.name,
    clientId: identity.clientId,
    role: identity.role,
    environmentIds,
    tokenTtlSeconds: identity.tokenTtlSeconds,
    ipAllowlist: identity.ipAllowlist ?? null,
    hourlyTokenCap: identity.hourlyTokenCap,
    createdAt: identity.createdAt.toISOString(),
    revokedAt: identity.revokedAt?.toISOString() ?? null,
  };
}

async function assertEnvironments(
  deps: Deps,
  projectId: string,
  environmentIds: string[],
): Promise<void> {
  const envRows = await deps.db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), inArray(environments.id, environmentIds)));
  if (envRows.length !== new Set(environmentIds).size) {
    throw badRequest("one or more environments do not belong to this project");
  }
}

export function registerIdentityRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/identities", async (request) => {
    const actor = await requireActor(deps, request);
    if (actor.type === "machine") throw forbidden("a user session is required");
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const query = parse(paginationSchema, request.query);

    const allRows = await deps.db
      .select()
      .from(identities)
      .where(eq(identities.projectId, project.id))
      .orderBy(identities.createdAt);

    const needle = query.q?.toLowerCase();
    const filtered = needle
      ? allRows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.clientId.toLowerCase().includes(needle) ||
            row.role.toLowerCase().includes(needle),
        )
      : allRows;
    const sorted = sortRows(filtered, query, {
      name: (row) => row.name,
      role: (row) => row.role,
      createdAt: (row) => row.createdAt.getTime(),
      revokedAt: (row) => row.revokedAt?.getTime() ?? null,
    });
    const page = paginate(sorted, query);
    if (page.items.length === 0) {
      return {
        identities: [],
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      };
    }

    const scopes = await deps.db
      .select()
      .from(identityScopes)
      .where(
        inArray(
          identityScopes.identityId,
          page.items.map((row) => row.id),
        ),
      );

    return {
      identities: page.items.map((identity) =>
        identityDto(
          identity,
          scopes
            .filter((scope) => scope.identityId === identity.id)
            .map((scope) => scope.environmentId),
        ),
      ),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.post("/api/projects/:projectId/identities", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createIdentitySchema, request.body);
    await assertEnvironments(deps, project.id, input.environmentIds);

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
        tokenTtlSeconds: input.tokenTtlSeconds ?? 900,
        ipAllowlist: input.ipAllowlist ?? null,
        hourlyTokenCap: input.hourlyTokenCap ?? null,
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

  app.patch("/api/projects/:projectId/identities/:identityId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, identityId } = request.params as { projectId: string; identityId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(updateIdentitySchema, request.body);

    const rows = await deps.db
      .select()
      .from(identities)
      .where(and(eq(identities.id, identityId), eq(identities.projectId, project.id)))
      .limit(1);
    const identity = rows[0];
    if (!identity) throw notFound("identity not found");
    if (input.environmentIds) await assertEnvironments(deps, project.id, input.environmentIds);

    const updated = await deps.db.transaction(async (tx) => {
      const result = await tx
        .update(identities)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.tokenTtlSeconds !== undefined
            ? { tokenTtlSeconds: input.tokenTtlSeconds }
            : {}),
          ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}),
          ...(input.hourlyTokenCap !== undefined ? { hourlyTokenCap: input.hourlyTokenCap } : {}),
          tokenVersion: identity.tokenVersion + 1,
        })
        .where(eq(identities.id, identity.id))
        .returning();

      if (input.environmentIds) {
        await tx.delete(identityScopes).where(eq(identityScopes.identityId, identity.id));
        await tx.insert(identityScopes).values(
          Array.from(new Set(input.environmentIds)).map((environmentId) => ({
            identityId: identity.id,
            environmentId,
          })),
        );
      }
      return result[0];
    });

    const scopes = await deps.db
      .select()
      .from(identityScopes)
      .where(eq(identityScopes.identityId, identity.id));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "identity.update",
      resourceType: "identity",
      resourceId: identity.id,
      metadata: {
        name: updated.name,
        role: updated.role,
        tokenTtlSeconds: updated.tokenTtlSeconds,
        ipAllowlist: updated.ipAllowlist,
        hourlyTokenCap: updated.hourlyTokenCap,
      },
      ip: request.ip,
    });

    return {
      identity: identityDto(
        updated,
        scopes.map((scope) => scope.environmentId),
      ),
    };
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
      .set({ revokedAt: new Date(), tokenVersion: identity.tokenVersion + 1 })
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

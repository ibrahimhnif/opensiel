import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DynamicConfigDto, DynamicLeaseDto, DynamicLeaseStatus } from "@opensiel/shared";
import { createDynamicConfigSchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { conflict, notFound, parse } from "../errors.js";
import { dynamicSecretConfigs, dynamicSecretLeases } from "../db/schema.js";
import type { DynamicSecretConfigRow, DynamicSecretLeaseRow } from "../db/schema.js";
import {
  createLease,
  DEFAULT_CREATION_STATEMENT,
  DEFAULT_REVOCATION_STATEMENT,
  encryptAdminUrl,
  revokeLease,
} from "../dynamic.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

function configDto(config: DynamicSecretConfigRow): DynamicConfigDto {
  return {
    id: config.id,
    name: config.name,
    provider: config.provider,
    ttlSeconds: config.ttlSeconds,
    createdAt: config.createdAt.toISOString(),
  };
}

function leaseStatus(lease: DynamicSecretLeaseRow): DynamicLeaseStatus {
  if (lease.revokedAt) return "revoked";
  if (lease.expiresAt.getTime() <= Date.now()) return "expired";
  return "active";
}

function leaseDto(lease: DynamicSecretLeaseRow, configName: string): DynamicLeaseDto {
  return {
    id: lease.id,
    configId: lease.configId,
    configName,
    username: lease.username,
    expiresAt: lease.expiresAt.toISOString(),
    revokedAt: lease.revokedAt?.toISOString() ?? null,
    createdAt: lease.createdAt.toISOString(),
    createdByName: lease.createdByName,
    status: leaseStatus(lease),
  };
}

export function registerDynamicRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/dynamic-secrets", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(dynamicSecretConfigs)
      .where(eq(dynamicSecretConfigs.projectId, project.id))
      .orderBy(dynamicSecretConfigs.createdAt);

    return { configurations: rows.map(configDto) };
  });

  app.post("/api/projects/:projectId/dynamic-secrets", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createDynamicConfigSchema, request.body);

    const id = randomUUID();
    const encrypted = encryptAdminUrl(deps, project, id, input.adminUrl);

    try {
      const inserted = await deps.db
        .insert(dynamicSecretConfigs)
        .values({
          id,
          projectId: project.id,
          name: input.name,
          provider: "postgres",
          adminUrlCiphertext: encrypted.ciphertext,
          adminUrlIv: encrypted.iv,
          adminUrlTag: encrypted.tag,
          creationStatement: input.creationStatement ?? DEFAULT_CREATION_STATEMENT,
          revocationStatement: input.revocationStatement ?? DEFAULT_REVOCATION_STATEMENT,
          ttlSeconds: input.ttlSeconds ?? 3600,
        })
        .returning();

      const config = inserted[0];
      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "dynamic.config.create",
        resourceType: "dynamic_config",
        resourceId: config.id,
        metadata: { name: config.name, provider: config.provider, ttlSeconds: config.ttlSeconds },
        ip: request.ip,
      });

      return reply.code(201).send({ configuration: configDto(config) });
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
        throw conflict("a dynamic secret configuration with that name already exists");
      }
      throw error;
    }
  });

  app.delete("/api/projects/:projectId/dynamic-secrets/:configId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, configId } = request.params as { projectId: string; configId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(dynamicSecretConfigs)
      .where(
        and(eq(dynamicSecretConfigs.id, configId), eq(dynamicSecretConfigs.projectId, project.id)),
      )
      .limit(1);
    const config = rows[0];
    if (!config) throw notFound("dynamic secret configuration not found");

    await deps.db.delete(dynamicSecretConfigs).where(eq(dynamicSecretConfigs.id, config.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "dynamic.config.delete",
      resourceType: "dynamic_config",
      resourceId: config.id,
      metadata: { name: config.name },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/api/projects/:projectId/dynamic-secrets/leases", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select({ lease: dynamicSecretLeases, config: dynamicSecretConfigs })
      .from(dynamicSecretLeases)
      .innerJoin(dynamicSecretConfigs, eq(dynamicSecretConfigs.id, dynamicSecretLeases.configId))
      .where(eq(dynamicSecretLeases.projectId, project.id))
      .orderBy(dynamicSecretLeases.createdAt);

    return {
      leases: rows
        .slice()
        .reverse()
        .map((row) => leaseDto(row.lease, row.config.name)),
    };
  });

  app.post("/api/projects/:projectId/dynamic-secrets/:configId/leases", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, configId } = request.params as { projectId: string; configId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(dynamicSecretConfigs)
      .where(
        and(eq(dynamicSecretConfigs.id, configId), eq(dynamicSecretConfigs.projectId, project.id)),
      )
      .limit(1);
    const config = rows[0];
    if (!config) throw notFound("dynamic secret configuration not found");

    const result = await createLease(deps, project, config, {
      type: actor.type,
      id: actor.id,
      name: actor.name,
    });

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "dynamic.lease.create",
      resourceType: "dynamic_lease",
      resourceId: result.leaseId,
      metadata: { configuration: config.name, username: result.credentials.username },
      ip: request.ip,
    });

    const leaseRows = await deps.db
      .select()
      .from(dynamicSecretLeases)
      .where(eq(dynamicSecretLeases.id, result.leaseId))
      .limit(1);

    return reply.code(201).send({
      lease: leaseDto(leaseRows[0], config.name),
      username: result.credentials.username,
      password: result.credentials.password,
      host: result.credentials.host,
      database: result.credentials.database,
    });
  });

  app.post(
    "/api/projects/:projectId/dynamic-secrets/leases/:leaseId/revoke",
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanAdmin(actor);
      const { projectId, leaseId } = request.params as { projectId: string; leaseId: string };
      const project = await loadProject(deps, actor, projectId);

      const rows = await deps.db
        .select({ lease: dynamicSecretLeases, config: dynamicSecretConfigs })
        .from(dynamicSecretLeases)
        .innerJoin(dynamicSecretConfigs, eq(dynamicSecretConfigs.id, dynamicSecretLeases.configId))
        .where(
          and(
            eq(dynamicSecretLeases.id, leaseId),
            eq(dynamicSecretLeases.projectId, project.id),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw notFound("lease not found");
      if (row.lease.revokedAt) throw conflict("this lease is already revoked");

      await revokeLease(deps, project, row.config, row.lease.id, row.lease.username);

      await writeAudit(deps, {
        orgId: actor.orgId,
        projectId: project.id,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        action: "dynamic.lease.revoke",
        resourceType: "dynamic_lease",
        resourceId: row.lease.id,
        metadata: { configuration: row.config.name, username: row.lease.username },
        ip: request.ip,
      });

      return { ok: true };
    },
  );
}

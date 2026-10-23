import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createSecretSyncSchema,
  syncAwsConfigSchema,
  syncAzureConfigSchema,
  syncCloudflareConfigSchema,
  syncGcpConfigSchema,
  syncGithubConfigSchema,
  syncKubernetesConfigSchema,
  syncVercelConfigSchema,
  syncWebhookConfigSchema,
  updateSecretSyncSchema,
} from "@opensiel/shared";
import type { SecretSyncDto } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import {
  assertCanAdmin,
  assertServerManaged,
  loadEnvironment,
  loadProject,
  normalizePath,
} from "../access.js";
import { notFound, parse } from "../errors.js";
import { environments, secretSyncs } from "../db/schema.js";
import type { SecretSyncRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { encryptSyncConfig, runSecretSync } from "../sync.js";
import { contains, paginate, paginationSchema, sortRows } from "../pagination.js";
import type { Deps } from "../types.js";

function syncDto(sync: SecretSyncRow, environmentSlug: string): SecretSyncDto {
  return {
    id: sync.id,
    environmentSlug,
    path: sync.path,
    provider: sync.provider,
    enabled: sync.enabled,
    intervalSeconds: sync.intervalSeconds,
    nextRunAt: sync.nextRunAt.toISOString(),
    lastRunAt: sync.lastRunAt?.toISOString() ?? null,
    lastStatus: sync.lastStatus,
    lastError: sync.lastError,
    failureCount: sync.failureCount,
    createdAt: sync.createdAt.toISOString(),
  };
}

async function envSlugMap(deps: Deps, projectId: string): Promise<Map<string, string>> {
  const rows = await deps.db
    .select({ id: environments.id, slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  return new Map(rows.map((row) => [row.id, row.slug]));
}

function parseConfig(provider: string, config: Record<string, unknown>) {
  if (provider === "webhook") return parse(syncWebhookConfigSchema, config);
  if (provider === "vercel") return parse(syncVercelConfigSchema, config);
  if (provider === "cloudflare") return parse(syncCloudflareConfigSchema, config);
  if (provider === "github") return parse(syncGithubConfigSchema, config);
  if (provider === "aws") return parse(syncAwsConfigSchema, config);
  if (provider === "gcp") return parse(syncGcpConfigSchema, config);
  if (provider === "azure") return parse(syncAzureConfigSchema, config);
  return parse(syncKubernetesConfigSchema, config);
}

export function registerSyncRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/syncs", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const envs = await envSlugMap(deps, project.id);
    const query = parse(paginationSchema, request.query);

    const rows = await deps.db
      .select()
      .from(secretSyncs)
      .where(eq(secretSyncs.projectId, project.id))
      .orderBy(secretSyncs.createdAt);

    const needle = query.q?.toLowerCase();
    const filtered = needle
      ? rows.filter(
          (sync) =>
            contains(sync.provider, needle) ||
            contains(sync.path, needle) ||
            contains(envs.get(sync.environmentId), needle),
        )
      : rows;
    const sorted = sortRows(filtered, query, {
      provider: (sync) => sync.provider,
      path: (sync) => sync.path,
      environment: (sync) => envs.get(sync.environmentId) ?? "",
      nextRunAt: (sync) => sync.nextRunAt.getTime(),
      lastRunAt: (sync) => sync.lastRunAt?.getTime() ?? null,
      createdAt: (sync) => sync.createdAt.getTime(),
    });
    const page = paginate(sorted, query);

    return {
      syncs: page.items.map((sync) => syncDto(sync, envs.get(sync.environmentId) ?? "unknown")),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.post("/api/projects/:projectId/syncs", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const input = parse(createSecretSyncSchema, request.body);
    const environment = await loadEnvironment(deps, project.id, input.env);
    const path = normalizePath(input.path);
    const config = parseConfig(input.provider, input.config);

    const id = randomUUID();
    const encrypted = encryptSyncConfig(deps, project, id, config);

    const inserted = await deps.db
      .insert(secretSyncs)
      .values({
        id,
        projectId: project.id,
        environmentId: environment.id,
        path,
        provider: input.provider,
        configCiphertext: encrypted.ciphertext,
        configIv: encrypted.iv,
        configTag: encrypted.tag,
        intervalSeconds: input.intervalSeconds,
        enabled: input.enabled ?? true,
        nextRunAt: new Date(),
      })
      .returning();

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "sync.create",
      resourceType: "environment",
      resourceId: environment.id,
      metadata: {
        provider: input.provider,
        environment: environment.slug,
        path,
        intervalSeconds: input.intervalSeconds,
      },
      ip: request.ip,
    });

    return reply.code(201).send({ sync: syncDto(inserted[0], environment.slug) });
  });

  app.patch("/api/projects/:projectId/syncs/:syncId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, syncId } = request.params as {
      projectId: string;
      syncId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(updateSecretSyncSchema, request.body);

    const rows = await deps.db
      .select()
      .from(secretSyncs)
      .where(eq(secretSyncs.id, syncId))
      .limit(1);
    const sync = rows[0];
    if (!sync || sync.projectId !== project.id) throw notFound("sync not found");

    const updated = await deps.db
      .update(secretSyncs)
      .set({
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(secretSyncs.id, sync.id))
      .returning();

    const envs = await envSlugMap(deps, project.id);
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "sync.update",
      resourceType: "environment",
      resourceId: sync.environmentId,
      metadata: {
        provider: sync.provider,
        enabled: updated[0].enabled,
        intervalSeconds: updated[0].intervalSeconds,
      },
      ip: request.ip,
    });

    return {
      sync: syncDto(updated[0], envs.get(updated[0].environmentId) ?? "unknown"),
    };
  });

  app.delete("/api/projects/:projectId/syncs/:syncId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, syncId } = request.params as {
      projectId: string;
      syncId: string;
    };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(secretSyncs)
      .where(eq(secretSyncs.id, syncId))
      .limit(1);
    const sync = rows[0];
    if (!sync || sync.projectId !== project.id) throw notFound("sync not found");

    await deps.db.delete(secretSyncs).where(eq(secretSyncs.id, sync.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "sync.delete",
      resourceType: "environment",
      resourceId: sync.environmentId,
      metadata: { provider: sync.provider, path: sync.path },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post(
    "/api/projects/:projectId/syncs/:syncId/run",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanAdmin(actor);
      const { projectId, syncId } = request.params as {
        projectId: string;
        syncId: string;
      };
      const project = await loadProject(deps, actor, projectId);
      assertServerManaged(project);

      const rows = await deps.db
        .select()
        .from(secretSyncs)
        .where(eq(secretSyncs.id, syncId))
        .limit(1);
      const sync = rows[0];
      if (!sync || sync.projectId !== project.id) throw notFound("sync not found");

      const result = await runSecretSync(deps, sync);
      return { result };
    },
  );
}

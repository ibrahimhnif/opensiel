import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  importSecretsSchema,
  rollbackSchema,
  secretPathSchema,
  secretKeySchema,
  setSecretSchema,
  slugSchema,
} from "@opensiel/shared";
import { requireActor } from "../auth.js";
import {
  assertEnvScope,
  assertServerManaged,
  loadEnvironment,
  loadProject,
  normalizePath,
} from "../access.js";
import { assertSecretPermission } from "../permissions.js";
import { AppError, badRequest, notFound, parse } from "../errors.js";
import { secretVersions, secrets } from "../db/schema.js";
import type { SecretRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { createChangeRequest } from "../approvals-service.js";
import { loadEnvironmentSecrets } from "../secret-read.js";
import { parseImportContents } from "../dotenv.js";
import { dispatchEvent } from "../webhooks.js";
import { applySecretDelete, applySecretRollback, applySecretWrite } from "../secrets-service.js";
import type { Actor, Deps } from "../types.js";

const listQuerySchema = z.object({
  env: slugSchema,
  path: secretPathSchema.optional(),
  recursive: z.enum(["true", "false"]).optional(),
});

const secretQuerySchema = z.object({
  env: slugSchema,
  path: secretPathSchema.optional(),
});

const exportQuerySchema = z.object({
  env: slugSchema,
  format: z.enum(["dotenv", "json"]).optional(),
});

function matchesPath(candidate: string, target: string, recursive: boolean): boolean {
  if (candidate === target) return true;
  if (!recursive) return false;
  const prefix = target === "/" ? "/" : `${target}/`;
  return candidate.startsWith(prefix);
}

async function findSecret(
  deps: Deps,
  projectId: string,
  environmentId: string,
  path: string,
  key: string,
): Promise<SecretRow> {
  const rows = await deps.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.projectId, projectId),
        eq(secrets.environmentId, environmentId),
        eq(secrets.path, path),
        eq(secrets.key, key),
        isNull(secrets.deletedAt),
      ),
    )
    .limit(1);
  const secret = rows[0];
  if (!secret) throw notFound("secret not found");
  return secret;
}

function auditRead(
  deps: Deps,
  actor: Actor,
  projectId: string,
  environment: string,
  path: string,
  count: number,
  ip: string,
) {
  return writeAudit(deps, {
    orgId: actor.orgId,
    projectId,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: "secret.read",
    resourceType: "secret",
    resourceId: `${environment}:${path}`,
    metadata: { environment, path, count },
    ip,
  });
}

export function registerSecretRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/secrets", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const query = parse(listQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const recursive = query.recursive === "true";

    const loaded = await loadEnvironmentSecrets(
      deps,
      project,
      environment,
      actor.type === "machine" ? { allowedEnvironmentIds: actor.envIds } : {},
    );

    const values = loaded
      .filter((secret) => matchesPath(secret.path, path, recursive))
      .sort((a, b) => a.path.localeCompare(b.path) || a.key.localeCompare(b.key))
      .map((secret) => ({
        key: secret.key,
        value: secret.value,
        path: secret.path,
        version: secret.version,
        createdAt: secret.createdAt.toISOString(),
        updatedAt: secret.updatedAt.toISOString(),
        importedFrom: secret.importedFrom,
      }));

    await auditRead(deps, actor, project.id, environment.slug, path, values.length, request.ip);
    return { secrets: values };
  });

  app.get("/api/projects/:projectId/secrets/:key", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const loaded = await loadEnvironmentSecrets(
      deps,
      project,
      environment,
      actor.type === "machine" ? { allowedEnvironmentIds: actor.envIds } : {},
    );
    const secret = loaded.find((candidate) => candidate.path === path && candidate.key === key);
    if (!secret) throw notFound("secret not found");

    await auditRead(deps, actor, project.id, environment.slug, path, 1, request.ip);
    return {
      secret: {
        key: secret.key,
        value: secret.value,
        path: secret.path,
        version: secret.version,
        createdAt: secret.createdAt.toISOString(),
        updatedAt: secret.updatedAt.toISOString(),
        importedFrom: secret.importedFrom,
      },
    };
  });

  app.post("/api/projects/:projectId/secrets", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const input = parse(setSecretSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(input.path);
    const key = parse(secretKeySchema, input.key);
    parse(secretPathSchema, path);

    await assertSecretPermission(deps, actor, "secret:write", {
      projectId: project.id,
      environmentId: environment.id,
      path,
    });

    if (environment.approvalRequired) {
      const changeRequest = await createChangeRequest(
        deps,
        project,
        environment,
        { type: actor.type, id: actor.id, name: actor.name },
        { action: "set", key, path, value: input.value, comment: input.comment ?? null },
        request.ip,
      );
      return reply.code(202).send({ changeRequest });
    }

    const result = await applySecretWrite(
      deps,
      project,
      environment,
      { type: actor.type, id: actor.id, name: actor.name },
      { key, value: input.value, path, comment: input.comment ?? null },
    );

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.write",
      resourceType: "secret",
      resourceId: result.secretId,
      metadata: { environment: environment.slug, path, key, version: result.version },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: result.version === 1 ? "secret.created" : "secret.updated",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: {
        type: "secret",
        key,
        path,
        environment: environment.slug,
        version: result.version,
      },
    }).catch(() => {});

    return reply.code(201).send({
      secret: {
        key,
        path,
        version: result.version,
        updatedAt: new Date().toISOString(),
      },
    });
  });

  app.post("/api/projects/:projectId/secrets/import", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const input = parse(importSecretsSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(input.path);
    await assertSecretPermission(deps, actor, "secret:write", {
      projectId: project.id,
      environmentId: environment.id,
      path,
    });
    const entries = parseImportContents(input.contents, input.format ?? "env");
    for (const entry of entries) {
      if (entry.value.length > 100_000) {
        throw badRequest(`value for ${entry.key} is too large`);
      }
    }

    if (input.dryRun) {
      return {
        dryRun: true,
        keys: entries.map((entry) => entry.key),
        created: 0,
        updated: 0,
        imported: [],
      };
    }

    if (environment.approvalRequired) {
      throw new AppError(
        409,
        "this environment requires approvals; import secrets one at a time so each change can be approved",
        "approval_required",
      );
    }

    const keys = entries.map((entry) => entry.key);
    const existingRows = await deps.db
      .select({ key: secrets.key })
      .from(secrets)
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environment.id),
          eq(secrets.path, path),
          isNull(secrets.deletedAt),
          inArray(secrets.key, keys),
        ),
      );
    const existing = new Set(existingRows.map((row) => row.key));

    const imported: { key: string; version: number }[] = [];
    for (const entry of entries) {
      const result = await applySecretWrite(
        deps,
        project,
        environment,
        { type: actor.type, id: actor.id, name: actor.name },
        {
          key: entry.key,
          value: entry.value,
          path,
          comment: input.comment ?? "bulk import",
        },
      );
      imported.push({ key: entry.key, version: result.version });
    }

    const created = entries.filter((entry) => !existing.has(entry.key)).length;
    const updated = entries.length - created;

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.import",
      resourceType: "secret",
      resourceId: `${environment.slug}:${path}`,
      metadata: {
        environment: environment.slug,
        path,
        count: entries.length,
        created,
        updated,
      },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: "secret.import",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: { type: "secret", path, environment: environment.slug },
      data: { count: entries.length, created, updated, keys },
    }).catch(() => {});

    return reply.code(201).send({
      dryRun: false,
      keys,
      created,
      updated,
      imported,
    });
  });

  app.delete("/api/projects/:projectId/secrets/:key", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    await assertSecretPermission(deps, actor, "secret:delete", {
      projectId: project.id,
      environmentId: environment.id,
      path,
    });
    await findSecret(deps, project.id, environment.id, path, key);

    if (environment.approvalRequired) {
      const changeRequest = await createChangeRequest(
        deps,
        project,
        environment,
        { type: actor.type, id: actor.id, name: actor.name },
        { action: "delete", key, path, comment: null },
        request.ip,
      );
      return reply.code(202).send({ changeRequest });
    }

    const result = await applySecretDelete(deps, project.id, environment.id, path, key);

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.delete",
      resourceType: "secret",
      resourceId: result.secretId,
      metadata: { environment: environment.slug, path, key },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: "secret.deleted",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: { type: "secret", key, path, environment: environment.slug },
    }).catch(() => {});

    return { ok: true };
  });

  app.get("/api/projects/:projectId/secrets/:key/versions", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const secret = await findSecret(deps, project.id, environment.id, path, key);
    const rows = await deps.db
      .select()
      .from(secretVersions)
      .where(eq(secretVersions.secretId, secret.id))
      .orderBy(desc(secretVersions.version));

    return {
      versions: rows.map((row) => ({
        version: row.version,
        comment: row.comment,
        fingerprint: row.fingerprint,
        fingerprintVersion: row.fingerprintVersion,
        createdByType: row.createdByType,
        createdById: row.createdById,
        createdAt: row.createdAt.toISOString(),
        current: row.version === secret.latestVersion,
      })),
    };
  });

  app.post("/api/projects/:projectId/secrets/:key/rollback", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const input = parse(rollbackSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(input.path);
    await assertSecretPermission(deps, actor, "secret:write", {
      projectId: project.id,
      environmentId: environment.id,
      path,
    });
    const secret = await findSecret(deps, project.id, environment.id, path, key);
    const targetRows = await deps.db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, input.version)))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound("secret version not found");

    if (environment.approvalRequired) {
      const changeRequest = await createChangeRequest(
        deps,
        project,
        environment,
        { type: actor.type, id: actor.id, name: actor.name },
        { action: "rollback", key, path, targetVersion: target.version, comment: null },
        request.ip,
      );
      return reply.code(202).send({ changeRequest });
    }

    const result = await applySecretRollback(
      deps,
      project,
      environment,
      { type: actor.type, id: actor.id, name: actor.name },
      { key, path, targetVersion: target.version },
    );

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.rollback",
      resourceType: "secret",
      resourceId: result.secretId,
      metadata: {
        environment: environment.slug,
        path,
        key,
        from: result.from,
        version: result.version,
      },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: "secret.rollback",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: {
        type: "secret",
        key,
        path,
        environment: environment.slug,
        from: result.from,
        version: result.version,
      },
    }).catch(() => {});

    return reply.code(201).send({
      secret: { key, path, version: result.version, updatedAt: new Date().toISOString() },
    });
  });

  app.get("/api/projects/:projectId/export", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const query = parse(exportQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    assertServerManaged(project);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const loaded = await loadEnvironmentSecrets(
      deps,
      project,
      environment,
      actor.type === "machine" ? { allowedEnvironmentIds: actor.envIds } : {},
    );

    const entries = loaded
      .filter((secret) => secret.path === "/")
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((secret) => ({ key: secret.key, value: secret.value }));

    await auditRead(deps, actor, project.id, environment.slug, "/", entries.length, request.ip);

    if (query.format === "json") {
      return reply.send(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])));
    }

    const body = entries.map((entry) => `${entry.key}=${dotenvValue(entry.value)}`).join("\n");
    return reply.type("text/plain; charset=utf-8").send(`${body}\n`);
  });
}

function dotenvValue(value: string): string {
  if (/[\n\r"\\]/.test(value)) {
    return `"${value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")}"`;
  }
  return value;
}

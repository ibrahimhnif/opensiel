import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { rollbackSchema, secretPathSchema, secretKeySchema, setSecretSchema, slugSchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import {
  assertCanWrite,
  assertEnvScope,
  loadEnvironment,
  loadProject,
  normalizePath,
  projectDek,
} from "../access.js";
import { decryptValue, encryptValue, fingerprint, secretAad } from "../crypto.js";
import { notFound, parse } from "../errors.js";
import { secretVersions, secrets } from "../db/schema.js";
import type { ProjectRow, SecretRow, SecretVersionRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
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

function decryptRow(
  deps: Deps,
  project: ProjectRow,
  secret: SecretRow,
  version: SecretVersionRow,
): string {
  const dek = projectDek(deps, project);
  return decryptValue(
    dek,
    { ciphertext: version.ciphertext, iv: version.iv, tag: version.tag },
    secretAad(secret.id, version.version),
  );
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

async function latestVersion(
  deps: Deps,
  secret: SecretRow,
): Promise<SecretVersionRow> {
  const rows = await deps.db
    .select()
    .from(secretVersions)
    .where(
      and(
        eq(secretVersions.secretId, secret.id),
        eq(secretVersions.version, secret.latestVersion),
      ),
    )
    .limit(1);
  const version = rows[0];
  if (!version) throw notFound("secret version not found");
  return version;
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
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const recursive = query.recursive === "true";

    const rows = await deps.db
      .select({ secret: secrets, version: secretVersions })
      .from(secrets)
      .innerJoin(
        secretVersions,
        and(
          eq(secretVersions.secretId, secrets.id),
          eq(secretVersions.version, secrets.latestVersion),
        ),
      )
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environment.id),
          isNull(secrets.deletedAt),
        ),
      )
      .orderBy(secrets.path, secrets.key);

    const filtered = rows.filter((row) => matchesPath(row.secret.path, path, recursive));
    const values = filtered.map((row) => ({
      key: row.secret.key,
      value: decryptRow(deps, project, row.secret, row.version),
      path: row.secret.path,
      version: row.version.version,
      createdAt: row.version.createdAt.toISOString(),
      updatedAt: row.secret.updatedAt.toISOString(),
    }));

    await auditRead(deps, actor, project.id, environment.slug, path, values.length, request.ip);
    return { secrets: values };
  });

  app.get("/api/projects/:projectId/secrets/:key", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const secret = await findSecret(deps, project.id, environment.id, path, key);
    const version = await latestVersion(deps, secret);
    const value = decryptRow(deps, project, secret, version);

    await auditRead(deps, actor, project.id, environment.slug, path, 1, request.ip);
    return {
      secret: {
        key: secret.key,
        value,
        path: secret.path,
        version: version.version,
        createdAt: version.createdAt.toISOString(),
        updatedAt: secret.updatedAt.toISOString(),
      },
    };
  });

  app.post("/api/projects/:projectId/secrets", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanWrite(actor);
    const { projectId } = request.params as { projectId: string };
    const input = parse(setSecretSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(input.path);
    const key = parse(secretKeySchema, input.key);
    parse(secretPathSchema, path);

    const active = await deps.db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environment.id),
          eq(secrets.path, path),
          eq(secrets.key, key),
          isNull(secrets.deletedAt),
        ),
      )
      .limit(1);

    let secret = active[0];
    if (!secret) {
      const deleted = await deps.db
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.projectId, project.id),
            eq(secrets.environmentId, environment.id),
            eq(secrets.path, path),
            eq(secrets.key, key),
            isNotNull(secrets.deletedAt),
          ),
        )
        .orderBy(desc(secrets.deletedAt))
        .limit(1);

      if (deleted[0]) {
        const revived = await deps.db
          .update(secrets)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(secrets.id, deleted[0].id))
          .returning();
        secret = revived[0];
      } else {
        const inserted = await deps.db
          .insert(secrets)
          .values({ projectId: project.id, environmentId: environment.id, path, key })
          .returning();
        secret = inserted[0];
      }
    }

    const version = secret.latestVersion + 1;
    const dek = projectDek(deps, project);
    const encrypted = encryptValue(dek, input.value, secretAad(secret.id, version));

    await deps.db.transaction(async (tx) => {
      await tx.insert(secretVersions).values({
        secretId: secret!.id,
        version,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        fingerprint: fingerprint(input.value),
        comment: input.comment ?? null,
        createdByType: actor.type,
        createdById: actor.id,
      });
      await tx
        .update(secrets)
        .set({ latestVersion: version, updatedAt: new Date() })
        .where(eq(secrets.id, secret!.id));
    });

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.write",
      resourceType: "secret",
      resourceId: secret.id,
      metadata: { environment: environment.slug, path, key, version },
      ip: request.ip,
    });

    return reply.code(201).send({
      secret: {
        key,
        path,
        version,
        updatedAt: new Date().toISOString(),
      },
    });
  });

  app.delete("/api/projects/:projectId/secrets/:key", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanWrite(actor);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const secret = await findSecret(deps, project.id, environment.id, path, key);
    await deps.db.update(secrets).set({ deletedAt: new Date() }).where(eq(secrets.id, secret.id));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.delete",
      resourceType: "secret",
      resourceId: secret.id,
      metadata: { environment: environment.slug, path, key },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/api/projects/:projectId/secrets/:key/versions", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
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
        createdByType: row.createdByType,
        createdById: row.createdById,
        createdAt: row.createdAt.toISOString(),
        current: row.version === secret.latestVersion,
      })),
    };
  });

  app.post("/api/projects/:projectId/secrets/:key/rollback", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanWrite(actor);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const input = parse(rollbackSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(input.path);
    const secret = await findSecret(deps, project.id, environment.id, path, key);
    const targetRows = await deps.db
      .select()
      .from(secretVersions)
      .where(and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, input.version)))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound("secret version not found");

    const value = decryptRow(deps, project, secret, target);
    const nextVersion = secret.latestVersion + 1;
    const dek = projectDek(deps, project);
    const encrypted = encryptValue(dek, value, secretAad(secret.id, nextVersion));

    await deps.db.transaction(async (tx) => {
      await tx.insert(secretVersions).values({
        secretId: secret.id,
        version: nextVersion,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        fingerprint: target.fingerprint,
        comment: `rollback to v${target.version}`,
        createdByType: actor.type,
        createdById: actor.id,
      });
      await tx
        .update(secrets)
        .set({ latestVersion: nextVersion, updatedAt: new Date() })
        .where(eq(secrets.id, secret.id));
    });

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.rollback",
      resourceType: "secret",
      resourceId: secret.id,
      metadata: {
        environment: environment.slug,
        path,
        key,
        from: target.version,
        version: nextVersion,
      },
      ip: request.ip,
    });

    return reply.code(201).send({
      secret: { key, path, version: nextVersion, updatedAt: new Date().toISOString() },
    });
  });

  app.get("/api/projects/:projectId/export", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const query = parse(exportQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const rows = await deps.db
      .select({ secret: secrets, version: secretVersions })
      .from(secrets)
      .innerJoin(
        secretVersions,
        and(
          eq(secretVersions.secretId, secrets.id),
          eq(secretVersions.version, secrets.latestVersion),
        ),
      )
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environment.id),
          isNull(secrets.deletedAt),
        ),
      )
      .orderBy(secrets.path, secrets.key);

    const entries = rows
      .filter((row) => row.secret.path === "/")
      .map((row) => ({
        key: row.secret.key,
        value: decryptRow(deps, project, row.secret, row.version),
      }));

    await auditRead(deps, actor, project.id, environment.slug, "/", entries.length, request.ip);

    if (query.format === "json") {
      return reply.send(Object.fromEntries(entries.map((entry) => [entry.key, entry.value])));
    }

    const body = entries
      .map((entry) => `${entry.key}=${dotenvValue(entry.value)}`)
      .join("\n");
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

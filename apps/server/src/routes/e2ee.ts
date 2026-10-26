import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  e2eeSecretWriteSchema,
  projectKeyUploadSchema,
  setEncryptionModeSchema,
  userKeyUploadSchema,
} from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import {
  assertCanAdmin,
  assertEnvScope,
  loadEnvironment,
  loadProject,
  normalizePath,
} from "../access.js";
import { assertSecretPermission } from "../permissions.js";
import { AppError, badRequest, conflict, parse } from "../errors.js";
import { sha256 } from "../crypto.js";
import {
  orgMembers,
  projectMemberKeys,
  projects,
  secretVersions,
  secrets,
  userKeys,
} from "../db/schema.js";
import type { ProjectRow, SecretRow } from "../db/schema.js";
import { findActiveSecret } from "../secrets-service.js";
import { writeAudit } from "../audit.js";
import { dispatchEvent } from "../webhooks.js";
import type { Deps } from "../types.js";

const ciphertextQuerySchema = z.object({
  env: z.string().trim().min(1).max(48),
  path: z.string().trim().max(200).optional(),
  recursive: z.enum(["true", "false"]).optional(),
});

function assertE2ee(project: ProjectRow): void {
  if (project.encryptionMode !== "e2ee") {
    throw new AppError(409, "this project is not end-to-end encrypted", "not_e2ee_project");
  }
}

function userKeyDto(row: typeof userKeys.$inferSelect) {
  return {
    publicKey: row.publicKey,
    wrappedPrivateKey: row.wrappedPrivateKey,
    privateKeyIv: row.privateKeyIv,
    privateKeyTag: row.privateKeyTag,
    kdfSalt: row.kdfSalt,
    kdfParams: row.kdfParams,
  };
}

async function ensureSecretRow(
  deps: Deps,
  projectId: string,
  environmentId: string,
  path: string,
  key: string,
): Promise<SecretRow> {
  const active = await findActiveSecret(deps, projectId, environmentId, path, key);
  if (active) return active;

  const deleted = await deps.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.projectId, projectId),
        eq(secrets.environmentId, environmentId),
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
    return revived[0];
  }

  const inserted = await deps.db
    .insert(secrets)
    .values({ projectId, environmentId, path, key })
    .returning();
  return inserted[0];
}

async function applyCiphertextWrite(
  deps: Deps,
  project: ProjectRow,
  environmentId: string,
  actor: { type: string; id: string; name: string },
  input: {
    key: string;
    path: string;
    ciphertext: string;
    iv: string;
    tag: string;
    keyVersion?: number;
    comment?: string;
  },
): Promise<{ secretId: string; version: number }> {
  const secret = await ensureSecretRow(deps, project.id, environmentId, input.path, input.key);
  const version = secret.latestVersion + 1;
  const fingerprint = sha256(`${input.ciphertext}:${input.iv}:${input.tag}`);

  await deps.db.transaction(async (tx) => {
    await tx.insert(secretVersions).values({
      secretId: secret.id,
      version,
      ciphertext: input.ciphertext,
      iv: input.iv,
      tag: input.tag,
      fingerprint,
      fingerprintVersion: 2,
      encryptionMode: "e2ee",
      keyVersion: input.keyVersion ?? 1,
      comment: input.comment ?? null,
      createdByType: actor.type,
      createdById: actor.id,
    });
    await tx
      .update(secrets)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(secrets.id, secret.id));
  });

  return { secretId: secret.id, version };
}

export function registerE2eeRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/auth/keys", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const rows = await deps.db
      .select()
      .from(userKeys)
      .where(eq(userKeys.userId, actor.id))
      .limit(1);
    return { key: rows[0] ? userKeyDto(rows[0]) : null };
  });

  app.put("/api/auth/keys", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const input = parse(userKeyUploadSchema, request.body);

    await deps.db
      .insert(userKeys)
      .values({
        userId: actor.id,
        publicKey: input.publicKey,
        wrappedPrivateKey: input.wrappedPrivateKey,
        privateKeyIv: input.privateKeyIv,
        privateKeyTag: input.privateKeyTag,
        kdfSalt: input.kdfSalt,
        kdfParams: input.kdfParams,
      })
      .onConflictDoUpdate({
        target: userKeys.userId,
        set: {
          publicKey: input.publicKey,
          wrappedPrivateKey: input.wrappedPrivateKey,
          privateKeyIv: input.privateKeyIv,
          privateKeyTag: input.privateKeyTag,
          kdfSalt: input.kdfSalt,
          kdfParams: input.kdfParams,
          updatedAt: new Date(),
        },
      });

    await writeAudit(deps, {
      orgId: actor.orgId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "user.keys.upload",
      resourceType: "user",
      resourceId: actor.id,
      metadata: { publicKey: input.publicKey.slice(0, 24) },
      ip: request.ip,
    });

    return { ok: true };
  });

  app.get("/api/projects/:projectId/keys", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);

    const keyRows = await deps.db
      .select()
      .from(projectMemberKeys)
      .where(
        and(eq(projectMemberKeys.projectId, project.id), eq(projectMemberKeys.userId, actor.id)),
      )
      .limit(1);

    const members = await deps.db
      .select({ userId: orgMembers.userId, publicKey: userKeys.publicKey })
      .from(orgMembers)
      .innerJoin(userKeys, eq(userKeys.userId, orgMembers.userId))
      .where(eq(orgMembers.orgId, project.orgId));

    return {
      mode: project.encryptionMode,
      key: keyRows[0]
        ? {
            wrappedKey: keyRows[0].wrappedKey,
            iv: keyRows[0].iv,
            tag: keyRows[0].tag,
            keyVersion: keyRows[0].keyVersion,
          }
        : null,
      members,
    };
  });

  app.put("/api/projects/:projectId/keys", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(projectKeyUploadSchema, request.body);

    const memberRows = await deps.db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, project.orgId));
    const allowed = new Set(memberRows.map((row) => row.userId));
    for (const key of input.keys) {
      if (!allowed.has(key.userId)) {
        throw badRequest("one or more users are not members of this organization");
      }
    }

    for (const key of input.keys) {
      const keyVersion = key.keyVersion ?? 1;
      await deps.db
        .insert(projectMemberKeys)
        .values({
          projectId: project.id,
          userId: key.userId,
          wrappedKey: key.wrappedKey,
          iv: key.iv,
          tag: key.tag,
          keyVersion,
        })
        .onConflictDoUpdate({
          target: [projectMemberKeys.projectId, projectMemberKeys.userId],
          set: {
            wrappedKey: key.wrappedKey,
            iv: key.iv,
            tag: key.tag,
            keyVersion,
          },
        });
    }

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "project.keys.upload",
      resourceType: "project",
      resourceId: project.id,
      metadata: { count: input.keys.length },
      ip: request.ip,
    });

    return { ok: true };
  });

  app.patch("/api/projects/:projectId/encryption", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(setEncryptionModeSchema, request.body);

    if (input.mode === project.encryptionMode) return { mode: input.mode };

    const secretRows = await deps.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(eq(secrets.projectId, project.id))
      .limit(1);
    if (secretRows.length > 0) {
      throw conflict("delete existing secrets before changing the encryption mode");
    }

    await deps.db
      .update(projects)
      .set({ encryptionMode: input.mode })
      .where(eq(projects.id, project.id));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "project.encryption_mode",
      resourceType: "project",
      resourceId: project.id,
      metadata: { mode: input.mode },
      ip: request.ip,
    });

    return { mode: input.mode };
  });

  app.post("/api/projects/:projectId/secrets/ciphertext", async (request, reply) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    assertE2ee(project);
    const input = parse(e2eeSecretWriteSchema, request.body);
    const environment = await loadEnvironment(deps, project.id, input.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);
    const path = normalizePath(input.path);

    await assertSecretPermission(deps, actor, "secret:write", {
      projectId: project.id,
      environmentId: environment.id,
      path,
    });

    if (environment.approvalRequired) {
      throw new AppError(
        409,
        "approvals are not supported for end-to-end encrypted projects",
        "feature_unavailable_in_e2ee",
      );
    }

    const result = await applyCiphertextWrite(deps, project, environment.id, actor, {
      key: input.key,
      path,
      ciphertext: input.ciphertext,
      iv: input.iv,
      tag: input.tag,
      keyVersion: input.keyVersion,
      comment: input.comment,
    });

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.write",
      resourceType: "secret",
      resourceId: result.secretId,
      metadata: {
        environment: environment.slug,
        path,
        key: input.key,
        version: result.version,
        e2ee: true,
        keyVersion: input.keyVersion ?? 1,
      },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: result.version === 1 ? "secret.created" : "secret.updated",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: {
        type: "secret",
        key: input.key,
        path,
        environment: environment.slug,
        version: result.version,
        e2ee: true,
      },
    }).catch(() => {});

    return reply.code(201).send({
      secret: { key: input.key, path, version: result.version },
    });
  });

  app.get("/api/projects/:projectId/secrets/ciphertext", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    assertE2ee(project);
    const query = parse(ciphertextQuerySchema, request.query);
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
      );

    const matches = (candidate: string) => {
      if (candidate === path) return true;
      if (!recursive) return false;
      const prefix = path === "/" ? "/" : `${path}/`;
      return candidate.startsWith(prefix);
    };

    const values = rows
      .filter((row) => matches(row.secret.path))
      .sort(
        (a, b) =>
          a.secret.path.localeCompare(b.secret.path) || a.secret.key.localeCompare(b.secret.key),
      )
      .map((row) => ({
        key: row.secret.key,
        path: row.secret.path,
        version: row.version.version,
        ciphertext: row.version.ciphertext,
        iv: row.version.iv,
        tag: row.version.tag,
        keyVersion: row.version.keyVersion,
        createdAt: row.version.createdAt.toISOString(),
        updatedAt: row.secret.updatedAt.toISOString(),
      }));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.read",
      resourceType: "secret",
      resourceId: `${environment.slug}:${path}`,
      metadata: { environment: environment.slug, path, count: values.length, e2ee: true },
      ip: request.ip,
    });

    return { mode: "e2ee", secrets: values };
  });
}

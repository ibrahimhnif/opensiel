import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  decryptValue,
  encryptValue,
  FINGERPRINT_VERSION,
  secretAad,
  valueFingerprint,
} from "./crypto.js";
import { projectDek } from "./access.js";
import { notFound } from "./errors.js";
import { secretVersions, secrets } from "./db/schema.js";
import type { EnvironmentRow, ProjectRow, SecretRow, SecretVersionRow } from "./db/schema.js";
import type { Deps } from "./types.js";

export interface ActorMeta {
  type: "user" | "machine" | "system";
  id: string;
  name: string;
}

export interface SecretWriteInput {
  key: string;
  value: string;
  path: string;
  comment?: string | null;
}

interface WriteResult {
  secretId: string;
  version: number;
}

export async function findActiveSecret(
  deps: Deps,
  projectId: string,
  environmentId: string,
  path: string,
  key: string,
): Promise<SecretRow | null> {
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
  return rows[0] ?? null;
}

export async function applySecretWrite(
  deps: Deps,
  project: ProjectRow,
  environment: EnvironmentRow,
  actor: ActorMeta,
  input: SecretWriteInput,
): Promise<WriteResult> {
  let secret = await findActiveSecret(deps, project.id, environment.id, input.path, input.key);

  if (!secret) {
    const deleted = await deps.db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environment.id),
          eq(secrets.path, input.path),
          eq(secrets.key, input.key),
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
        .values({
          projectId: project.id,
          environmentId: environment.id,
          path: input.path,
          key: input.key,
        })
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
      fingerprint: valueFingerprint(dek, input.value),
      fingerprintVersion: FINGERPRINT_VERSION,
      comment: input.comment ?? null,
      createdByType: actor.type,
      createdById: actor.id,
    });
    await tx
      .update(secrets)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(secrets.id, secret!.id));
  });

  return { secretId: secret.id, version };
}

export async function applySecretDelete(
  deps: Deps,
  projectId: string,
  environmentId: string,
  path: string,
  key: string,
): Promise<{ secretId: string }> {
  const secret = await findActiveSecret(deps, projectId, environmentId, path, key);
  if (!secret) throw notFound("secret not found");
  await deps.db.update(secrets).set({ deletedAt: new Date() }).where(eq(secrets.id, secret.id));
  return { secretId: secret.id };
}

export async function applySecretRollback(
  deps: Deps,
  project: ProjectRow,
  environment: EnvironmentRow,
  actor: ActorMeta,
  input: { key: string; path: string; targetVersion: number; note?: string },
): Promise<{ secretId: string; version: number; from: number }> {
  const secret = await findActiveSecret(deps, project.id, environment.id, input.path, input.key);
  if (!secret) throw notFound("secret not found");

  const targetRows = await deps.db
    .select()
    .from(secretVersions)
    .where(
      and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, input.targetVersion)),
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) throw notFound("secret version not found");

  const dek = projectDek(deps, project);
  const value = decryptValue(
    dek,
    { ciphertext: target.ciphertext, iv: target.iv, tag: target.tag },
    secretAad(secret.id, target.version),
  );

  const version = secret.latestVersion + 1;
  const encrypted = encryptValue(dek, value, secretAad(secret.id, version));

  await deps.db.transaction(async (tx) => {
    await tx.insert(secretVersions).values({
      secretId: secret.id,
      version,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      fingerprint: valueFingerprint(dek, value),
      fingerprintVersion: FINGERPRINT_VERSION,
      comment: input.note ?? `rollback to v${target.version}`,
      createdByType: actor.type,
      createdById: actor.id,
    });
    await tx
      .update(secrets)
      .set({ latestVersion: version, updatedAt: new Date() })
      .where(eq(secrets.id, secret.id));
  });

  return { secretId: secret.id, version, from: target.version };
}

export async function latestVersionRow(deps: Deps, secret: SecretRow): Promise<SecretVersionRow> {
  const rows = await deps.db
    .select()
    .from(secretVersions)
    .where(
      and(eq(secretVersions.secretId, secret.id), eq(secretVersions.version, secret.latestVersion)),
    )
    .limit(1);
  const version = rows[0];
  if (!version) throw notFound("secret version not found");
  return version;
}

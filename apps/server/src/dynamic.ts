import { and, eq, isNull, lte } from "drizzle-orm";
import postgres from "postgres";
import { decryptValue, encryptValue, randomToken } from "./crypto.js";
import { projectDek } from "./access.js";
import { AppError } from "./errors.js";
import { dynamicSecretConfigs, dynamicSecretLeases, projects } from "./db/schema.js";
import type { DynamicSecretConfigRow, ProjectRow } from "./db/schema.js";
import type { ActorMeta } from "./secrets-service.js";
import type { Deps } from "./types.js";

export const DEFAULT_CREATION_STATEMENT =
  "CREATE ROLE \"{{username}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expires}}'";
export const DEFAULT_REVOCATION_STATEMENT = 'DROP ROLE IF EXISTS "{{username}}"';

function configAad(id: string): string {
  return `dynamic:${id}`;
}

export function encryptAdminUrl(
  deps: Deps,
  project: ProjectRow,
  configId: string,
  adminUrl: string,
) {
  return encryptValue(projectDek(deps, project), adminUrl, configAad(configId));
}

export function decryptAdminUrl(
  deps: Deps,
  project: ProjectRow,
  config: DynamicSecretConfigRow,
): string {
  return decryptValue(
    projectDek(deps, project),
    {
      ciphertext: config.adminUrlCiphertext,
      iv: config.adminUrlIv,
      tag: config.adminUrlTag,
    },
    configAad(config.id),
  );
}

function render(statement: string, variables: Record<string, string>): string {
  return statement.replace(/\{\{(\w+)\}\}/g, (match, key: string) => variables[key] ?? match);
}

async function runStatements(adminUrl: string, statement: string): Promise<void> {
  const statements = statement
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const sql = postgres(adminUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    for (const part of statements) {
      await sql.unsafe(part);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function parseAdminUrl(adminUrl: string): {
  host: string;
  port: string;
  database: string;
} {
  const parsed = new URL(adminUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, "") || "postgres",
  };
}

export interface LeaseCredentials {
  username: string;
  password: string;
  host: string;
  database: string;
}

export async function createLease(
  deps: Deps,
  project: ProjectRow,
  config: DynamicSecretConfigRow,
  actor: ActorMeta,
): Promise<{ leaseId: string; expiresAt: Date; credentials: LeaseCredentials }> {
  const adminUrl = decryptAdminUrl(deps, project, config);
  const username = `opensiel_${randomToken(9).replace(/[-_]/g, "").slice(0, 12).toLowerCase()}`;
  const password = randomToken(24);
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);

  try {
    await runStatements(
      adminUrl,
      render(config.creationStatement, {
        username,
        password,
        expires: expiresAt.toISOString(),
      }),
    );
  } catch {
    throw new AppError(
      502,
      "the target database rejected the credential creation statement",
      "dynamic_provisioning_failed",
    );
  }

  const inserted = await deps.db
    .insert(dynamicSecretLeases)
    .values({
      configId: config.id,
      projectId: project.id,
      username,
      expiresAt,
      createdByType: actor.type,
      createdById: actor.id,
      createdByName: actor.name,
    })
    .returning();

  const info = parseAdminUrl(adminUrl);
  return {
    leaseId: inserted[0].id,
    expiresAt,
    credentials: { username, password, host: info.host, database: info.database },
  };
}

export async function revokeLease(
  deps: Deps,
  project: ProjectRow,
  config: DynamicSecretConfigRow,
  leaseId: string,
  username: string,
): Promise<void> {
  const adminUrl = decryptAdminUrl(deps, project, config);
  try {
    await runStatements(adminUrl, render(config.revocationStatement, { username }));
  } catch {
    throw new AppError(
      502,
      "the target database rejected the revocation statement",
      "dynamic_revocation_failed",
    );
  }

  await deps.db
    .update(dynamicSecretLeases)
    .set({ revokedAt: new Date() })
    .where(eq(dynamicSecretLeases.id, leaseId));
}

export async function revokeExpiredLeases(deps: Deps): Promise<number> {
  const rows = await deps.db
    .select({
      lease: dynamicSecretLeases,
      config: dynamicSecretConfigs,
      project: projects,
    })
    .from(dynamicSecretLeases)
    .innerJoin(dynamicSecretConfigs, eq(dynamicSecretConfigs.id, dynamicSecretLeases.configId))
    .innerJoin(projects, eq(projects.id, dynamicSecretLeases.projectId))
    .where(
      and(isNull(dynamicSecretLeases.revokedAt), lte(dynamicSecretLeases.expiresAt, new Date())),
    )
    .limit(50);

  let revoked = 0;
  for (const row of rows) {
    try {
      await revokeLease(deps, row.project, row.config, row.lease.id, row.lease.username);
      revoked += 1;
    } catch (error) {
      console.error(
        `failed to revoke expired dynamic lease ${row.lease.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return revoked;
}

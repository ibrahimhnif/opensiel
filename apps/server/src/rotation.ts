import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import postgres from "postgres";
import type { RotationHttpConfig, RotationPostgresConfig } from "@opensiel/shared";
import { projectDek } from "./access.js";
import { decryptValue, encryptValue, randomToken } from "./crypto.js";
import type { EncryptedValue } from "./crypto.js";
import { environments, projects, rotationPolicies } from "./db/schema.js";
import type { ProjectRow, RotationPolicyRow } from "./db/schema.js";
import { applySecretWrite } from "./secrets-service.js";
import { writeAudit } from "./audit.js";
import type { Deps } from "./types.js";

export type RotationConfig =
  RotationHttpConfig | (Omit<RotationPostgresConfig, "valueTemplate"> & { valueTemplate?: string });

interface Credential {
  username?: string;
  password?: string;
  credentialId?: string;
}

export interface RotationRunResult {
  status: "success" | "error";
  error?: string;
}

function configAad(id: string): string {
  return `rotation:${id}:config`;
}

function credentialAad(id: string, slot: "current" | "previous"): string {
  return `rotation:${id}:${slot}`;
}

export function encryptRotationConfig(
  deps: Deps,
  project: ProjectRow,
  id: string,
  config: RotationConfig,
): EncryptedValue {
  return encryptValue(projectDek(deps, project), JSON.stringify(config), configAad(id));
}

function decryptRotationConfig(
  deps: Deps,
  project: ProjectRow,
  policy: RotationPolicyRow,
): RotationConfig {
  return JSON.parse(
    decryptValue(
      projectDek(deps, project),
      {
        ciphertext: policy.configCiphertext,
        iv: policy.configIv,
        tag: policy.configTag,
      },
      configAad(policy.id),
    ),
  ) as RotationConfig;
}

function encryptCredential(
  deps: Deps,
  project: ProjectRow,
  policyId: string,
  slot: "current" | "previous",
  credential: Credential,
): EncryptedValue {
  return encryptValue(
    projectDek(deps, project),
    JSON.stringify(credential),
    credentialAad(policyId, slot),
  );
}

function decryptCredential(
  deps: Deps,
  project: ProjectRow,
  policy: RotationPolicyRow,
  slot: "current" | "previous",
): Credential | undefined {
  const value =
    slot === "current"
      ? policy.currentCiphertext && policy.currentIv && policy.currentTag
        ? { ciphertext: policy.currentCiphertext, iv: policy.currentIv, tag: policy.currentTag }
        : undefined
      : policy.previousCiphertext && policy.previousIv && policy.previousTag
        ? { ciphertext: policy.previousCiphertext, iv: policy.previousIv, tag: policy.previousTag }
        : undefined;
  if (!value) return undefined;
  return JSON.parse(
    decryptValue(projectDek(deps, project), value, credentialAad(policy.id, slot)),
  ) as Credential;
}

function renderTemplate(template: string, credential: Credential): string {
  return template
    .split("{{username}}")
    .join(credential.username ?? "")
    .split("{{password}}")
    .join(credential.password ?? "");
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function withAdmin<T>(
  config: RotationPostgresConfig,
  fn: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
  const sql = postgres(config.adminUrl, {
    max: 1,
    onnotice: () => {},
    ssl: config.ssl ? "require" : undefined,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface RotationContext {
  projectId: string;
  environment: string;
  path: string;
  key: string;
}

async function createCredential(
  provider: string,
  config: RotationConfig,
  context: RotationContext,
  current?: Credential,
): Promise<{ value: string; credential: Credential }> {
  if (provider === "postgres") {
    const pg = config as RotationPostgresConfig;
    const username = current?.username === pg.username ? pg.alternateUsername : pg.username;
    const password = randomToken(24);
    await withAdmin(pg, (sql) =>
      sql.unsafe(
        `alter role ${quoteIdent(username)} with login password ${quoteLiteral(password)}`,
      ),
    );
    const credential = { username, password };
    return {
      value: renderTemplate(pg.valueTemplate ?? "{{username}}:{{password}}", credential),
      credential,
    };
  }

  const http = config as RotationHttpConfig;
  const response = await fetch(http.createUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(http.headers ?? {}) },
    body: JSON.stringify(context),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`rotator responded ${response.status}`);

  const data = (await response.json()) as Record<string, unknown>;
  const credential: Credential = {
    ...(typeof data.username === "string" ? { username: data.username } : {}),
    ...(typeof data.password === "string" ? { password: data.password } : {}),
    ...(typeof data.credentialId === "string" ? { credentialId: data.credentialId } : {}),
  };

  let value = typeof data.value === "string" ? data.value : undefined;
  if (!value) {
    if (!credential.username || !credential.password) {
      throw new Error("rotator must return value or username and password");
    }
    value = renderTemplate(http.valueTemplate ?? "{{username}}:{{password}}", credential);
  }
  return { value, credential };
}

async function revokeCredential(
  provider: string,
  config: RotationConfig,
  credential: Credential,
): Promise<void> {
  if (provider === "postgres") {
    const pg = config as RotationPostgresConfig;
    if (!credential.username) return;
    const password = randomToken(24);
    await withAdmin(pg, (sql) =>
      sql.unsafe(
        `alter role ${quoteIdent(credential.username!)} with password ${quoteLiteral(password)}`,
      ),
    );
    return;
  }

  const http = config as RotationHttpConfig;
  if (!http.revokeUrl) return;
  const response = await fetch(http.revokeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(http.headers ?? {}) },
    body: JSON.stringify(credential),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`rotator revoke responded ${response.status}`);
}

export async function runRotation(
  deps: Deps,
  policy: RotationPolicyRow,
): Promise<RotationRunResult> {
  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.id, policy.projectId))
    .limit(1);
  const project = projectRows[0];
  const environmentRows = project
    ? await deps.db
        .select()
        .from(environments)
        .where(
          and(eq(environments.id, policy.environmentId), eq(environments.projectId, project.id)),
        )
        .limit(1)
    : [];
  const environment = environmentRows[0];

  if (!project || !environment) {
    return { status: "error", error: "project or environment no longer exists" };
  }

  const config = decryptRotationConfig(deps, project, policy);
  const current = decryptCredential(deps, project, policy, "current");
  let previous = decryptCredential(deps, project, policy, "previous");

  try {
    if (previous) {
      await revokeCredential(policy.provider, config, previous);
      previous = undefined;
    }

    const created = await createCredential(
      policy.provider,
      config,
      {
        projectId: project.id,
        environment: environment.slug,
        path: policy.path,
        key: policy.secretKey,
      },
      current,
    );

    const written = await applySecretWrite(
      deps,
      project,
      environment,
      { type: "system", id: policy.id, name: "rotation" },
      {
        key: policy.secretKey,
        value: created.value,
        path: policy.path,
        comment: "rotated by policy",
      },
    );

    const encryptedCurrent = encryptCredential(
      deps,
      project,
      policy.id,
      "current",
      created.credential,
    );
    const encryptedPrevious = current
      ? encryptCredential(deps, project, policy.id, "previous", current)
      : undefined;

    await deps.db
      .update(rotationPolicies)
      .set({
        currentCiphertext: encryptedCurrent.ciphertext,
        currentIv: encryptedCurrent.iv,
        currentTag: encryptedCurrent.tag,
        previousCiphertext: encryptedPrevious?.ciphertext ?? null,
        previousIv: encryptedPrevious?.iv ?? null,
        previousTag: encryptedPrevious?.tag ?? null,
        previousRevokeAfter: encryptedPrevious
          ? new Date(Date.now() + policy.graceSeconds * 1000)
          : null,
        lastRunAt: new Date(),
        lastStatus: "success",
        lastError: null,
        failureCount: 0,
        nextRunAt: new Date(Date.now() + policy.intervalSeconds * 1000),
        updatedAt: new Date(),
      })
      .where(eq(rotationPolicies.id, policy.id));

    await writeAudit(deps, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: "system",
      actorId: policy.id,
      actorName: "rotation",
      action: "rotation.run",
      resourceType: "secret",
      resourceId: written.secretId,
      metadata: {
        key: policy.secretKey,
        path: policy.path,
        environment: environment.slug,
        provider: policy.provider,
        version: written.version,
      },
      ip: null,
    });

    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "rotation failed";
    const failures = policy.failureCount + 1;
    const backoff = Math.min(60_000 * 2 ** Math.min(failures, 6), 3_600_000);

    await deps.db
      .update(rotationPolicies)
      .set({
        lastRunAt: new Date(),
        lastStatus: "error",
        lastError: message.slice(0, 500),
        failureCount: failures,
        nextRunAt: new Date(Date.now() + backoff),
        updatedAt: new Date(),
      })
      .where(eq(rotationPolicies.id, policy.id));

    await writeAudit(deps, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: "system",
      actorId: policy.id,
      actorName: "rotation",
      action: "rotation.fail",
      resourceType: "secret",
      resourceId: policy.id,
      metadata: {
        key: policy.secretKey,
        provider: policy.provider,
        error: message.slice(0, 200),
      },
      ip: null,
    });

    return { status: "error", error: message };
  }
}

export async function revokeExpiredRotationCredentials(deps: Deps): Promise<number> {
  const due = await deps.db
    .select()
    .from(rotationPolicies)
    .where(
      and(
        eq(rotationPolicies.enabled, true),
        isNotNull(rotationPolicies.previousRevokeAfter),
        lte(rotationPolicies.previousRevokeAfter, new Date()),
      ),
    )
    .limit(20);

  let revoked = 0;
  for (const policy of due) {
    const projectRows = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, policy.projectId))
      .limit(1);
    const project = projectRows[0];
    if (!project) continue;

    const config = decryptRotationConfig(deps, project, policy);
    const credential = decryptCredential(deps, project, policy, "previous");
    try {
      if (credential) await revokeCredential(policy.provider, config, credential);
    } catch {
      continue;
    }

    await deps.db
      .update(rotationPolicies)
      .set({
        previousCiphertext: null,
        previousIv: null,
        previousTag: null,
        previousRevokeAfter: null,
        updatedAt: new Date(),
      })
      .where(eq(rotationPolicies.id, policy.id));
    revoked += 1;
  }
  return revoked;
}

export async function runRotationTick(deps: Deps): Promise<{ rotated: number; revoked: number }> {
  return deps.sql.begin(async (tx) => {
    const lock = await tx<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext('opensiel-rotation')) as locked
    `;
    if (!lock[0]?.locked) return { rotated: 0, revoked: 0 };

    const revoked = await revokeExpiredRotationCredentials(deps);
    const due = await deps.db
      .select()
      .from(rotationPolicies)
      .where(and(eq(rotationPolicies.enabled, true), lte(rotationPolicies.nextRunAt, new Date())))
      .orderBy(asc(rotationPolicies.nextRunAt))
      .limit(10);

    let rotated = 0;
    for (const policy of due) {
      const result = await runRotation(deps, policy);
      if (result.status === "success") rotated += 1;
    }
    return { rotated, revoked };
  });
}

export function startRotationScheduler(deps: Deps): NodeJS.Timeout | undefined {
  if (deps.env.nodeEnv === "test") return undefined;

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runRotationTick(deps)
      .then((result) => {
        if (result.rotated > 0) console.log(`rotated ${result.rotated} secret(s)`);
        if (result.revoked > 0) console.log(`revoked ${result.revoked} old credential(s)`);
      })
      .catch((error: unknown) => {
        console.error("rotation scheduler failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
  return timer;
}

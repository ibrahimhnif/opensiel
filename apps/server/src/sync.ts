import { and, asc, eq, lte } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import type {
  SyncCloudflareConfig,
  SyncGithubConfig,
  SyncVercelConfig,
  SyncWebhookConfig,
} from "@opensiel/shared";
import { projectDek } from "./access.js";
import { decryptValue, encryptValue } from "./crypto.js";
import type { EncryptedValue } from "./crypto.js";
import { environments, projects, secretSyncs } from "./db/schema.js";
import type { ProjectRow, SecretSyncRow } from "./db/schema.js";
import { loadEnvironmentSecrets } from "./secret-read.js";
import { writeAudit } from "./audit.js";
import type { Deps } from "./types.js";

type SyncConfig =
  | SyncWebhookConfig
  | (Omit<SyncVercelConfig, "target"> & { target?: SyncVercelConfig["target"] })
  | SyncCloudflareConfig
  | SyncGithubConfig;

interface SyncPayload {
  projectId: string;
  environment: string;
  path: string;
  secrets: Record<string, string>;
}

export interface SyncRunResult {
  status: "success" | "error";
  count?: number;
  error?: string;
}

function configAad(id: string): string {
  return `sync:${id}:config`;
}

export function encryptSyncConfig(
  deps: Deps,
  project: ProjectRow,
  id: string,
  config: SyncConfig,
): EncryptedValue {
  return encryptValue(projectDek(deps, project), JSON.stringify(config), configAad(id));
}

function decryptSyncConfig(deps: Deps, project: ProjectRow, sync: SecretSyncRow): SyncConfig {
  return JSON.parse(
    decryptValue(
      projectDek(deps, project),
      { ciphertext: sync.configCiphertext, iv: sync.configIv, tag: sync.configTag },
      configAad(sync.id),
    ),
  ) as SyncConfig;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`provider responded ${response.status}`);
  return response;
}

async function sendWebhook(config: SyncWebhookConfig, payload: SyncPayload): Promise<void> {
  await postJson(config.url, payload, config.headers ?? {});
}

async function sendVercel(config: SyncVercelConfig, payload: SyncPayload): Promise<void> {
  const query = new URLSearchParams({ upsert: "true" });
  if (config.teamId) query.set("teamId", config.teamId);
  const url = `https://api.vercel.com/v10/projects/${encodeURIComponent(
    config.vercelProjectId,
  )}/env?${query}`;
  const target = config.target ?? ["production"];

  for (const [key, value] of Object.entries(payload.secrets)) {
    await postJson(
      url,
      { key, value, type: "encrypted", target },
      { authorization: `Bearer ${config.token}` },
    );
  }
}

async function sendCloudflare(config: SyncCloudflareConfig, payload: SyncPayload): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    config.accountId,
  )}/workers/scripts/${encodeURIComponent(config.scriptName)}/secrets`;

  for (const [name, text] of Object.entries(payload.secrets)) {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ name, text, type: "secret_text" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`cloudflare responded ${response.status}`);
  }
}

async function sendGithub(config: SyncGithubConfig, payload: SyncPayload): Promise<void> {
  await sodium.ready;
  const base = `https://api.github.com/repos/${encodeURIComponent(
    config.owner,
  )}/${encodeURIComponent(config.repo)}`;
  const scope = config.environment
    ? `${base}/environments/${encodeURIComponent(config.environment)}`
    : base;
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };

  const keyResponse = await fetch(`${scope}/secrets/public-key`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!keyResponse.ok) throw new Error(`github responded ${keyResponse.status}`);
  const publicKey = (await keyResponse.json()) as { key: string; key_id: string };
  const keyBytes = Buffer.from(publicKey.key, "base64");

  for (const [name, value] of Object.entries(payload.secrets)) {
    const sealed = sodium.crypto_box_seal(Buffer.from(value, "utf8"), keyBytes);
    const response = await fetch(`${scope}/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        encrypted_value: Buffer.from(sealed).toString("base64"),
        key_id: publicKey.key_id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`github responded ${response.status}`);
  }
}

async function send(provider: string, config: SyncConfig, payload: SyncPayload): Promise<void> {
  if (provider === "webhook") return sendWebhook(config as SyncWebhookConfig, payload);
  if (provider === "vercel") return sendVercel(config as SyncVercelConfig, payload);
  if (provider === "cloudflare") return sendCloudflare(config as SyncCloudflareConfig, payload);
  if (provider === "github") return sendGithub(config as SyncGithubConfig, payload);
  throw new Error(`unsupported provider ${provider}`);
}

export async function runSecretSync(deps: Deps, sync: SecretSyncRow): Promise<SyncRunResult> {
  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.id, sync.projectId))
    .limit(1);
  const project = projectRows[0];
  const environmentRows = project
    ? await deps.db
        .select()
        .from(environments)
        .where(and(eq(environments.id, sync.environmentId), eq(environments.projectId, project.id)))
        .limit(1)
    : [];
  const environment = environmentRows[0];

  if (!project || !environment) {
    return { status: "error", error: "project or environment no longer exists" };
  }

  const config = decryptSyncConfig(deps, project, sync);

  try {
    const loaded = await loadEnvironmentSecrets(deps, project, environment);
    const secrets = Object.fromEntries(
      loaded
        .filter((secret) => secret.path === sync.path)
        .map((secret) => [secret.key, secret.value]),
    );

    await send(sync.provider, config, {
      projectId: project.id,
      environment: environment.slug,
      path: sync.path,
      secrets,
    });

    const count = Object.keys(secrets).length;
    await deps.db
      .update(secretSyncs)
      .set({
        lastRunAt: new Date(),
        lastStatus: "success",
        lastError: null,
        failureCount: 0,
        nextRunAt: new Date(Date.now() + sync.intervalSeconds * 1000),
        updatedAt: new Date(),
      })
      .where(eq(secretSyncs.id, sync.id));

    await writeAudit(deps, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: "system",
      actorId: sync.id,
      actorName: "sync",
      action: "sync.run",
      resourceType: "environment",
      resourceId: environment.id,
      metadata: {
        provider: sync.provider,
        environment: environment.slug,
        path: sync.path,
        count,
      },
      ip: null,
    });

    return { status: "success", count };
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync failed";
    const failures = sync.failureCount + 1;
    const backoff = Math.min(60_000 * 2 ** Math.min(failures, 6), 3_600_000);

    await deps.db
      .update(secretSyncs)
      .set({
        lastRunAt: new Date(),
        lastStatus: "error",
        lastError: message.slice(0, 500),
        failureCount: failures,
        nextRunAt: new Date(Date.now() + backoff),
        updatedAt: new Date(),
      })
      .where(eq(secretSyncs.id, sync.id));

    await writeAudit(deps, {
      orgId: project.orgId,
      projectId: project.id,
      actorType: "system",
      actorId: sync.id,
      actorName: "sync",
      action: "sync.fail",
      resourceType: "environment",
      resourceId: environment.id,
      metadata: {
        provider: sync.provider,
        environment: environment.slug,
        path: sync.path,
        error: message.slice(0, 200),
      },
      ip: null,
    });

    return { status: "error", error: message };
  }
}

export async function runSyncTick(deps: Deps): Promise<{ synced: number }> {
  return deps.sql.begin(async (tx) => {
    const lock = await tx<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext('opensiel-sync')) as locked
    `;
    if (!lock[0]?.locked) return { synced: 0 };

    const due = await deps.db
      .select()
      .from(secretSyncs)
      .where(and(eq(secretSyncs.enabled, true), lte(secretSyncs.nextRunAt, new Date())))
      .orderBy(asc(secretSyncs.nextRunAt))
      .limit(10);

    let synced = 0;
    for (const sync of due) {
      const result = await runSecretSync(deps, sync);
      if (result.status === "success") synced += 1;
    }
    return { synced };
  });
}

export function startSyncScheduler(deps: Deps): NodeJS.Timeout | undefined {
  if (deps.env.nodeEnv === "test") return undefined;

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runSyncTick(deps)
      .then((result) => {
        if (result.synced > 0) console.log(`synced ${result.synced} environment(s)`);
      })
      .catch((error: unknown) => {
        console.error("sync scheduler failed:", error instanceof Error ? error.message : error);
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

import { and, asc, eq, lte } from "drizzle-orm";
import sodium from "libsodium-wrappers";
import {
  CreateSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { Agent } from "undici";
import type {
  SyncAwsConfig,
  SyncAzureConfig,
  SyncCloudflareConfig,
  SyncGcpConfig,
  SyncGithubConfig,
  SyncKubernetesConfig,
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
  | SyncGithubConfig
  | SyncAwsConfig
  | SyncGcpConfig
  | SyncAzureConfig
  | SyncKubernetesConfig;

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

export function providerSecretName(key: string): string {
  return key.replace(/_/g, "-");
}

async function sendAws(config: SyncAwsConfig, payload: SyncPayload): Promise<void> {
  const client = new SecretsManagerClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
        : undefined,
  });

  for (const [key, value] of Object.entries(payload.secrets)) {
    const name = `${config.prefix ?? ""}${providerSecretName(key)}`;
    try {
      await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error;
      await client.send(new CreateSecretCommand({ Name: name, SecretString: value }));
    }
  }
  client.destroy();
}

async function sendGcp(config: SyncGcpConfig, payload: SyncPayload): Promise<void> {
  const options: ConstructorParameters<typeof SecretManagerServiceClient>[0] = {};
  if (config.credentialsJson) {
    (options as { credentials?: unknown }).credentials = JSON.parse(config.credentialsJson);
  }
  const client = new SecretManagerServiceClient(options);
  const parent = `projects/${config.projectId}`;

  for (const [key, value] of Object.entries(payload.secrets)) {
    const secretId = `${config.prefix ?? ""}${providerSecretName(key)}`;
    const name = `${parent}/secrets/${secretId}`;
    try {
      await client.createSecret({
        parent,
        secretId,
        secret: { replication: { automatic: {} } },
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error;
    }
    await client.addSecretVersion({
      parent: name,
      payload: { data: Buffer.from(value, "utf8") },
    });
  }
  await client.close();
}

async function sendAzure(config: SyncAzureConfig, payload: SyncPayload): Promise<void> {
  const credential = new ClientSecretCredential(
    config.tenantId,
    config.clientId,
    config.clientSecret,
  );
  const client = new SecretClient(config.vaultUrl, credential);

  for (const [key, value] of Object.entries(payload.secrets)) {
    await client.setSecret(`${config.prefix ?? ""}${providerSecretName(key)}`, value);
  }
}

function kubeDispatcher(config: SyncKubernetesConfig): Agent | undefined {
  if (!config.caData && !config.skipTlsVerify) return undefined;
  return new Agent({
    connect: {
      ca: config.caData ? Buffer.from(config.caData, "base64") : undefined,
      rejectUnauthorized: !config.skipTlsVerify,
    },
  });
}

async function kubeFetch(url: string, init: RequestInit, dispatcher?: Agent): Promise<Response> {
  return fetch(url, (dispatcher ? { ...init, dispatcher } : init) as RequestInit);
}

async function sendKubernetes(config: SyncKubernetesConfig, payload: SyncPayload): Promise<void> {
  const base = config.apiUrl.replace(/\/$/, "");
  const resource = `${base}/api/v1/namespaces/${encodeURIComponent(config.namespace)}/secrets`;
  const headers = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
  };
  const dispatcher = kubeDispatcher(config);
  const data = Object.fromEntries(
    Object.entries(payload.secrets).map(([key, value]) => [
      key,
      Buffer.from(value, "utf8").toString("base64"),
    ]),
  );

  try {
    const current = await kubeFetch(
      `${resource}/${encodeURIComponent(config.secretName)}`,
      { headers },
      dispatcher,
    );

    if (current.status === 404) {
      const created = await kubeFetch(
        resource,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: config.secretName, namespace: config.namespace },
            type: "Opaque",
            data,
          }),
        },
        dispatcher,
      );
      if (!created.ok) throw new Error(`kubernetes responded ${created.status}`);
      return;
    }

    if (!current.ok) throw new Error(`kubernetes responded ${current.status}`);

    const existing = (await current.json()) as {
      data?: Record<string, string>;
      metadata?: { resourceVersion?: string };
    };
    const updated = await kubeFetch(
      `${resource}/${encodeURIComponent(config.secretName)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name: config.secretName,
            namespace: config.namespace,
            resourceVersion: existing.metadata?.resourceVersion,
          },
          type: "Opaque",
          data: { ...(existing.data ?? {}), ...data },
        }),
      },
      dispatcher,
    );
    if (!updated.ok) throw new Error(`kubernetes responded ${updated.status}`);
  } finally {
    await dispatcher?.close();
  }
}

async function send(provider: string, config: SyncConfig, payload: SyncPayload): Promise<void> {
  if (provider === "webhook") return sendWebhook(config as SyncWebhookConfig, payload);
  if (provider === "vercel") return sendVercel(config as SyncVercelConfig, payload);
  if (provider === "cloudflare") return sendCloudflare(config as SyncCloudflareConfig, payload);
  if (provider === "github") return sendGithub(config as SyncGithubConfig, payload);
  if (provider === "aws") return sendAws(config as SyncAwsConfig, payload);
  if (provider === "gcp") return sendGcp(config as SyncGcpConfig, payload);
  if (provider === "azure") return sendAzure(config as SyncAzureConfig, payload);
  if (provider === "kubernetes") return sendKubernetes(config as SyncKubernetesConfig, payload);
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

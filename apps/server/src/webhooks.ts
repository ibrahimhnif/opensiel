import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { decryptValue, encryptValue, randomToken } from "./crypto.js";
import { projectDek } from "./access.js";
import { webhooks } from "./db/schema.js";
import type { ProjectRow, WebhookRow } from "./db/schema.js";
import type { ActorMeta } from "./secrets-service.js";
import type { Deps } from "./types.js";

export interface DispatchInput {
  event: string;
  actor: ActorMeta;
  resource: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function aad(id: string): string {
  return `webhook:${id}`;
}

export function generateWebhookSecret(): string {
  return randomToken(24);
}

export function encryptWebhookSecret(
  deps: Deps,
  project: ProjectRow,
  webhookId: string,
  secret: string,
) {
  return encryptValue(projectDek(deps, project), secret, aad(webhookId));
}

export function decryptWebhookSecret(deps: Deps, project: ProjectRow, webhook: WebhookRow): string {
  return decryptValue(
    projectDek(deps, project),
    {
      ciphertext: webhook.secretCiphertext,
      iv: webhook.secretIv,
      tag: webhook.secretTag,
    },
    aad(webhook.id),
  );
}

export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function deliverToWebhook(
  deps: Deps,
  project: ProjectRow,
  webhook: WebhookRow,
  event: string,
  payload: string,
): Promise<{ status: number | null; error: string | null }> {
  const secret = decryptWebhookSecret(deps, project, webhook);
  const signature = signPayload(secret, payload);
  const deliveryId = randomUUID();

  let status: number | null = null;
  let error: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "opensiel-webhook/0.1",
          "x-opensiel-event": event,
          "x-opensiel-signature": `sha256=${signature}`,
          "x-opensiel-delivery": deliveryId,
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      status = response.status;
      if (response.ok) {
        error = null;
        break;
      }
      error = `HTTP ${response.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "delivery failed";
    }
  }

  await deps.db
    .update(webhooks)
    .set({
      lastStatus: status,
      lastError: error ? error.slice(0, 500) : null,
      lastDeliveryAt: new Date(),
      failureCount: error ? webhook.failureCount + 1 : 0,
    })
    .where(eq(webhooks.id, webhook.id));

  return { status, error };
}

export async function dispatchEvent(
  deps: Deps,
  project: ProjectRow,
  input: DispatchInput,
): Promise<number> {
  const rows = await deps.db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.projectId, project.id), eq(webhooks.enabled, true)));

  const matching = rows.filter(
    (webhook) =>
      Array.isArray(webhook.events) &&
      (webhook.events.includes(input.event) || webhook.events.includes("*")),
  );

  let delivered = 0;
  for (const webhook of matching) {
    const payload = JSON.stringify({
      id: randomUUID(),
      event: input.event,
      projectId: project.id,
      orgId: project.orgId,
      actor: { type: input.actor.type, id: input.actor.id, name: input.actor.name },
      resource: input.resource,
      data: input.data ?? {},
      timestamp: new Date().toISOString(),
    });
    const result = await deliverToWebhook(deps, project, webhook, input.event, payload);
    if (!result.error) delivered += 1;
  }
  return delivered;
}

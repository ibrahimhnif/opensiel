import { asc, eq, gt } from "drizzle-orm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { auditLogs, auditSinkState } from "./db/schema.js";
import type { AuditLogRow } from "./db/schema.js";
import type { AuditSinkConfig } from "./env.js";
import type { Deps } from "./types.js";

const STATE_ID = "default";
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface AuditSinkResult {
  sent: number;
  skipped?: string;
  error?: string;
}

export function auditEvent(row: AuditLogRow) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    projectId: row.projectId,
    ip: row.ip,
    metadata: row.metadata,
  };
}

export function buildSinkBody(
  type: AuditSinkConfig["type"],
  rows: AuditLogRow[],
): { body: string; contentType: string } {
  const events = rows.map(auditEvent);
  if (type === "splunk") {
    return {
      body: events
        .map((event) => JSON.stringify({ event, sourcetype: "opensiel:audit" }))
        .join("\n"),
      contentType: "application/json",
    };
  }
  if (type === "datadog") {
    return {
      body: JSON.stringify(
        events.map((event) => ({
          ...event,
          ddsource: "opensiel",
          service: "opensiel",
          message: JSON.stringify(event),
        })),
      ),
      contentType: "application/json",
    };
  }
  if (type === "s3") {
    return {
      body: events
        .map((event) => JSON.stringify(event))
        .join("\n")
        .concat("\n"),
      contentType: "application/x-ndjson",
    };
  }
  return { body: JSON.stringify({ events }), contentType: "application/json" };
}

function sinkHeaders(config: AuditSinkConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!config.token) return headers;
  if (config.type === "splunk") headers.authorization = `Splunk ${config.token}`;
  else if (config.type === "datadog") headers["dd-api-key"] = config.token;
  else headers.authorization = `Bearer ${config.token}`;
  return headers;
}

let s3Client: S3Client | undefined;
let s3Signature = "";

function s3For(config: AuditSinkConfig): S3Client {
  const signature = JSON.stringify([
    config.region,
    config.endpoint,
    config.accessKeyId,
    config.secretAccessKey,
  ]);
  if (!s3Client || s3Signature !== signature) {
    s3Client = new S3Client({
      region: config.region ?? "us-east-1",
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
    });
    s3Signature = signature;
  }
  return s3Client;
}

async function sendBatch(config: AuditSinkConfig, rows: AuditLogRow[]): Promise<void> {
  const { body, contentType } = buildSinkBody(config.type, rows);

  if (config.type === "s3") {
    if (!config.bucket) throw new Error("audit sink bucket is not configured");
    const first = rows[0];
    const day = first.createdAt.toISOString().slice(0, 10);
    const key = `${config.prefix ?? "opensiel-audit"}/${day}/${first.id}.ndjson`;
    await s3For(config).send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return;
  }

  if (!config.url) throw new Error("audit sink url is not configured");
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": contentType, ...sinkHeaders(config) },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`audit sink responded ${response.status}`);
}

export async function runAuditSinkOnce(deps: Deps): Promise<AuditSinkResult> {
  const config = deps.env.auditSink;
  if (!config) return { sent: 0, skipped: "disabled" };

  return deps.db.transaction(async (tx) => {
    const stateRows = await tx
      .select()
      .from(auditSinkState)
      .where(eq(auditSinkState.id, STATE_ID))
      .for("update", { skipLocked: true });
    const state = stateRows[0];
    if (!state) return { sent: 0, skipped: "locked" };
    if (state.nextAttemptAt && state.nextAttemptAt.getTime() > Date.now()) {
      return { sent: 0, skipped: "backoff" };
    }

    const rows = await tx
      .select()
      .from(auditLogs)
      .where(gt(auditLogs.seq, state.lastSeq))
      .orderBy(asc(auditLogs.seq))
      .limit(config.batchSize);
    if (rows.length === 0) return { sent: 0 };

    try {
      await sendBatch(config, rows);
    } catch (error) {
      const message = error instanceof Error ? error.message : "sink delivery failed";
      const failureCount = state.failureCount + 1;
      const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount, 10), MAX_BACKOFF_MS);
      await tx
        .update(auditSinkState)
        .set({
          failureCount,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(auditSinkState.id, STATE_ID));
      return { sent: 0, error: message };
    }

    const last = rows[rows.length - 1];
    await tx
      .update(auditSinkState)
      .set({
        lastSeq: last.seq,
        failureCount: 0,
        lastError: null,
        nextAttemptAt: null,
        lastSuccessAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(auditSinkState.id, STATE_ID));

    return { sent: rows.length };
  });
}

export function startAuditSink(deps: Deps): NodeJS.Timeout | undefined {
  const config = deps.env.auditSink;
  if (!config || deps.env.nodeEnv === "test") return undefined;

  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runAuditSinkOnce(deps)
      .then((result) => {
        if (result.sent > 0) console.log(`audit sink delivered ${result.sent} event(s)`);
        if (result.error) console.error(`audit sink delivery failed: ${result.error}`);
      })
      .catch((error: unknown) => {
        console.error("audit sink failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, config.intervalSeconds * 1000);
  timer.unref();
  tick();
  return timer;
}

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, ilike } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { WebhookDto } from "@opensiel/shared";
import { createWebhookSchema, updateWebhookSchema } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { notFound, parse } from "../errors.js";
import { webhooks } from "../db/schema.js";
import type { WebhookRow } from "../db/schema.js";
import { deliverToWebhook, encryptWebhookSecret, generateWebhookSecret } from "../webhooks.js";
import { writeAudit } from "../audit.js";
import { paginationSchema } from "../pagination.js";
import type { Deps } from "../types.js";

function webhookDto(webhook: WebhookRow): WebhookDto {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    enabled: webhook.enabled,
    lastStatus: webhook.lastStatus,
    lastError: webhook.lastError,
    lastDeliveryAt: webhook.lastDeliveryAt?.toISOString() ?? null,
    failureCount: webhook.failureCount,
    createdAt: webhook.createdAt.toISOString(),
  };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/webhooks", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const query = parse(paginationSchema, request.query);

    const conditions = [eq(webhooks.projectId, project.id)];
    if (query.q) conditions.push(ilike(webhooks.url, `%${query.q}%`));

    const totalRows = await deps.db
      .select({ total: count() })
      .from(webhooks)
      .where(and(...conditions));
    const direction = query.order === "desc" ? desc : asc;
    const orderColumn =
      query.sort === "url"
        ? webhooks.url
        : query.sort === "lastDeliveryAt"
          ? webhooks.lastDeliveryAt
          : webhooks.createdAt;

    const rows = await deps.db
      .select()
      .from(webhooks)
      .where(and(...conditions))
      .orderBy(direction(orderColumn))
      .limit(query.limit ?? 25)
      .offset(query.offset ?? 0);

    return {
      webhooks: rows.map(webhookDto),
      total: Number(totalRows[0]?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.post("/api/projects/:projectId/webhooks", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createWebhookSchema, request.body);

    const id = randomUUID();
    const signingSecret = input.secret ?? generateWebhookSecret();
    const encrypted = encryptWebhookSecret(deps, project, id, signingSecret);

    const inserted = await deps.db
      .insert(webhooks)
      .values({
        id,
        projectId: project.id,
        url: input.url,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretTag: encrypted.tag,
        events: input.events,
      })
      .returning();
    const webhook = inserted[0];

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "webhook.create",
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { url: webhook.url, events: webhook.events },
      ip: request.ip,
    });

    return reply.code(201).send({
      webhook: webhookDto(webhook),
      signingSecret,
    });
  });

  app.patch("/api/projects/:projectId/webhooks/:webhookId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, webhookId } = request.params as {
      projectId: string;
      webhookId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(updateWebhookSchema, request.body);

    const rows = await deps.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, project.id)))
      .limit(1);
    const webhook = rows[0];
    if (!webhook) throw notFound("webhook not found");

    const updated = await deps.db
      .update(webhooks)
      .set({ enabled: input.enabled })
      .where(eq(webhooks.id, webhook.id))
      .returning();

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "webhook.update",
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { enabled: input.enabled },
      ip: request.ip,
    });

    return { webhook: webhookDto(updated[0]) };
  });

  app.delete("/api/projects/:projectId/webhooks/:webhookId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, webhookId } = request.params as {
      projectId: string;
      webhookId: string;
    };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, project.id)))
      .limit(1);
    const webhook = rows[0];
    if (!webhook) throw notFound("webhook not found");

    await deps.db.delete(webhooks).where(eq(webhooks.id, webhook.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "webhook.delete",
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { url: webhook.url },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.post("/api/projects/:projectId/webhooks/:webhookId/test", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, webhookId } = request.params as {
      projectId: string;
      webhookId: string;
    };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, project.id)))
      .limit(1);
    const webhook = rows[0];
    if (!webhook) throw notFound("webhook not found");

    const payload = JSON.stringify({
      id: randomUUID(),
      event: "webhook.test",
      projectId: project.id,
      orgId: project.orgId,
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: { type: "webhook", id: webhook.id },
      data: { message: "test delivery" },
      timestamp: new Date().toISOString(),
    });
    const result = await deliverToWebhook(deps, project, webhook, "webhook.test", payload);

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "webhook.test",
      resourceType: "webhook",
      resourceId: webhook.id,
      metadata: { status: result.status, error: result.error },
      ip: request.ip,
    });

    return { delivered: !result.error, status: result.status, error: result.error };
  });
}

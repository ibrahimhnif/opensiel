import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../auth.js";
import { loadProject } from "../access.js";
import { badRequest, forbidden, parse } from "../errors.js";
import { auditLogs } from "../db/schema.js";
import type { AuditLogRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

const querySchema = z.object({
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const exportQuerySchema = z.object({
  format: z.enum(["jsonl", "csv"]).default("jsonl"),
  projectId: z.string().uuid().optional(),
  action: z.string().trim().max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

const EXPORT_PAGE_SIZE = 1000;

function exportRow(row: AuditLogRow) {
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

function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function registerAuditRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/audit/export", async (request, reply) => {
    const actor = await requireActor(deps, request);
    if (actor.type === "machine") throw forbidden("a user session is required");
    const query = parse(exportQuerySchema, request.query);
    if (query.projectId) await loadProject(deps, actor, query.projectId);

    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw badRequest("from must be before to");
    }

    const conditions = [eq(auditLogs.orgId, actor.orgId)];
    if (query.projectId) conditions.push(eq(auditLogs.projectId, query.projectId));
    if (query.action) conditions.push(eq(auditLogs.action, query.action));
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    if (to) conditions.push(lte(auditLogs.createdAt, to));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: query.projectId ?? null,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "audit.export",
      resourceType: "audit_log",
      resourceId: actor.orgId,
      metadata: {
        format: query.format,
        projectId: query.projectId ?? null,
        action: query.action ?? null,
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
      },
      ip: request.ip,
    });

    async function* generate(): AsyncGenerator<string> {
      if (query.format === "csv") {
        yield "id,createdAt,actorType,actorId,actorName,action,resourceType,resourceId,projectId,ip,metadata\n";
      }
      let offset = 0;
      for (;;) {
        const batch = await deps.db
          .select()
          .from(auditLogs)
          .where(and(...conditions))
          .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
          .limit(EXPORT_PAGE_SIZE)
          .offset(offset);

        for (const row of batch) {
          const item = exportRow(row);
          if (query.format === "csv") {
            yield [
              item.id,
              item.createdAt,
              item.actorType,
              item.actorId,
              item.actorName,
              item.action,
              item.resourceType,
              item.resourceId,
              item.projectId,
              item.ip,
              item.metadata,
            ]
              .map(csvCell)
              .join(",")
              .concat("\n");
          } else {
            yield `${JSON.stringify(item)}\n`;
          }
        }

        if (batch.length < EXPORT_PAGE_SIZE) break;
        offset += EXPORT_PAGE_SIZE;
      }
    }

    const filename = `audit-${new Date().toISOString().slice(0, 10)}.${query.format === "csv" ? "csv" : "jsonl"}`;
    return reply
      .type(query.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .send(Readable.from(generate()));
  });

  app.get("/api/audit", async (request) => {
    const actor = await requireActor(deps, request);
    if (actor.type === "machine") throw forbidden("a user session is required");
    const query = parse(querySchema, request.query);

    if (query.projectId) await loadProject(deps, actor, query.projectId);

    const conditions = [eq(auditLogs.orgId, actor.orgId)];
    if (query.projectId) conditions.push(eq(auditLogs.projectId, query.projectId));
    if (query.cursor) {
      const cursor = new Date(query.cursor);
      if (!Number.isNaN(cursor.getTime())) conditions.push(lt(auditLogs.createdAt, cursor));
    }

    const rows = await deps.db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.limit ?? 100);

    return {
      logs: rows.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        actorId: row.actorId,
        actorName: row.actorName,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        projectId: row.projectId,
        metadata: row.metadata,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > 0 ? rows[rows.length - 1].createdAt.toISOString() : null,
    };
  });
}

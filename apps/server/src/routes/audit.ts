import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../auth.js";
import { loadProject } from "../access.js";
import { forbidden, parse } from "../errors.js";
import { auditLogs } from "../db/schema.js";
import type { Deps } from "../types.js";

const querySchema = z.object({
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export function registerAuditRoutes(app: FastifyInstance, deps: Deps): void {
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

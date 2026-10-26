import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChangeRequestAction } from "@opensiel/shared";
import {
  changeRequestDecisionSchema,
  environmentImportSchema,
  environmentPolicySchema,
} from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { badRequest, forbidden, notFound, parse } from "../errors.js";
import { environmentImports, environments } from "../db/schema.js";
import {
  cancelChangeRequest,
  decideChangeRequest,
  listChangeRequests,
} from "../approvals-service.js";
import { writeAudit } from "../audit.js";
import { paginationSchema } from "../pagination.js";
import type { Deps } from "../types.js";

const ACTIONS: ChangeRequestAction[] = ["set", "delete", "rollback"];

const listQuerySchema = paginationSchema.merge(
  z.object({
    status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    action: z.enum(["set", "delete", "rollback"]).optional(),
    sort: z.enum(["requestedAt", "status"]).default("requestedAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
  }),
);

export function registerApprovalRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/change-requests", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    await loadProject(deps, actor, projectId);

    const query = parse(listQuerySchema, request.query);
    if (query.action && !ACTIONS.includes(query.action)) {
      throw badRequest(`action must be one of ${ACTIONS.join(", ")}`);
    }

    const result = await listChangeRequests(deps, projectId, {
      status: query.status,
      requestedById: actor.type === "machine" ? actor.id : undefined,
      action: query.action,
      q: query.q,
      sort: query.sort,
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      changeRequests: result.requests,
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.post("/api/projects/:projectId/change-requests/:requestId/approve", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw forbidden("owner or admin role required to approve changes");
    }
    const { projectId, requestId } = request.params as { projectId: string; requestId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(changeRequestDecisionSchema, request.body ?? {});

    return decideChangeRequest(deps, {
      actor,
      projectId: project.id,
      requestId,
      decision: "approve",
      note: input.note,
      ip: request.ip,
    });
  });

  app.post("/api/projects/:projectId/change-requests/:requestId/reject", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw forbidden("owner or admin role required to reject changes");
    }
    const { projectId, requestId } = request.params as { projectId: string; requestId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(changeRequestDecisionSchema, request.body ?? {});

    return decideChangeRequest(deps, {
      actor,
      projectId: project.id,
      requestId,
      decision: "reject",
      note: input.note,
      ip: request.ip,
    });
  });

  app.post("/api/projects/:projectId/change-requests/:requestId/cancel", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, requestId } = request.params as { projectId: string; requestId: string };
    const project = await loadProject(deps, actor, projectId);

    return {
      changeRequest: await cancelChangeRequest(deps, actor, project.id, requestId, request.ip),
    };
  });

  app.get("/api/projects/:projectId/environment-imports", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select({
        targetEnvironmentId: environmentImports.targetEnvironmentId,
        sourceEnvironmentId: environmentImports.sourceEnvironmentId,
        sourceSlug: environments.slug,
      })
      .from(environmentImports)
      .innerJoin(environments, eq(environments.id, environmentImports.sourceEnvironmentId))
      .where(eq(environments.projectId, project.id));

    return { imports: rows };
  });

  app.put("/api/projects/:projectId/environments/:environmentId/imports", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, environmentId } = request.params as {
      projectId: string;
      environmentId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(environmentImportSchema, request.body);

    const targetRows = await deps.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.projectId, project.id)))
      .limit(1);
    const target = targetRows[0];
    if (!target) throw notFound("environment not found");

    if (input.sourceEnvironmentId === null) {
      await deps.db
        .delete(environmentImports)
        .where(eq(environmentImports.targetEnvironmentId, target.id));
    } else {
      if (input.sourceEnvironmentId === target.id) {
        throw badRequest("an environment cannot import from itself");
      }
      const sourceRows = await deps.db
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.id, input.sourceEnvironmentId),
            eq(environments.projectId, project.id),
          ),
        )
        .limit(1);
      if (!sourceRows[0]) throw badRequest("source environment does not belong to this project");

      await deps.db
        .insert(environmentImports)
        .values({
          targetEnvironmentId: target.id,
          sourceEnvironmentId: input.sourceEnvironmentId,
        })
        .onConflictDoUpdate({
          target: environmentImports.targetEnvironmentId,
          set: { sourceEnvironmentId: input.sourceEnvironmentId },
        });
    }

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "environment.import",
      resourceType: "environment",
      resourceId: target.id,
      metadata: {
        environment: target.slug,
        sourceEnvironmentId: input.sourceEnvironmentId,
      },
      ip: request.ip,
    });

    return { ok: true };
  });

  app.patch("/api/projects/:projectId/environments/:environmentId/policy", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, environmentId } = request.params as {
      projectId: string;
      environmentId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(environmentPolicySchema, request.body);

    const rows = await deps.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.projectId, project.id)))
      .limit(1);
    const environment = rows[0];
    if (!environment) throw notFound("environment not found");

    const updated = await deps.db
      .update(environments)
      .set({
        approvalRequired: input.approvalRequired ?? environment.approvalRequired,
        requiredApprovals: input.requiredApprovals ?? environment.requiredApprovals,
      })
      .where(eq(environments.id, environment.id))
      .returning();
    const next = updated[0];

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "environment.policy",
      resourceType: "environment",
      resourceId: environment.id,
      metadata: {
        environment: environment.slug,
        approvalRequired: next.approvalRequired,
        requiredApprovals: next.requiredApprovals,
      },
      ip: request.ip,
    });

    return {
      environment: {
        id: next.id,
        slug: next.slug,
        approvalRequired: next.approvalRequired,
        requiredApprovals: next.requiredApprovals,
      },
    };
  });
}

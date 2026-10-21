import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ChangeRequestStatus } from "@opensiel/shared";
import { changeRequestDecisionSchema, environmentPolicySchema } from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { assertCanAdmin, loadProject } from "../access.js";
import { badRequest, forbidden, notFound, parse } from "../errors.js";
import { environments } from "../db/schema.js";
import {
  cancelChangeRequest,
  decideChangeRequest,
  listChangeRequests,
} from "../approvals-service.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

const STATUSES: ChangeRequestStatus[] = ["pending", "approved", "rejected", "cancelled"];

export function registerApprovalRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/change-requests", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    await loadProject(deps, actor, projectId);

    const rawStatus = (request.query as { status?: string }).status;
    if (rawStatus && !STATUSES.includes(rawStatus as ChangeRequestStatus)) {
      throw badRequest(`status must be one of ${STATUSES.join(", ")}`);
    }

    return {
      changeRequests: await listChangeRequests(deps, projectId, {
        status: rawStatus as ChangeRequestStatus | undefined,
        requestedById: actor.type === "machine" ? actor.id : undefined,
      }),
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

  app.patch(
    "/api/projects/:projectId/environments/:environmentId/policy",
    async (request) => {
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
    },
  );
}

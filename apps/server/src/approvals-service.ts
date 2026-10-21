import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import type { ChangeRequestAction, ChangeRequestDto, ChangeRequestStatus } from "@opensiel/shared";
import { decryptValue, encryptValue } from "./crypto.js";
import { projectDek } from "./access.js";
import { conflict, forbidden, notFound } from "./errors.js";
import {
  changeRequestApprovals,
  changeRequests,
  environments,
  projects,
  users,
} from "./db/schema.js";
import type { ChangeRequestRow, EnvironmentRow, ProjectRow } from "./db/schema.js";
import { writeAudit } from "./audit.js";
import { dispatchEvent } from "./webhooks.js";
import { applySecretDelete, applySecretRollback, applySecretWrite } from "./secrets-service.js";
import type { ActorMeta } from "./secrets-service.js";
import type { Actor, Deps, UserActor } from "./types.js";

export function changeAad(id: string): string {
  return `change:${id}`;
}

export async function createChangeRequest(
  deps: Deps,
  project: ProjectRow,
  environment: EnvironmentRow,
  actor: ActorMeta,
  input: {
    action: ChangeRequestAction;
    key: string;
    path: string;
    value?: string;
    targetVersion?: number;
    comment?: string | null;
  },
  ip: string,
): Promise<ChangeRequestDto> {
  const id = randomUUID();
  let payload: { ciphertext: string; iv: string; tag: string } | null = null;
  if (input.action === "set" && input.value !== undefined) {
    payload = encryptValue(projectDek(deps, project), input.value, changeAad(id));
  }

  const inserted = await deps.db
    .insert(changeRequests)
    .values({
      id,
      projectId: project.id,
      environmentId: environment.id,
      action: input.action,
      secretKey: input.key,
      path: input.path,
      targetVersion: input.targetVersion ?? null,
      payloadCiphertext: payload?.ciphertext ?? null,
      payloadIv: payload?.iv ?? null,
      payloadTag: payload?.tag ?? null,
      comment: input.comment ?? null,
      requestedByType: actor.type,
      requestedById: actor.id,
      requestedByName: actor.name,
    })
    .returning();
  const request = inserted[0];

  await writeAudit(deps, {
    orgId: project.orgId,
    projectId: project.id,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: "change_request.create",
    resourceType: "change_request",
    resourceId: request.id,
    metadata: {
      change: request.action,
      key: request.secretKey,
      path: request.path,
      environment: environment.slug,
    },
    ip,
  });

  void dispatchEvent(deps, project, {
    event: "change_request.created",
    actor: { type: actor.type, id: actor.id, name: actor.name },
    resource: {
      type: "change_request",
      id: request.id,
      action: request.action,
      key: request.secretKey,
      path: request.path,
      environment: environment.slug,
    },
  }).catch(() => {});

  return requestDto(request, environment.slug, [], environment.requiredApprovals);
}

export async function listChangeRequests(
  deps: Deps,
  projectId: string,
  options: { status?: ChangeRequestStatus; requestedById?: string } = {},
): Promise<ChangeRequestDto[]> {
  const conditions = [eq(changeRequests.projectId, projectId)];
  if (options.status) conditions.push(eq(changeRequests.status, options.status));
  if (options.requestedById)
    conditions.push(eq(changeRequests.requestedById, options.requestedById));

  const rows = await deps.db
    .select()
    .from(changeRequests)
    .where(and(...conditions))
    .orderBy(desc(changeRequests.requestedAt))
    .limit(100);
  if (rows.length === 0) return [];

  const envRows = await deps.db
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const envById = new Map(envRows.map((environment) => [environment.id, environment]));

  const approvalRows = await deps.db
    .select({ approval: changeRequestApprovals, user: users })
    .from(changeRequestApprovals)
    .innerJoin(users, eq(users.id, changeRequestApprovals.userId))
    .where(
      inArray(
        changeRequestApprovals.requestId,
        rows.map((row) => row.id),
      ),
    );

  return rows.map((row) => {
    const environment = envById.get(row.environmentId);
    const approvals = approvalRows.filter((entry) => entry.approval.requestId === row.id);
    return requestDto(
      row,
      environment?.slug ?? "unknown",
      approvals.map((entry) => entry.user.name),
      environment?.requiredApprovals ?? 1,
    );
  });
}

export async function decideChangeRequest(
  deps: Deps,
  params: {
    actor: UserActor;
    projectId: string;
    requestId: string;
    decision: "approve" | "reject";
    note?: string;
    ip: string;
  },
): Promise<{ request: ChangeRequestDto; applied: boolean }> {
  const { actor, projectId, requestId } = params;

  const rows = await deps.db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.id, requestId), eq(changeRequests.projectId, projectId)))
    .limit(1);
  const request = rows[0];
  if (!request) throw notFound("change request not found");
  if (request.status !== "pending") throw conflict("this change request is no longer pending");

  if (request.requestedByType === "user" && request.requestedById === actor.id) {
    throw forbidden("you cannot approve your own change request");
  }

  const envRows = await deps.db
    .select()
    .from(environments)
    .where(eq(environments.id, request.environmentId))
    .limit(1);
  const environment = envRows[0];
  if (!environment) throw notFound("environment not found");

  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw notFound("project not found");

  try {
    await deps.db.insert(changeRequestApprovals).values({
      requestId: request.id,
      userId: actor.id,
      decision: params.decision,
      note: params.note ?? null,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    ) {
      throw conflict("you have already decided on this request");
    }
    throw error;
  }

  if (params.decision === "reject") {
    await deps.db
      .update(changeRequests)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedBy: actor.name,
        decisionNote: params.note ?? null,
      })
      .where(eq(changeRequests.id, request.id));

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "change_request.reject",
      resourceType: "change_request",
      resourceId: request.id,
      metadata: {
        key: request.secretKey,
        environment: environment.slug,
        note: params.note ?? null,
      },
      ip: params.ip,
    });

    void dispatchEvent(deps, project, {
      event: "change_request.rejected",
      actor: { type: "user", id: actor.id, name: actor.name },
      resource: {
        type: "change_request",
        id: request.id,
        action: request.action,
        key: request.secretKey,
        environment: environment.slug,
      },
    }).catch(() => {});

    return {
      request: requestDto(
        { ...request, status: "rejected", decidedAt: new Date(), decidedBy: actor.name },
        environment.slug,
        await approvalNames(deps, request.id),
        environment.requiredApprovals,
      ),
      applied: false,
    };
  }

  const tally = await deps.db
    .select({ total: count() })
    .from(changeRequestApprovals)
    .where(
      and(
        eq(changeRequestApprovals.requestId, request.id),
        eq(changeRequestApprovals.decision, "approve"),
      ),
    );
  const approvals = Number(tally[0]?.total ?? 0);

  await writeAudit(deps, {
    orgId: actor.orgId,
    projectId,
    actorType: "user",
    actorId: actor.id,
    actorName: actor.name,
    action: "change_request.approve",
    resourceType: "change_request",
    resourceId: request.id,
    metadata: {
      key: request.secretKey,
      environment: environment.slug,
      approvals,
      required: environment.requiredApprovals,
    },
    ip: params.ip,
  });

  if (approvals < environment.requiredApprovals) {
    return {
      request: requestDto(
        request,
        environment.slug,
        await approvalNames(deps, request.id),
        environment.requiredApprovals,
      ),
      applied: false,
    };
  }

  const claimed = await deps.db
    .update(changeRequests)
    .set({
      status: "approved",
      decidedAt: new Date(),
      decidedBy: actor.name,
      decisionNote: params.note ?? null,
    })
    .where(and(eq(changeRequests.id, request.id), eq(changeRequests.status, "pending")))
    .returning();
  if (claimed.length === 0) {
    throw conflict("this change request was already applied");
  }

  const requester: ActorMeta = {
    type: request.requestedByType as ActorMeta["type"],
    id: request.requestedById,
    name: request.requestedByName,
  };
  const suffix = `approved by ${actor.name}`;
  const comment = request.comment ? `${request.comment} (${suffix})` : suffix;

  try {
    if (request.action === "set") {
      if (!request.payloadCiphertext || !request.payloadIv || !request.payloadTag) {
        throw conflict("change request has no payload");
      }
      const value = decryptValue(
        projectDek(deps, project),
        {
          ciphertext: request.payloadCiphertext,
          iv: request.payloadIv,
          tag: request.payloadTag,
        },
        changeAad(request.id),
      );
      const result = await applySecretWrite(deps, project, environment, requester, {
        key: request.secretKey,
        value,
        path: request.path,
        comment,
      });
      await writeAudit(deps, {
        orgId: project.orgId,
        projectId,
        actorType: "user",
        actorId: actor.id,
        actorName: actor.name,
        action: "change_request.apply",
        resourceType: "secret",
        resourceId: result.secretId,
        metadata: {
          requestId: request.id,
          key: request.secretKey,
          version: result.version,
          environment: environment.slug,
        },
        ip: params.ip,
      });
    } else if (request.action === "delete") {
      const result = await applySecretDelete(
        deps,
        project.id,
        environment.id,
        request.path,
        request.secretKey,
      );
      await writeAudit(deps, {
        orgId: project.orgId,
        projectId,
        actorType: "user",
        actorId: actor.id,
        actorName: actor.name,
        action: "change_request.apply",
        resourceType: "secret",
        resourceId: result.secretId,
        metadata: {
          requestId: request.id,
          key: request.secretKey,
          action: "delete",
          environment: environment.slug,
        },
        ip: params.ip,
      });
    } else {
      const result = await applySecretRollback(deps, project, environment, requester, {
        key: request.secretKey,
        path: request.path,
        targetVersion: request.targetVersion ?? 0,
        note: comment,
      });
      await writeAudit(deps, {
        orgId: project.orgId,
        projectId,
        actorType: "user",
        actorId: actor.id,
        actorName: actor.name,
        action: "change_request.apply",
        resourceType: "secret",
        resourceId: result.secretId,
        metadata: {
          requestId: request.id,
          key: request.secretKey,
          version: result.version,
          from: result.from,
          environment: environment.slug,
        },
        ip: params.ip,
      });
    }
  } catch (error) {
    await deps.db
      .update(changeRequests)
      .set({ status: "pending", decidedAt: null, decidedBy: null })
      .where(eq(changeRequests.id, request.id));
    throw error;
  }

  void dispatchEvent(deps, project, {
    event: "change_request.approved",
    actor: { type: "user", id: actor.id, name: actor.name },
    resource: {
      type: "change_request",
      id: request.id,
      action: request.action,
      key: request.secretKey,
      path: request.path,
      environment: environment.slug,
    },
  }).catch(() => {});

  return {
    request: requestDto(
      { ...request, status: "approved", decidedAt: new Date(), decidedBy: actor.name },
      environment.slug,
      await approvalNames(deps, request.id),
      environment.requiredApprovals,
    ),
    applied: true,
  };
}

export async function cancelChangeRequest(
  deps: Deps,
  actor: Actor,
  projectId: string,
  requestId: string,
  ip: string,
): Promise<ChangeRequestDto> {
  const rows = await deps.db
    .select()
    .from(changeRequests)
    .where(and(eq(changeRequests.id, requestId), eq(changeRequests.projectId, projectId)))
    .limit(1);
  const request = rows[0];
  if (!request) throw notFound("change request not found");
  if (request.status !== "pending") throw conflict("this change request is no longer pending");

  const isRequester = request.requestedByType === actor.type && request.requestedById === actor.id;
  const isAdmin = actor.type === "user" && (actor.role === "owner" || actor.role === "admin");
  if (!isRequester && !isAdmin)
    throw forbidden("only the requester or an admin can cancel this request");

  await deps.db
    .update(changeRequests)
    .set({ status: "cancelled", decidedAt: new Date(), decidedBy: actor.name })
    .where(eq(changeRequests.id, request.id));

  await writeAudit(deps, {
    orgId: actor.orgId,
    projectId,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action: "change_request.cancel",
    resourceType: "change_request",
    resourceId: request.id,
    metadata: { key: request.secretKey },
    ip,
  });

  const envRows = await deps.db
    .select()
    .from(environments)
    .where(eq(environments.id, request.environmentId))
    .limit(1);
  return requestDto(
    { ...request, status: "cancelled", decidedAt: new Date(), decidedBy: actor.name },
    envRows[0]?.slug ?? "unknown",
    await approvalNames(deps, request.id),
    envRows[0]?.requiredApprovals ?? 1,
  );
}

async function approvalNames(deps: Deps, requestId: string): Promise<string[]> {
  const rows = await deps.db
    .select({ user: users, approval: changeRequestApprovals })
    .from(changeRequestApprovals)
    .innerJoin(users, eq(users.id, changeRequestApprovals.userId))
    .where(
      and(
        eq(changeRequestApprovals.requestId, requestId),
        eq(changeRequestApprovals.decision, "approve"),
      ),
    );
  return rows.map((row) => row.user.name);
}

function requestDto(
  request: ChangeRequestRow,
  environmentSlug: string,
  approvedBy: string[],
  requiredApprovals: number,
): ChangeRequestDto {
  return {
    id: request.id,
    action: request.action,
    key: request.secretKey,
    path: request.path,
    comment: request.comment,
    targetVersion: request.targetVersion,
    status: request.status,
    environmentId: request.environmentId,
    environmentSlug,
    requestedByType: request.requestedByType,
    requestedById: request.requestedById,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt.toISOString(),
    approvals: approvedBy.length,
    requiredApprovals,
    approvedBy,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decisionNote: request.decisionNote,
  };
}

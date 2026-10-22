import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createRotationSchema,
  rotationHttpConfigSchema,
  rotationPostgresConfigSchema,
  updateRotationSchema,
} from "@opensiel/shared";
import type { RotationPolicyDto } from "@opensiel/shared";
import { requireActor } from "../auth.js";
import { assertCanAdmin, loadEnvironment, loadProject, normalizePath } from "../access.js";
import { badRequest, conflict, notFound, parse } from "../errors.js";
import { environments, rotationPolicies } from "../db/schema.js";
import type { RotationPolicyRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { encryptRotationConfig, runRotation } from "../rotation.js";
import type { Deps } from "../types.js";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

function policyDto(policy: RotationPolicyRow, environmentSlug: string): RotationPolicyDto {
  return {
    id: policy.id,
    key: policy.secretKey,
    path: policy.path,
    environmentSlug,
    provider: policy.provider,
    intervalSeconds: policy.intervalSeconds,
    graceSeconds: policy.graceSeconds,
    enabled: policy.enabled,
    nextRunAt: policy.nextRunAt.toISOString(),
    lastRunAt: policy.lastRunAt?.toISOString() ?? null,
    lastStatus: policy.lastStatus,
    lastError: policy.lastError,
    failureCount: policy.failureCount,
    previousRevokeAfter: policy.previousRevokeAfter?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
  };
}

async function envSlugMap(deps: Deps, projectId: string): Promise<Map<string, string>> {
  const rows = await deps.db
    .select({ id: environments.id, slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  return new Map(rows.map((row) => [row.id, row.slug]));
}

export function registerRotationRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/rotations", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const envs = await envSlugMap(deps, project.id);

    const rows = await deps.db
      .select()
      .from(rotationPolicies)
      .where(eq(rotationPolicies.projectId, project.id))
      .orderBy(rotationPolicies.createdAt);

    return {
      rotations: rows.map((policy) =>
        policyDto(policy, envs.get(policy.environmentId) ?? "unknown"),
      ),
    };
  });

  app.post("/api/projects/:projectId/rotations", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createRotationSchema, request.body);
    const environment = await loadEnvironment(deps, project.id, input.env);
    const path = normalizePath(input.path);

    const config =
      input.provider === "postgres"
        ? parse(rotationPostgresConfigSchema, input.config)
        : parse(rotationHttpConfigSchema, input.config);

    const id = randomUUID();
    const encrypted = encryptRotationConfig(deps, project, id, config);

    let policy: RotationPolicyRow;
    try {
      const inserted = await deps.db
        .insert(rotationPolicies)
        .values({
          id,
          projectId: project.id,
          environmentId: environment.id,
          path,
          secretKey: input.key,
          provider: input.provider,
          configCiphertext: encrypted.ciphertext,
          configIv: encrypted.iv,
          configTag: encrypted.tag,
          intervalSeconds: input.intervalSeconds,
          graceSeconds: input.graceSeconds,
          enabled: input.enabled ?? true,
          nextRunAt: new Date(),
        })
        .returning();
      policy = inserted[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("a rotation policy already exists for this secret");
      }
      throw error;
    }

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "rotation.create",
      resourceType: "secret",
      resourceId: policy.id,
      metadata: {
        key: policy.secretKey,
        path,
        environment: environment.slug,
        provider: policy.provider,
        intervalSeconds: policy.intervalSeconds,
        graceSeconds: policy.graceSeconds,
      },
      ip: request.ip,
    });

    return reply.code(201).send({ rotation: policyDto(policy, environment.slug) });
  });

  app.patch("/api/projects/:projectId/rotations/:rotationId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, rotationId } = request.params as {
      projectId: string;
      rotationId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(updateRotationSchema, request.body);

    const rows = await deps.db
      .select()
      .from(rotationPolicies)
      .where(eq(rotationPolicies.id, rotationId))
      .limit(1);
    const policy = rows[0];
    if (!policy || policy.projectId !== project.id) throw notFound("rotation not found");

    if (input.intervalSeconds !== undefined && input.intervalSeconds <= policy.graceSeconds) {
      throw badRequest("intervalSeconds must be greater than graceSeconds");
    }

    const updated = await deps.db
      .update(rotationPolicies)
      .set({
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(rotationPolicies.id, policy.id))
      .returning();

    const envs = await envSlugMap(deps, project.id);
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "rotation.update",
      resourceType: "secret",
      resourceId: policy.id,
      metadata: {
        key: policy.secretKey,
        enabled: updated[0].enabled,
        intervalSeconds: updated[0].intervalSeconds,
      },
      ip: request.ip,
    });

    return {
      rotation: policyDto(updated[0], envs.get(updated[0].environmentId) ?? "unknown"),
    };
  });

  app.delete("/api/projects/:projectId/rotations/:rotationId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, rotationId } = request.params as {
      projectId: string;
      rotationId: string;
    };
    const project = await loadProject(deps, actor, projectId);

    const rows = await deps.db
      .select()
      .from(rotationPolicies)
      .where(eq(rotationPolicies.id, rotationId))
      .limit(1);
    const policy = rows[0];
    if (!policy || policy.projectId !== project.id) throw notFound("rotation not found");

    await deps.db.delete(rotationPolicies).where(eq(rotationPolicies.id, policy.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "rotation.delete",
      resourceType: "secret",
      resourceId: policy.id,
      metadata: { key: policy.secretKey, provider: policy.provider },
      ip: request.ip,
    });

    return { ok: true };
  });

  app.post(
    "/api/projects/:projectId/rotations/:rotationId/rotate",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = await requireActor(deps, request);
      assertCanAdmin(actor);
      const { projectId, rotationId } = request.params as {
        projectId: string;
        rotationId: string;
      };
      const project = await loadProject(deps, actor, projectId);

      const rows = await deps.db
        .select()
        .from(rotationPolicies)
        .where(eq(rotationPolicies.id, rotationId))
        .limit(1);
      const policy = rows[0];
      if (!policy || policy.projectId !== project.id) throw notFound("rotation not found");

      const result = await runRotation(deps, policy);
      return { result };
    },
  );
}

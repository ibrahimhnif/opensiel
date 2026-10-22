import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  pointInTimeQuerySchema,
  restorePointInTimeSchema,
  secretDiffQuerySchema,
} from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import {
  assertCanAdmin,
  assertEnvScope,
  loadEnvironment,
  loadProject,
  normalizePath,
  projectDek,
} from "../access.js";
import { AppError, badRequest, notFound, parse } from "../errors.js";
import { decryptValue, secretAad } from "../crypto.js";
import { secretVersions, secrets } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import { dispatchEvent } from "../webhooks.js";
import { maskValue } from "../scan.js";
import { applyPointInTimePlan, buildPointInTimePlan, loadPointInTime } from "../point-in-time.js";
import type { Deps } from "../types.js";

async function findSecretForHistory(
  deps: Deps,
  projectId: string,
  environmentId: string,
  path: string,
  key: string,
) {
  const rows = await deps.db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.projectId, projectId),
        eq(secrets.environmentId, environmentId),
        eq(secrets.path, path),
        eq(secrets.key, key),
      ),
    )
    .orderBy(desc(secrets.updatedAt))
    .limit(1);
  const secret = rows[0];
  if (!secret) throw notFound("secret not found");
  return secret;
}

export function registerHistoryRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects/:projectId/secrets/:key/diff", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId, key } = request.params as { projectId: string; key: string };
    const query = parse(secretDiffQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const path = normalizePath(query.path);
    const secret = await findSecretForHistory(deps, project.id, environment.id, path, key);

    const toVersion = query.to ?? secret.latestVersion;
    const fromVersion = query.from ?? toVersion - 1;
    if (toVersion > secret.latestVersion) throw notFound("secret version not found");
    if (fromVersion < 1 || toVersion < 1) throw badRequest("secret has no earlier version");
    if (fromVersion >= toVersion) throw badRequest("from must be lower than to");

    const rows = await deps.db
      .select()
      .from(secretVersions)
      .where(
        and(
          eq(secretVersions.secretId, secret.id),
          inArray(secretVersions.version, [fromVersion, toVersion]),
        ),
      );
    const fromRow = rows.find((row) => row.version === fromVersion);
    const toRow = rows.find((row) => row.version === toVersion);
    if (!fromRow || !toRow) throw notFound("secret version not found");

    const dek = projectDek(deps, project);
    const reveal = query.reveal === "true";
    const render = (value: string) => (reveal ? value : maskValue(value));

    const fromValue = decryptValue(
      dek,
      { ciphertext: fromRow.ciphertext, iv: fromRow.iv, tag: fromRow.tag },
      secretAad(secret.id, fromRow.version),
    );
    const toValue = decryptValue(
      dek,
      { ciphertext: toRow.ciphertext, iv: toRow.iv, tag: toRow.tag },
      secretAad(secret.id, toRow.version),
    );

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.diff",
      resourceType: "secret",
      resourceId: secret.id,
      metadata: {
        environment: environment.slug,
        path,
        key,
        from: fromVersion,
        to: toVersion,
        revealed: reveal,
      },
      ip: request.ip,
    });

    return {
      diff: {
        key: secret.key,
        path: secret.path,
        env: environment.slug,
        changed: fromValue !== toValue,
        revealed: reveal,
        from: {
          version: fromRow.version,
          value: render(fromValue),
          createdAt: fromRow.createdAt.toISOString(),
        },
        to: {
          version: toRow.version,
          value: render(toValue),
          createdAt: toRow.createdAt.toISOString(),
        },
      },
    };
  });

  app.get("/api/projects/:projectId/point-in-time", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const query = parse(pointInTimeQuerySchema, request.query);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, query.env);
    if (actor.type === "machine") assertEnvScope(actor, environment.id);

    const at = new Date(query.at);
    const rows = await loadPointInTime(deps, project.id, environment.id, at);
    const plan = buildPointInTimePlan(rows, at);

    return {
      at: at.toISOString(),
      env: environment.slug,
      secretCount: rows.length,
      changes: plan
        .filter((entry) => entry.action !== "none")
        .map((entry) => ({
          key: entry.key,
          path: entry.path,
          action: entry.action,
          currentVersion: entry.currentVersion,
          targetVersion: entry.targetVersion,
        })),
    };
  });

  app.post("/api/projects/:projectId/point-in-time/restore", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const input = parse(restorePointInTimeSchema, request.body);
    const project = await loadProject(deps, actor, projectId);
    const environment = await loadEnvironment(deps, project.id, input.env);

    if (environment.approvalRequired) {
      throw new AppError(
        409,
        "this environment requires approvals; restore secrets one at a time",
        "approval_required",
      );
    }

    const at = new Date(input.at);
    const rows = await loadPointInTime(deps, project.id, environment.id, at);
    const plan = buildPointInTimePlan(rows, at);
    const changes = plan
      .filter((entry) => entry.action !== "none")
      .map((entry) => ({
        key: entry.key,
        path: entry.path,
        action: entry.action,
        currentVersion: entry.currentVersion,
        targetVersion: entry.targetVersion,
      }));

    if (input.dryRun) {
      return {
        at: at.toISOString(),
        env: environment.slug,
        dryRun: true,
        restored: 0,
        revived: 0,
        deleted: 0,
        changes,
      };
    }

    const result = await applyPointInTimePlan(deps, project, environment, actor, at, plan);

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: project.id,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "secret.restore",
      resourceType: "environment",
      resourceId: environment.id,
      metadata: {
        environment: environment.slug,
        at: at.toISOString(),
        ...result,
      },
      ip: request.ip,
    });

    void dispatchEvent(deps, project, {
      event: "secret.restore",
      actor: { type: actor.type, id: actor.id, name: actor.name },
      resource: { type: "environment", environment: environment.slug },
      data: { at: at.toISOString(), ...result },
    }).catch(() => {});

    return {
      at: at.toISOString(),
      env: environment.slug,
      dryRun: false,
      ...result,
      changes,
    };
  });
}

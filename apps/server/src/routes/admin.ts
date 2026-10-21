import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireActor, requireUser } from "../auth.js";
import { AppError, conflict, forbidden } from "../errors.js";
import { projects } from "../db/schema.js";
import { unwrapDek, wrapDek } from "../crypto.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const requireOwner = (role: string) => {
    if (role !== "owner") throw forbidden("owner role required");
  };

  app.get("/api/admin/key", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    requireOwner(actor.role);

    const rows = await deps.db
      .select({ kekVersion: projects.kekVersion, total: count() })
      .from(projects)
      .groupBy(projects.kekVersion);

    return {
      currentVersion: deps.env.masterKeyVersion,
      nextConfigured: Boolean(deps.env.nextMasterKey),
      nextVersion: deps.env.nextMasterKeyVersion ?? null,
      projects: rows
        .map((row) => ({ version: row.kekVersion, count: Number(row.total) }))
        .sort((a, b) => a.version - b.version),
    };
  });

  app.post("/api/admin/rotate-key", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    requireOwner(actor.role);

    const nextKey = deps.env.nextMasterKey;
    const targetVersion = deps.env.nextMasterKeyVersion;
    if (!nextKey || targetVersion === undefined) {
      throw conflict("set OPENSIEL_MASTER_KEY_NEXT and restart before rotating");
    }

    const rows = await deps.db.select().from(projects);
    let rotated = 0;
    let skipped = 0;

    for (const project of rows) {
      if (project.kekVersion === targetVersion) {
        skipped += 1;
        continue;
      }
      if (project.kekVersion !== deps.env.masterKeyVersion) {
        throw new AppError(
          409,
          `project ${project.id} uses master key version ${project.kekVersion}; bring it to version ${deps.env.masterKeyVersion} first`,
          "missing_key_version",
        );
      }

      const dek = unwrapDek(deps.env.masterKey, {
        wrapped: project.dekWrapped,
        iv: project.dekIv,
        tag: project.dekTag,
      });
      const wrapped = wrapDek(nextKey, dek);

      await deps.db
        .update(projects)
        .set({
          dekWrapped: wrapped.wrapped,
          dekIv: wrapped.iv,
          dekTag: wrapped.tag,
          kekVersion: targetVersion,
        })
        .where(eq(projects.id, project.id));
      rotated += 1;
    }

    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: null,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "admin.key_rotate",
      resourceType: "instance",
      resourceId: "master-key",
      metadata: {
        rotated,
        skipped,
        fromVersion: deps.env.masterKeyVersion,
        targetVersion,
      },
      ip: request.ip,
    });

    return {
      rotated,
      skipped,
      fromVersion: deps.env.masterKeyVersion,
      targetVersion,
    };
  });
}

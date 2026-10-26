import { eq } from "drizzle-orm";
import { applySecretDelete, applySecretRollback } from "./secrets-service.js";
import type { ActorMeta } from "./secrets-service.js";
import { secrets } from "./db/schema.js";
import type { EnvironmentRow, ProjectRow } from "./db/schema.js";
import { badRequest } from "./errors.js";
import type { Deps } from "./types.js";

export interface PointInTimeRow {
  id: string;
  key: string;
  path: string;
  latest_version: number;
  deleted_at: Date | null;
  created_at: Date;
  target_version: number | null;
}

export interface PointInTimePlanEntry {
  secretId: string;
  key: string;
  path: string;
  action: "restore" | "revive" | "delete" | "none";
  revive: boolean;
  currentVersion: number;
  targetVersion: number | null;
}

export async function loadPointInTime(
  deps: Deps,
  projectId: string,
  environmentId: string,
  at: Date,
): Promise<PointInTimeRow[]> {
  return deps.sql<PointInTimeRow[]>`
    select
      s.id,
      s.key,
      s.path,
      s.latest_version,
      s.deleted_at,
      s.created_at,
      (
        select v.version
        from secret_versions v
        where v.secret_id = s.id and v.created_at <= ${at.toISOString()}::timestamptz
        order by v.version desc
        limit 1
      ) as target_version
    from secrets s
    where s.project_id = ${projectId} and s.environment_id = ${environmentId}
    order by s.path, s.key
  `;
}

export function buildPointInTimePlan(rows: PointInTimeRow[], at: Date): PointInTimePlanEntry[] {
  return rows.map((row) => {
    const target = row.target_version;
    const deletedAt = row.deleted_at;
    let action: PointInTimePlanEntry["action"] = "none";
    let revive = false;

    if (target === null) {
      // No version existed yet at `at`: the secret must not be present now.
      if (deletedAt === null) action = "delete";
    } else if (deletedAt !== null && deletedAt.getTime() <= at.getTime()) {
      // It was already deleted at `at`, so absence is the correct state.
      action = "none";
    } else {
      revive = deletedAt !== null;
      if (target !== row.latest_version) action = "restore";
      else if (revive) action = "revive";
    }

    return {
      secretId: row.id,
      key: row.key,
      path: row.path,
      action,
      revive,
      currentVersion: row.latest_version,
      targetVersion: target,
    };
  });
}

export async function applyPointInTimePlan(
  deps: Deps,
  project: ProjectRow,
  environment: EnvironmentRow,
  actor: ActorMeta,
  at: Date,
  plan: PointInTimePlanEntry[],
): Promise<{ restored: number; revived: number; deleted: number }> {
  let restored = 0;
  let revived = 0;
  let deleted = 0;
  const note = `restore to ${at.toISOString()}`;

  for (const entry of plan) {
    if (entry.action === "restore") {
      if (entry.revive) {
        await deps.db
          .update(secrets)
          .set({ deletedAt: null })
          .where(eq(secrets.id, entry.secretId));
      }
      if (entry.targetVersion === null) throw badRequest("missing restore target version");
      await applySecretRollback(deps, project, environment, actor, {
        key: entry.key,
        path: entry.path,
        targetVersion: entry.targetVersion,
        note,
      });
      restored += 1;
    } else if (entry.action === "revive") {
      await deps.db.update(secrets).set({ deletedAt: null }).where(eq(secrets.id, entry.secretId));
      revived += 1;
    } else if (entry.action === "delete") {
      await applySecretDelete(deps, project.id, environment.id, entry.path, entry.key);
      deleted += 1;
    }
  }

  return { restored, revived, deleted };
}

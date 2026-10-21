import { and, eq, isNull } from "drizzle-orm";
import { decryptValue, secretAad } from "./crypto.js";
import { projectDek } from "./access.js";
import { environmentImports, environments, secretVersions, secrets } from "./db/schema.js";
import type { EnvironmentRow, ProjectRow } from "./db/schema.js";
import { resolveReferences } from "./references.js";
import type { Deps } from "./types.js";

export interface LoadedSecret {
  key: string;
  path: string;
  value: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  importedFrom?: string;
}

export interface LoadOptions {
  allowedEnvironmentIds?: string[];
}

/**
 * Loads secrets for an environment, merging imported environments (own values win).
 * References are resolved against the merged set.
 */
export async function loadEnvironmentSecrets(
  deps: Deps,
  project: ProjectRow,
  root: EnvironmentRow,
  options: LoadOptions = {},
): Promise<LoadedSecret[]> {
  const merged = new Map<string, LoadedSecret>();
  const visited = new Set<string>();
  const dek = projectDek(deps, project);

  const collect = async (environmentId: string, isRoot: boolean): Promise<void> => {
    if (visited.has(environmentId)) return;
    visited.add(environmentId);

    const rows = await deps.db
      .select({ secret: secrets, version: secretVersions })
      .from(secrets)
      .innerJoin(
        secretVersions,
        and(
          eq(secretVersions.secretId, secrets.id),
          eq(secretVersions.version, secrets.latestVersion),
        ),
      )
      .where(
        and(
          eq(secrets.projectId, project.id),
          eq(secrets.environmentId, environmentId),
          isNull(secrets.deletedAt),
        ),
      );

    let sourceSlug: string | undefined;
    if (!isRoot) {
      const sourceRows = await deps.db
        .select({ slug: environments.slug })
        .from(environments)
        .where(eq(environments.id, environmentId))
        .limit(1);
      sourceSlug = sourceRows[0]?.slug;
    }

    for (const row of rows) {
      const id = `${row.secret.path}:${row.secret.key}`;
      if (merged.has(id)) continue;
      const value = decryptValue(
        dek,
        { ciphertext: row.version.ciphertext, iv: row.version.iv, tag: row.version.tag },
        secretAad(row.secret.id, row.version.version),
      );
      merged.set(id, {
        key: row.secret.key,
        path: row.secret.path,
        value,
        version: row.version.version,
        createdAt: row.version.createdAt,
        updatedAt: row.secret.updatedAt,
        importedFrom: sourceSlug,
      });
    }

    const imports = await deps.db
      .select()
      .from(environmentImports)
      .where(eq(environmentImports.targetEnvironmentId, environmentId));

    for (const entry of imports) {
      if (
        options.allowedEnvironmentIds &&
        !options.allowedEnvironmentIds.includes(entry.sourceEnvironmentId)
      ) {
        continue;
      }
      await collect(entry.sourceEnvironmentId, false);
    }
  };

  await collect(root.id, true);

  const resolved = resolveReferences(Array.from(merged.values()));
  return Array.from(merged.values()).map((secret) => ({
    ...secret,
    value: resolved.get(`${secret.path}:${secret.key}`) ?? secret.value,
  }));
}

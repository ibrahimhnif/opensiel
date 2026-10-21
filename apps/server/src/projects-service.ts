import { generateDek, wrapDek } from "./crypto.js";
import type { ProjectRow } from "./db/schema.js";
import { environments, projects } from "./db/schema.js";
import { slugify, uniqueProjectSlug } from "./access.js";
import type { Deps } from "./types.js";

export const DEFAULT_ENVIRONMENTS = [
  { name: "Development", slug: "dev", position: 0 },
  { name: "Staging", slug: "staging", position: 1 },
  { name: "Production", slug: "prod", position: 2 },
];

export async function createProject(deps: Deps, orgId: string, name: string): Promise<ProjectRow> {
  const dek = generateDek();
  const wrapped = wrapDek(deps.env.masterKey, dek);
  const slug = await uniqueProjectSlug(deps.db, orgId, slugify(name));

  const inserted = await deps.db
    .insert(projects)
    .values({
      orgId,
      name,
      slug,
      dekWrapped: wrapped.wrapped,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
    })
    .returning();

  const project = inserted[0];
  await deps.db.insert(environments).values(
    DEFAULT_ENVIRONMENTS.map((env) => ({
      projectId: project.id,
      name: env.name,
      slug: env.slug,
      position: env.position,
    })),
  );
  return project;
}

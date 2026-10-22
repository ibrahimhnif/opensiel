import { and, count, eq, isNull } from "drizzle-orm";
import type { EnvironmentDto, ProjectDto } from "@opensiel/shared";
import { AppError, badRequest, forbidden, notFound } from "./errors.js";
import { unwrapDek } from "./crypto.js";
import { hasPermission } from "./permissions.js";
import type { Db } from "./db/client.js";
import { environments, orgs, projects, secrets } from "./db/schema.js";
import type { EnvironmentRow, ProjectRow } from "./db/schema.js";
import type { Actor, Deps, MachineActor } from "./types.js";

export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "item";
}

export function normalizePath(input?: string): string {
  if (!input) return "/";
  let path = input.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+/g, "/").replace(/\/+$/, "");
  if (!path) return "/";
  if (path.includes("..")) throw badRequest("invalid secret path");
  if (!/^(\/[A-Za-z0-9._-]+)+$/.test(path)) throw badRequest("invalid secret path");
  return path;
}

export async function uniqueProjectSlug(db: Db, orgId: string, base: string): Promise<string> {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, candidate)))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw badRequest("could not allocate a project slug");
}

export async function uniqueOrgSlug(db: Db, base: string): Promise<string> {
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const existing = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw badRequest("could not allocate an organization slug");
}

export async function loadProject(
  deps: Deps,
  actor: Actor,
  projectId: string,
): Promise<ProjectRow> {
  const rows = await deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) throw notFound("project not found");
  if (actor.type === "machine") {
    if (project.id !== actor.projectId) throw notFound("project not found");
  } else if (project.orgId !== actor.orgId) {
    throw notFound("project not found");
  }
  return project;
}

export async function loadEnvironment(
  deps: Deps,
  projectId: string,
  slug: string,
): Promise<EnvironmentRow> {
  const rows = await deps.db
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.slug, slug)))
    .limit(1);
  const environment = rows[0];
  if (!environment) throw notFound(`environment '${slug}' not found`);
  return environment;
}

export function assertCanWrite(actor: Actor): void {
  if (!hasPermission(actor, "secret:write")) throw forbidden("role is read-only");
}

export function assertCanAdmin(actor: Actor): void {
  if (actor.type !== "user" || !hasPermission(actor, "project:create")) {
    throw forbidden("owner or admin role required");
  }
}

export function assertOwner(actor: Actor): void {
  if (actor.type !== "user" || !hasPermission(actor, "org:manage")) {
    throw forbidden("owner role required");
  }
}

export function assertEnvScope(actor: MachineActor, environmentId: string): void {
  if (!actor.envIds.includes(environmentId)) {
    throw forbidden("identity is not scoped to this environment");
  }
}

export function projectDek(deps: Deps, project: ProjectRow): Buffer {
  const key =
    project.kekVersion === deps.env.masterKeyVersion
      ? deps.env.masterKey
      : project.kekVersion === deps.env.nextMasterKeyVersion
        ? deps.env.nextMasterKey
        : undefined;
  if (!key) {
    throw new AppError(
      500,
      `master key version ${project.kekVersion} is not configured`,
      "missing_key_version",
    );
  }
  return unwrapDek(key, {
    wrapped: project.dekWrapped,
    iv: project.dekIv,
    tag: project.dekTag,
  });
}

export function toEnvironmentDto(environment: EnvironmentRow): EnvironmentDto {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    position: environment.position,
    approvalRequired: environment.approvalRequired,
    requiredApprovals: environment.requiredApprovals,
  };
}

export function toProjectDto(project: ProjectRow, envs: EnvironmentRow[]): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    createdAt: project.createdAt.toISOString(),
    environments: envs
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(toEnvironmentDto),
  };
}

export async function countSecrets(deps: Deps, environmentId: string): Promise<number> {
  const rows = await deps.db
    .select({ total: count() })
    .from(secrets)
    .where(and(eq(secrets.environmentId, environmentId), isNull(secrets.deletedAt)));
  return Number(rows[0]?.total ?? 0);
}

import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createEnvironmentSchema,
  createProjectSchema,
  slugSchema,
  updateProjectSchema,
} from "@opensiel/shared";
import { requireActor } from "../auth.js";
import {
  assertCanAdmin,
  assertOwner,
  countSecrets,
  loadProject,
  toProjectDto,
  uniqueProjectSlug,
  slugify,
} from "../access.js";
import { parse, conflict, notFound } from "../errors.js";
import { environments, projects } from "../db/schema.js";
import { createProject } from "../projects-service.js";
import { writeAudit } from "../audit.js";
import type { Actor, Deps } from "../types.js";

async function projectDtoFor(deps: Deps, projectId: string) {
  const rows = await deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const project = rows[0];
  if (!project) throw notFound("project not found");
  const envs = await deps.db
    .select()
    .from(environments)
    .where(eq(environments.projectId, project.id));
  return toProjectDto(project, envs);
}

function audit(
  deps: Deps,
  actor: Actor,
  action: string,
  projectId: string,
  resourceId: string,
  ip: string,
) {
  return writeAudit(deps, {
    orgId: actor.orgId,
    projectId,
    actorType: actor.type,
    actorId: actor.id,
    actorName: actor.name,
    action,
    resourceType: "project",
    resourceId,
    ip,
  });
}

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/projects", async (request) => {
    const actor = await requireActor(deps, request);
    const rows =
      actor.type === "machine"
        ? await deps.db.select().from(projects).where(eq(projects.id, actor.projectId))
        : await deps.db.select().from(projects).where(eq(projects.orgId, actor.orgId));

    if (rows.length === 0) return { projects: [] };
    const envs = await deps.db
      .select()
      .from(environments)
      .where(
        inArray(
          environments.projectId,
          rows.map((project) => project.id),
        ),
      );

    return {
      projects: rows.map((project) =>
        toProjectDto(
          project,
          envs.filter((environment) => environment.projectId === project.id),
        ),
      ),
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const input = parse(createProjectSchema, request.body);
    const project = await createProject(deps, actor.orgId, input.name);
    await audit(deps, actor, "project.create", project.id, project.id, request.ip);
    return reply.code(201).send({ project: await projectDtoFor(deps, project.id) });
  });

  app.get("/api/projects/:projectId", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    await loadProject(deps, actor, projectId);
    return { project: await projectDtoFor(deps, projectId) };
  });

  app.patch("/api/projects/:projectId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(updateProjectSchema, request.body);
    const slug = await uniqueProjectSlug(deps.db, actor.orgId, slugify(input.name));
    await deps.db
      .update(projects)
      .set({ name: input.name, slug })
      .where(eq(projects.id, project.id));
    await audit(deps, actor, "project.update", project.id, project.id, request.ip);
    return { project: await projectDtoFor(deps, project.id) };
  });

  app.delete("/api/projects/:projectId", async (request) => {
    const actor = await requireActor(deps, request);
    assertOwner(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    await deps.db.delete(projects).where(eq(projects.id, project.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      projectId: null,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: "project.delete",
      resourceType: "project",
      resourceId: project.id,
      metadata: { name: project.name, slug: project.slug },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/api/projects/:projectId/environments", async (request) => {
    const actor = await requireActor(deps, request);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const rows = await deps.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, project.id));
    return {
      environments: rows.slice().sort((a, b) => a.position - b.position),
    };
  });

  app.post("/api/projects/:projectId/environments", async (request, reply) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId } = request.params as { projectId: string };
    const project = await loadProject(deps, actor, projectId);
    const input = parse(createEnvironmentSchema, request.body);
    const slug = input.slug ?? slugify(input.name);
    parse(slugSchema, slug);

    const existing = await deps.db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, project.id), eq(environments.slug, slug)))
      .limit(1);
    if (existing.length > 0) throw conflict("environment already exists");

    const all = await deps.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, project.id));
    const position = all.reduce((max, env) => Math.max(max, env.position), -1) + 1;

    const inserted = await deps.db
      .insert(environments)
      .values({ projectId: project.id, name: input.name, slug, position })
      .returning();
    await audit(deps, actor, "environment.create", project.id, inserted[0].id, request.ip);
    return reply.code(201).send({ environment: inserted[0] });
  });

  app.delete("/api/projects/:projectId/environments/:environmentId", async (request) => {
    const actor = await requireActor(deps, request);
    assertCanAdmin(actor);
    const { projectId, environmentId } = request.params as {
      projectId: string;
      environmentId: string;
    };
    const project = await loadProject(deps, actor, projectId);
    const rows = await deps.db
      .select()
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.projectId, project.id)))
      .limit(1);
    const environment = rows[0];
    if (!environment) throw notFound("environment not found");

    const used = await countSecrets(deps, environment.id);
    if (used > 0) throw conflict("environment still contains secrets");

    const remaining = await deps.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, project.id));
    if (remaining.length <= 1) throw conflict("a project needs at least one environment");

    await deps.db.delete(environments).where(eq(environments.id, environment.id));
    await audit(deps, actor, "environment.delete", project.id, environment.id, request.ip);
    return { ok: true };
  });
}

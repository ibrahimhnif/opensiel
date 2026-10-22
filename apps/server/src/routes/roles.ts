import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createCustomRoleSchema, createRoleGrantSchema } from "@opensiel/shared";
import type { CustomRoleDto, GrantablePermission, RoleGrantDto } from "@opensiel/shared";
import { requireActor, requireUser } from "../auth.js";
import { assertCanAdmin, normalizePath } from "../access.js";
import { badRequest, conflict, notFound, parse } from "../errors.js";
import {
  customRoles,
  environments,
  orgMembers,
  projects,
  roleGrants,
  users,
} from "../db/schema.js";
import type { CustomRoleRow, RoleGrantRow } from "../db/schema.js";
import { writeAudit } from "../audit.js";
import type { Deps } from "../types.js";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
  );
}

function roleDto(row: CustomRoleRow): CustomRoleDto {
  return {
    id: row.id,
    name: row.name,
    permissions: row.permissions as GrantablePermission[],
    createdAt: row.createdAt.toISOString(),
  };
}

function grantDto(grant: RoleGrantRow, role: CustomRoleRow, user: { name: string }): RoleGrantDto {
  return {
    id: grant.id,
    userId: grant.userId,
    userName: user.name,
    roleId: grant.roleId,
    roleName: role.name,
    permissions: role.permissions,
    projectId: grant.projectId,
    environmentId: grant.environmentId,
    path: grant.path,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
  };
}

export function registerRoleRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/api/org/roles", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    const rows = await deps.db
      .select()
      .from(customRoles)
      .where(eq(customRoles.orgId, actor.orgId))
      .orderBy(customRoles.name);
    return { roles: rows.map(roleDto) };
  });

  app.post("/api/org/roles", async (request, reply) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);
    const input = parse(createCustomRoleSchema, request.body);

    let role: CustomRoleRow;
    try {
      const inserted = await deps.db
        .insert(customRoles)
        .values({
          orgId: actor.orgId,
          name: input.name,
          permissions: input.permissions,
        })
        .returning();
      role = inserted[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("a role with that name already exists");
      throw error;
    }

    await writeAudit(deps, {
      orgId: actor.orgId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "org.role.create",
      resourceType: "role",
      resourceId: role.id,
      metadata: { name: role.name, permissions: role.permissions },
      ip: request.ip,
    });

    return reply.code(201).send({ role: roleDto(role) });
  });

  app.delete("/api/org/roles/:roleId", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);
    const { roleId } = request.params as { roleId: string };

    const rows = await deps.db
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.id, roleId), eq(customRoles.orgId, actor.orgId)))
      .limit(1);
    const role = rows[0];
    if (!role) throw notFound("role not found");

    await deps.db.delete(customRoles).where(eq(customRoles.id, role.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "org.role.delete",
      resourceType: "role",
      resourceId: role.id,
      metadata: { name: role.name },
      ip: request.ip,
    });
    return { ok: true };
  });

  app.get("/api/org/grants", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);

    const rows = await deps.db
      .select({ grant: roleGrants, role: customRoles, user: users })
      .from(roleGrants)
      .innerJoin(customRoles, eq(customRoles.id, roleGrants.roleId))
      .innerJoin(users, eq(users.id, roleGrants.userId))
      .where(eq(roleGrants.orgId, actor.orgId))
      .orderBy(roleGrants.createdAt);

    return {
      grants: rows.map((row) => grantDto(row.grant, row.role, row.user)),
    };
  });

  app.post("/api/org/grants", async (request, reply) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);
    const input = parse(createRoleGrantSchema, request.body);

    const roleRows = await deps.db
      .select()
      .from(customRoles)
      .where(and(eq(customRoles.id, input.roleId), eq(customRoles.orgId, actor.orgId)))
      .limit(1);
    const role = roleRows[0];
    if (!role) throw badRequest("role not found in this organization");

    const memberRows = await deps.db
      .select({ user: users })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, input.userId)))
      .limit(1);
    const member = memberRows[0];
    if (!member) throw badRequest("user is not a member of this organization");

    let projectId = input.projectId;
    if (input.environmentId) {
      const envRows = await deps.db
        .select({ environment: environments, project: projects })
        .from(environments)
        .innerJoin(projects, eq(projects.id, environments.projectId))
        .where(eq(environments.id, input.environmentId))
        .limit(1);
      const env = envRows[0];
      if (!env || env.project.orgId !== actor.orgId) {
        throw badRequest("environment not found in this organization");
      }
      if (projectId && projectId !== env.project.id) {
        throw badRequest("environment does not belong to the selected project");
      }
      projectId = env.project.id;
    } else if (projectId) {
      const projectRows = await deps.db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.orgId, actor.orgId)))
        .limit(1);
      if (!projectRows[0]) throw badRequest("project not found in this organization");
    }

    let expiresAt: Date | undefined;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (expiresAt.getTime() <= Date.now()) {
        throw badRequest("expiresAt must be in the future");
      }
    }

    const inserted = await deps.db
      .insert(roleGrants)
      .values({
        orgId: actor.orgId,
        roleId: role.id,
        userId: input.userId,
        projectId: projectId ?? null,
        environmentId: input.environmentId ?? null,
        path: input.path ? normalizePath(input.path) : null,
        expiresAt: expiresAt ?? null,
        createdBy: actor.id,
      })
      .returning();

    await writeAudit(deps, {
      orgId: actor.orgId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "org.grant.create",
      resourceType: "role_grant",
      resourceId: inserted[0].id,
      metadata: {
        userId: input.userId,
        role: role.name,
        permissions: role.permissions,
        projectId: projectId ?? null,
        environmentId: input.environmentId ?? null,
        path: input.path ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
      ip: request.ip,
    });

    return reply.code(201).send({ grant: grantDto(inserted[0], role, member.user) });
  });

  app.delete("/api/org/grants/:grantId", async (request) => {
    const actor = requireUser(await requireActor(deps, request));
    assertCanAdmin(actor);
    const { grantId } = request.params as { grantId: string };

    const rows = await deps.db
      .select()
      .from(roleGrants)
      .where(and(eq(roleGrants.id, grantId), eq(roleGrants.orgId, actor.orgId)))
      .limit(1);
    const grant = rows[0];
    if (!grant) throw notFound("grant not found");

    await deps.db.delete(roleGrants).where(eq(roleGrants.id, grant.id));
    await writeAudit(deps, {
      orgId: actor.orgId,
      actorType: "user",
      actorId: actor.id,
      actorName: actor.name,
      action: "org.grant.delete",
      resourceType: "role_grant",
      resourceId: grant.id,
      metadata: { userId: grant.userId, roleId: grant.roleId },
      ip: request.ip,
    });
    return { ok: true };
  });
}

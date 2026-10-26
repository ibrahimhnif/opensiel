import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { IdentityRole, Role } from "@opensiel/shared";
import { customRoles, roleGrants } from "./db/schema.js";
import type { Actor, Deps } from "./types.js";
import { forbidden } from "./errors.js";

export type Permission =
  | "secret:read"
  | "secret:write"
  | "secret:delete"
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "environment:manage"
  | "identity:manage"
  | "webhook:manage"
  | "approval:decide"
  | "rotation:manage"
  | "transit:manage"
  | "audit:read"
  | "member:manage"
  | "org:manage";

const ALL_PERMISSIONS: Permission[] = [
  "secret:read",
  "secret:write",
  "secret:delete",
  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "environment:manage",
  "identity:manage",
  "webhook:manage",
  "approval:decide",
  "rotation:manage",
  "transit:manage",
  "audit:read",
  "member:manage",
  "org:manage",
];

const USER_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter(
    (permission) => permission !== "org:manage" && permission !== "project:delete",
  ),
  member: ["secret:read", "secret:write", "secret:delete", "project:read", "audit:read"],
  viewer: ["secret:read", "project:read", "audit:read"],
};

const MACHINE_PERMISSIONS: Record<IdentityRole, Permission[]> = {
  member: ["secret:read", "secret:write"],
  viewer: ["secret:read"],
};

export const GRANTABLE_PERMISSIONS: Permission[] = [
  "secret:read",
  "secret:write",
  "secret:delete",
  "project:read",
  "audit:read",
];

export function hasPermission(actor: Actor, permission: Permission): boolean {
  const permissions =
    actor.type === "user" ? USER_PERMISSIONS[actor.role] : MACHINE_PERMISSIONS[actor.role];
  return permissions.includes(permission);
}

export function builtinPermissions(actor: Actor): Permission[] {
  return actor.type === "user"
    ? [...USER_PERMISSIONS[actor.role]]
    : [...MACHINE_PERMISSIONS[actor.role]];
}

export interface GrantScope {
  projectId?: string;
  environmentId?: string;
  path?: string;
}

function pathMatches(grantPath: string, targetPath: string | undefined): boolean {
  const path = targetPath ?? "/";
  return grantPath === path;
}

export async function grantedPermissions(
  deps: Deps,
  actor: Actor,
  scope: GrantScope,
): Promise<Set<Permission>> {
  const result = new Set<Permission>();
  if (actor.type !== "user") return result;

  const rows = await deps.db
    .select({ grant: roleGrants, role: customRoles })
    .from(roleGrants)
    .innerJoin(customRoles, eq(customRoles.id, roleGrants.roleId))
    .where(
      and(
        eq(roleGrants.orgId, actor.orgId),
        eq(roleGrants.userId, actor.id),
        or(isNull(roleGrants.expiresAt), gt(roleGrants.expiresAt, new Date())),
      ),
    );

  for (const row of rows) {
    if (row.grant.projectId && row.grant.projectId !== scope.projectId) continue;
    if (row.grant.environmentId && row.grant.environmentId !== scope.environmentId) continue;
    if (row.grant.path && !pathMatches(row.grant.path, scope.path)) continue;
    for (const permission of row.role.permissions) {
      result.add(permission as Permission);
    }
  }
  return result;
}

export async function hasGrantedPermission(
  deps: Deps,
  actor: Actor,
  permission: Permission,
  scope: GrantScope,
): Promise<boolean> {
  const permissions = await grantedPermissions(deps, actor, scope);
  return permissions.has(permission);
}

export async function assertSecretPermission(
  deps: Deps,
  actor: Actor,
  permission: "secret:write" | "secret:delete",
  scope: GrantScope,
): Promise<void> {
  if (hasPermission(actor, permission)) return;
  if (await hasGrantedPermission(deps, actor, permission, scope)) return;
  throw forbidden("you do not have access to write to this environment");
}

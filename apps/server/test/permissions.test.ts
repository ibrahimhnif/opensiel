import { describe, expect, it } from "vitest";
import type { IdentityRole, Role } from "@opensiel/shared";
import { hasPermission } from "../src/permissions.js";
import type { MachineActor, UserActor } from "../src/types.js";

function user(role: Role): UserActor {
  return {
    type: "user",
    id: "user-1",
    name: "User",
    email: "user@test.dev",
    role,
    orgId: "org-1",
    orgName: "Org",
  };
}

function machine(role: IdentityRole): MachineActor {
  return {
    type: "machine",
    id: "identity-1",
    name: "Identity",
    role,
    projectId: "project-1",
    orgId: "org-1",
    envIds: [],
  };
}

describe("built-in permissions", () => {
  it("keeps owner-only capabilities owner-only", () => {
    expect(hasPermission(user("owner"), "org:manage")).toBe(true);
    expect(hasPermission(user("owner"), "project:delete")).toBe(true);
    expect(hasPermission(user("admin"), "org:manage")).toBe(false);
    expect(hasPermission(user("admin"), "project:delete")).toBe(false);
    expect(hasPermission(user("admin"), "project:create")).toBe(true);
    expect(hasPermission(user("member"), "identity:manage")).toBe(false);
  });

  it("maps secret access per role", () => {
    expect(hasPermission(user("member"), "secret:write")).toBe(true);
    expect(hasPermission(user("member"), "secret:delete")).toBe(true);
    expect(hasPermission(user("viewer"), "secret:write")).toBe(false);
    expect(hasPermission(user("viewer"), "secret:delete")).toBe(false);
    expect(hasPermission(user("viewer"), "secret:read")).toBe(true);
  });

  it("limits machine identities to secret access", () => {
    expect(hasPermission(machine("member"), "secret:write")).toBe(true);
    expect(hasPermission(machine("member"), "project:create")).toBe(false);
    expect(hasPermission(machine("viewer"), "secret:write")).toBe(false);
    expect(hasPermission(machine("viewer"), "secret:read")).toBe(true);
  });
});

import type { IdentityRole, Role } from "@opensiel/shared";
import type { Db, Sql } from "./db/client.js";
import type { Env } from "./env.js";

export interface Deps {
  env: Env;
  db: Db;
  sql: Sql;
}

export interface UserActor {
  type: "user";
  id: string;
  name: string;
  email: string;
  role: Role;
  orgId: string;
  orgName: string;
}

export interface MachineActor {
  type: "machine";
  id: string;
  name: string;
  role: IdentityRole;
  projectId: string;
  orgId: string;
  envIds: string[];
}

export type Actor = UserActor | MachineActor;

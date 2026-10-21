import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ChangeRequestAction,
  ChangeRequestStatus,
  IdentityRole,
  Role,
} from "@opensiel/shared";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_uq").on(table.email)],
);

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("orgs_slug_uq").on(table.slug)],
);

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("org_members_user_idx").on(table.userId),
  ],
);

export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_invites_token_hash_uq").on(table.tokenHash),
    index("org_invites_org_idx").on(table.orgId),
    uniqueIndex("org_invites_pending_uq")
      .on(table.orgId, table.email)
      .where(sql`${table.acceptedAt} is null`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    dekWrapped: text("dek_wrapped").notNull(),
    dekIv: text("dek_iv").notNull(),
    dekTag: text("dek_tag").notNull(),
    kekVersion: integer("kek_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("projects_org_slug_uq").on(table.orgId, table.slug)],
);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    position: integer("position").notNull().default(0),
    approvalRequired: boolean("approval_required").notNull().default(false),
    requiredApprovals: integer("required_approvals").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("environments_project_slug_uq").on(table.projectId, table.slug)],
);

export const environmentImports = pgTable("environment_imports", {
  targetEnvironmentId: uuid("target_environment_id")
    .primaryKey()
    .references(() => environments.id, { onDelete: "cascade" }),
  sourceEnvironmentId: uuid("source_environment_id")
    .notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    path: text("path").notNull().default("/"),
    key: text("key").notNull(),
    latestVersion: integer("latest_version").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("secrets_active_uq")
      .on(table.projectId, table.environmentId, table.path, table.key)
      .where(sql`${table.deletedAt} is null`),
    index("secrets_lookup_idx").on(table.projectId, table.environmentId),
  ],
);

export const secretVersions = pgTable(
  "secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    fingerprint: text("fingerprint").notNull(),
    comment: text("comment"),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("secret_versions_secret_version_uq").on(table.secretId, table.version)],
);

export const identities = pgTable(
  "identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientId: text("client_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    role: text("role").$type<IdentityRole>().notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("identities_client_id_uq").on(table.clientId),
    index("identities_project_idx").on(table.projectId),
  ],
);

export const identityScopes = pgTable(
  "identity_scopes",
  {
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.identityId, table.environmentId] })],
);

export const changeRequests = pgTable(
  "change_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    action: text("action").$type<ChangeRequestAction>().notNull(),
    secretKey: text("secret_key").notNull(),
    path: text("path").notNull(),
    targetVersion: integer("target_version"),
    payloadCiphertext: text("payload_ciphertext"),
    payloadIv: text("payload_iv"),
    payloadTag: text("payload_tag"),
    comment: text("comment"),
    status: text("status").$type<ChangeRequestStatus>().notNull().default("pending"),
    requestedByType: text("requested_by_type").notNull(),
    requestedById: text("requested_by_id").notNull(),
    requestedByName: text("requested_by_name").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
  },
  (table) => [
    index("change_requests_project_status_idx").on(
      table.projectId,
      table.status,
      table.requestedAt,
    ),
    index("change_requests_environment_idx").on(table.environmentId, table.status),
  ],
);

export const changeRequestApprovals = pgTable(
  "change_request_approvals",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => changeRequests.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.userId] })],
);

export const dynamicSecretConfigs = pgTable(
  "dynamic_secret_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("postgres"),
    adminUrlCiphertext: text("admin_url_ciphertext").notNull(),
    adminUrlIv: text("admin_url_iv").notNull(),
    adminUrlTag: text("admin_url_tag").notNull(),
    creationStatement: text("creation_statement").notNull(),
    revocationStatement: text("revocation_statement").notNull(),
    ttlSeconds: integer("ttl_seconds").notNull().default(3600),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dynamic_secret_configs_project_name_uq").on(table.projectId, table.name),
  ],
);

export const dynamicSecretLeases = pgTable(
  "dynamic_secret_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configId: uuid("config_id")
      .notNull()
      .references(() => dynamicSecretConfigs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByType: text("created_by_type").notNull(),
    createdById: text("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("dynamic_secret_leases_config_idx").on(table.configId, table.expiresAt)],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhooks_project_idx").on(table.projectId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_org_created_idx").on(table.orgId, table.createdAt),
    index("audit_logs_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type SecretVersionRow = typeof secretVersions.$inferSelect;
export type IdentityRow = typeof identities.$inferSelect;
export type ChangeRequestRow = typeof changeRequests.$inferSelect;
export type DynamicSecretConfigRow = typeof dynamicSecretConfigs.$inferSelect;
export type DynamicSecretLeaseRow = typeof dynamicSecretLeases.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;

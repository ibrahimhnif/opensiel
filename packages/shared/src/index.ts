import { z } from "zod";

export const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const identityRoleSchema = z.enum(["member", "viewer"]);
export type IdentityRole = z.infer<typeof identityRoleSchema>;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(12, "password must be at least 12 characters")
  .max(200);
export const nameSchema = z.string().trim().min(1).max(100);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "invalid slug");

export const secretKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "key must look like an environment variable name")
  .max(200);

export const secretPathSchema = z
  .string()
  .trim()
  .max(200)
  .refine((p) => p === "/" || /^(\/[A-Za-z0-9._-]+)+$/.test(p), "invalid secret path");

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
  orgName: nameSchema.optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createProjectSchema = z.object({ name: nameSchema });
export const updateProjectSchema = z.object({ name: nameSchema });

export const createEnvironmentSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
});

export const setSecretSchema = z.object({
  key: secretKeySchema,
  value: z.string().max(100_000),
  env: slugSchema,
  path: secretPathSchema.optional(),
  comment: z.string().max(500).optional(),
});
export type SetSecretInput = z.infer<typeof setSecretSchema>;

export const rollbackSchema = z.object({
  version: z.number().int().positive(),
  env: slugSchema,
  path: secretPathSchema.optional(),
});

export const importSecretsSchema = z.object({
  env: slugSchema,
  path: secretPathSchema.optional(),
  format: z.enum(["env", "json"]).default("env"),
  contents: z.string().min(1).max(256_000),
  comment: z.string().max(500).optional(),
  dryRun: z.boolean().optional(),
});
export type ImportSecretsInput = z.infer<typeof importSecretsSchema>;

export interface ImportSecretsResult {
  dryRun: boolean;
  keys: string[];
  created: number;
  updated: number;
  imported: { key: string; version: number }[];
}

export const scanSchema = z.object({
  contents: z.string().min(1).max(256_000),
});
export type ScanInput = z.infer<typeof scanSchema>;

export interface ScanFinding {
  type: "stored-secret" | "pattern";
  name: string;
  environment?: string;
  path?: string;
  line: number;
  preview: string;
}

export interface ScanResult {
  findings: ScanFinding[];
  characters: number;
  scannedEnvironments: number;
  scannedSecrets: number;
}

export const createDynamicConfigSchema = z.object({
  name: nameSchema,
  adminUrl: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "must be a postgres:// URL"),
  creationStatement: z.string().min(1).max(4000).optional(),
  revocationStatement: z.string().min(1).max(4000).optional(),
  ttlSeconds: z.number().int().min(60).max(86_400).optional(),
});
export type CreateDynamicConfigInput = z.infer<typeof createDynamicConfigSchema>;

export interface DynamicConfigDto {
  id: string;
  name: string;
  provider: string;
  ttlSeconds: number;
  createdAt: string;
}

export type DynamicLeaseStatus = "active" | "expired" | "revoked";

export interface DynamicLeaseDto {
  id: string;
  configId: string;
  configName: string;
  username: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdByName: string;
  status: DynamicLeaseStatus;
}

export interface CreatedLeaseDto {
  lease: DynamicLeaseDto;
  username: string;
  password: string;
  host: string;
  database: string;
}

export const webhookEvents = [
  "secret.created",
  "secret.updated",
  "secret.deleted",
  "secret.rollback",
  "secret.import",
  "secret.restore",
  "change_request.created",
  "change_request.approved",
  "change_request.rejected",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

export const createWebhookSchema = z.object({
  url: z.string().url().max(2000),
  secret: z.string().min(16).max(200).optional(),
  events: z.array(z.enum(webhookEvents)).min(1),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  enabled: z.boolean(),
});

export interface WebhookDto {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  failureCount: number;
  createdAt: string;
}

export const identityIpSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, "use an IP address or CIDR range");

export const createIdentitySchema = z.object({
  name: nameSchema,
  role: identityRoleSchema.default("viewer"),
  environmentIds: z.array(z.string().uuid()).min(1, "pick at least one environment"),
  tokenTtlSeconds: z.number().int().min(60).max(86_400).optional(),
  ipAllowlist: z.array(identityIpSchema).max(50).nullable().optional(),
  hourlyTokenCap: z.number().int().min(1).max(100_000).nullable().optional(),
});
export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;

export const updateIdentitySchema = z.object({
  name: nameSchema.optional(),
  role: identityRoleSchema.optional(),
  environmentIds: z.array(z.string().uuid()).min(1).optional(),
  tokenTtlSeconds: z.number().int().min(60).max(86_400).optional(),
  ipAllowlist: z.array(identityIpSchema).max(50).nullable().optional(),
  hourlyTokenCap: z.number().int().min(1).max(100_000).nullable().optional(),
});
export type UpdateIdentityInput = z.infer<typeof updateIdentitySchema>;

export const tokenRequestSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
});
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const identityJwtTokenSchema = z.object({
  clientId: z.string().min(1).max(200),
  jwt: z.string().min(20).max(20_000),
});
export type IdentityJwtTokenInput = z.infer<typeof identityJwtTokenSchema>;

export const createIdentityAuthMethodSchema = z.object({
  type: z.literal("jwt").default("jwt"),
  issuer: z.string().url().max(500),
  audience: z.string().min(1).max(500),
  jwksUri: z.string().url().max(500),
  allowedSubjects: z.array(z.string().min(1).max(500)).max(50).optional(),
});
export type CreateIdentityAuthMethodInput = z.infer<typeof createIdentityAuthMethodSchema>;

export interface IdentityAuthMethodDto {
  id: string;
  type: string;
  issuer: string;
  audience: string;
  jwksUri: string;
  allowedSubjects: string[] | null;
  createdAt: string;
}

export const rotationHttpConfigSchema = z.object({
  createUrl: z.string().url().max(2000),
  revokeUrl: z.string().url().max(2000).optional(),
  headers: z.record(z.string()).optional(),
  valueTemplate: z.string().max(2000).optional(),
});
export type RotationHttpConfig = z.infer<typeof rotationHttpConfigSchema>;

const roleNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "use a valid PostgreSQL role name");

export const rotationPostgresConfigSchema = z.object({
  adminUrl: z
    .string()
    .max(4000)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "must be a postgres:// URL"),
  username: roleNameSchema,
  alternateUsername: roleNameSchema,
  valueTemplate: z.string().max(2000).default("{{username}}:{{password}}"),
  ssl: z.boolean().optional(),
});
export type RotationPostgresConfig = z.infer<typeof rotationPostgresConfigSchema>;

export const createRotationSchema = z
  .object({
    key: secretKeySchema,
    env: slugSchema,
    path: secretPathSchema.optional(),
    provider: z.enum(["http", "postgres"]),
    config: z.record(z.unknown()),
    intervalSeconds: z.number().int().min(300).max(31_536_000).default(2_592_000),
    graceSeconds: z.number().int().min(0).max(604_800).default(3600),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.intervalSeconds > value.graceSeconds, {
    message: "intervalSeconds must be greater than graceSeconds",
    path: ["intervalSeconds"],
  });
export type CreateRotationInput = z.infer<typeof createRotationSchema>;

export const updateRotationSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(300).max(31_536_000).optional(),
});
export type UpdateRotationInput = z.infer<typeof updateRotationSchema>;

export interface RotationPolicyDto {
  id: string;
  key: string;
  path: string;
  environmentSlug: string;
  provider: string;
  intervalSeconds: number;
  graceSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureCount: number;
  previousRevokeAfter: string | null;
  createdAt: string;
}

export const grantablePermissions = [
  "secret:read",
  "secret:write",
  "secret:delete",
  "project:read",
  "audit:read",
] as const;
export type GrantablePermission = (typeof grantablePermissions)[number];
export const grantablePermissionSchema = z.enum(grantablePermissions);

export const createCustomRoleSchema = z.object({
  name: nameSchema,
  permissions: z.array(grantablePermissionSchema).min(1).max(20),
});
export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;

export const createRoleGrantSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  path: secretPathSchema.optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateRoleGrantInput = z.infer<typeof createRoleGrantSchema>;

export interface CustomRoleDto {
  id: string;
  name: string;
  permissions: GrantablePermission[];
  createdAt: string;
}

export interface RoleGrantDto {
  id: string;
  userId: string;
  userName: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  projectId: string | null;
  environmentId: string | null;
  path: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const syncWebhookConfigSchema = z.object({
  url: z.string().url().max(2000),
  headers: z.record(z.string()).optional(),
});
export type SyncWebhookConfig = z.infer<typeof syncWebhookConfigSchema>;

export const syncVercelConfigSchema = z.object({
  token: z.string().min(1).max(500),
  vercelProjectId: z.string().min(1).max(200),
  teamId: z.string().min(1).max(200).optional(),
  target: z
    .array(z.enum(["production", "preview", "development"]))
    .min(1)
    .default(["production"]),
});
export type SyncVercelConfig = z.infer<typeof syncVercelConfigSchema>;

export const syncCloudflareConfigSchema = z.object({
  token: z.string().min(1).max(500),
  accountId: z.string().min(1).max(200),
  scriptName: z.string().min(1).max(200),
});
export type SyncCloudflareConfig = z.infer<typeof syncCloudflareConfigSchema>;

export const syncGithubConfigSchema = z.object({
  token: z.string().min(1).max(500),
  owner: z.string().min(1).max(200),
  repo: z.string().min(1).max(200),
  environment: z.string().min(1).max(200).optional(),
});
export type SyncGithubConfig = z.infer<typeof syncGithubConfigSchema>;

export const createSecretSyncSchema = z.object({
  env: slugSchema,
  path: secretPathSchema.optional(),
  provider: z.enum(["webhook", "vercel", "cloudflare", "github"]),
  config: z.record(z.unknown()),
  intervalSeconds: z.number().int().min(60).max(86_400).default(300),
  enabled: z.boolean().optional(),
});
export type CreateSecretSyncInput = z.infer<typeof createSecretSyncSchema>;

export const updateSecretSyncSchema = z.object({
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(60).max(86_400).optional(),
});
export type UpdateSecretSyncInput = z.infer<typeof updateSecretSyncSchema>;

export interface SecretSyncDto {
  id: string;
  environmentSlug: string;
  path: string;
  provider: string;
  enabled: boolean;
  intervalSeconds: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureCount: number;
  createdAt: string;
}

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: roleSchema.default("member"),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z.object({ role: roleSchema });

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const mfaSetupSchema = z.object({
  enrollmentToken: z.string().min(20).max(2000).optional(),
});

export const mfaVerifySchema = z.object({
  code: z.string().trim().min(6).max(10),
  enrollmentToken: z.string().min(20).max(2000).optional(),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaDisableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(20),
});
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

export const mfaLoginSchema = z.object({
  challengeToken: z.string().min(20).max(2000),
  code: z.string().trim().min(6).max(64),
});
export type MfaLoginInput = z.infer<typeof mfaLoginSchema>;

export const mfaPolicySchema = z.object({ required: z.boolean() });
export type MfaPolicyInput = z.infer<typeof mfaPolicySchema>;

export interface MfaStatusDto {
  enabled: boolean;
  recoveryCodesRemaining: number;
  orgRequired: boolean;
}

export interface MfaSetupDto {
  secret: string;
  otpauthUrl: string;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface InviteDto {
  id: string;
  email: string;
  role: Role;
  invitedByName: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteInfoDto {
  email: string;
  role: Role;
  orgName: string;
  orgSlug: string;
  expiresAt: string;
}

export const environmentPolicySchema = z.object({
  approvalRequired: z.boolean().optional(),
  requiredApprovals: z.number().int().min(1).max(10).optional(),
});
export type EnvironmentPolicyInput = z.infer<typeof environmentPolicySchema>;

export const changeRequestDecisionSchema = z.object({
  note: z.string().max(500).optional(),
});

export type ChangeRequestAction = "set" | "delete" | "rollback";
export type ChangeRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ChangeRequestDto {
  id: string;
  action: ChangeRequestAction;
  key: string;
  path: string;
  comment: string | null;
  targetVersion: number | null;
  status: ChangeRequestStatus;
  environmentId: string;
  environmentSlug: string;
  requestedByType: string;
  requestedById: string;
  requestedByName: string;
  requestedAt: string;
  approvals: number;
  requiredApprovals: number;
  approvedBy: string[];
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface EnvironmentPolicyDto {
  id: string;
  slug: string;
  approvalRequired: boolean;
  requiredApprovals: number;
}

export interface EnvironmentDto {
  id: string;
  name: string;
  slug: string;
  position: number;
  approvalRequired: boolean;
  requiredApprovals: number;
}

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  environments: EnvironmentDto[];
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  orgId: string;
  orgName: string;
}

export interface SecretDto {
  key: string;
  value: string;
  path: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  importedFrom?: string;
}

export const environmentImportSchema = z.object({
  sourceEnvironmentId: z.string().uuid().nullable(),
});
export type EnvironmentImportInput = z.infer<typeof environmentImportSchema>;

export interface EnvironmentImportDto {
  targetEnvironmentId: string;
  sourceEnvironmentId: string;
  sourceSlug: string;
}

export interface SecretVersionDto {
  version: number;
  comment: string | null;
  fingerprint: string;
  fingerprintVersion: number;
  createdByType: string;
  createdById: string;
  createdAt: string;
  current: boolean;
}

export const secretDiffQuerySchema = z.object({
  env: slugSchema,
  path: secretPathSchema.optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  reveal: z.enum(["true", "false"]).optional(),
});
export type SecretDiffQuery = z.infer<typeof secretDiffQuerySchema>;

export interface SecretDiffDto {
  key: string;
  path: string;
  env: string;
  changed: boolean;
  revealed: boolean;
  from: { version: number; value: string; createdAt: string };
  to: { version: number; value: string; createdAt: string };
}

export const pointInTimeQuerySchema = z.object({
  env: slugSchema,
  at: z.string().datetime({ offset: true }),
});
export type PointInTimeQuery = z.infer<typeof pointInTimeQuerySchema>;

export const restorePointInTimeSchema = z.object({
  env: slugSchema,
  at: z.string().datetime({ offset: true }),
  dryRun: z.boolean().optional(),
});
export type RestorePointInTimeInput = z.infer<typeof restorePointInTimeSchema>;

export type PointInTimeAction = "restore" | "revive" | "delete" | "none";

export interface PointInTimeEntryDto {
  key: string;
  path: string;
  action: PointInTimeAction;
  currentVersion: number;
  targetVersion: number | null;
}

export interface PointInTimePreviewDto {
  at: string;
  env: string;
  secretCount: number;
  changes: PointInTimeEntryDto[];
}

export interface PointInTimeRestoreResult {
  at: string;
  env: string;
  dryRun: boolean;
  restored: number;
  revived: number;
  deleted: number;
  changes: PointInTimeEntryDto[];
}

export const transitKeyNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use lowercase letters, digits, and dashes");

export const createTransitKeySchema = z.object({ name: transitKeyNameSchema });

export const transitEncryptSchema = z.object({
  plaintext: z.string().min(1).max(64_000),
  context: z.string().max(500).optional(),
  key: transitKeyNameSchema.optional(),
});
export type TransitEncryptInput = z.infer<typeof transitEncryptSchema>;

export const transitDecryptSchema = z.object({
  ciphertext: z.string().min(1).max(120_000),
  context: z.string().max(500).optional(),
});
export type TransitDecryptInput = z.infer<typeof transitDecryptSchema>;

export interface TransitKeyDto {
  id: string;
  name: string;
  version: number;
  createdAt: string;
}

export interface TransitEncryptResult {
  ciphertext: string;
  key: string;
  keyVersion: number;
  algorithm: string;
}

export interface IdentityDto {
  id: string;
  name: string;
  clientId: string;
  role: IdentityRole;
  environmentIds: string[];
  tokenTtlSeconds: number;
  ipAllowlist: string[] | null;
  hourlyTokenCap: number | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedIdentityDto extends IdentityDto {
  clientSecret: string;
}

export interface AuditLogDto {
  id: string;
  actorType: string;
  actorId: string;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

import { z } from "zod";

export const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const identityRoleSchema = z.enum(["member", "viewer"]);
export type IdentityRole = z.infer<typeof identityRoleSchema>;

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12, "password must be at least 12 characters").max(200);
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

export const createIdentitySchema = z.object({
  name: nameSchema,
  role: identityRoleSchema.default("viewer"),
  environmentIds: z.array(z.string().uuid()).min(1, "pick at least one environment"),
});
export type CreateIdentityInput = z.infer<typeof createIdentitySchema>;

export const tokenRequestSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(500),
});
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export interface EnvironmentDto {
  id: string;
  name: string;
  slug: string;
  position: number;
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
}

export interface SecretVersionDto {
  version: number;
  comment: string | null;
  fingerprint: string;
  createdByType: string;
  createdById: string;
  createdAt: string;
  current: boolean;
}

export interface IdentityDto {
  id: string;
  name: string;
  clientId: string;
  role: IdentityRole;
  environmentIds: string[];
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

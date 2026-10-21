import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  OPENSIEL_MASTER_KEY: z.string().min(1),
  OPENSIEL_MASTER_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  OPENSIEL_MASTER_KEY_NEXT: z.string().optional(),
  OPENSIEL_MASTER_KEY_NEXT_VERSION: z.coerce.number().int().min(1).optional(),
  OPENSIEL_JWT_SECRET: z.string().min(32, "OPENSIEL_JWT_SECRET must be at least 32 characters"),
  OPENSIEL_PUBLIC_URL: z.string().url().optional(),
  OPENSIEL_WEB_DIR: z.string().optional(),
  OPENSIEL_ALLOW_SIGNUP: z.enum(["true", "false"]).default("false"),
  OPENSIEL_AUTO_MIGRATE: z.enum(["true", "false"]).default("true"),
  OPENSIEL_RATE_LIMIT: z.enum(["true", "false"]).default("true"),
  OPENSIEL_OIDC_ISSUER: z.string().url().optional(),
  OPENSIEL_OIDC_CLIENT_ID: z.string().min(1).optional(),
  OPENSIEL_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OPENSIEL_OIDC_REDIRECT_URI: z.string().url().optional(),
  OPENSIEL_OIDC_SCOPES: z.string().default("openid email profile"),
  OPENSIEL_OIDC_ALLOWED_DOMAINS: z.string().optional(),
  OPENSIEL_OIDC_AUTO_CREATE: z.enum(["true", "false"]).default("true"),
});

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  allowedDomains: string[];
  autoCreate: boolean;
}

export interface Env {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  databaseUrl: string;
  masterKey: Buffer;
  masterKeyVersion: number;
  nextMasterKey?: Buffer;
  nextMasterKeyVersion?: number;
  jwtSecret: string;
  publicUrl?: string;
  webDir?: string;
  allowSignup: boolean;
  autoMigrate: boolean;
  rateLimit: boolean;
  isProd: boolean;
  secureCookies: boolean;
  oidc?: OidcConfig;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  const s = parsed.data;
  const masterKey = Buffer.from(s.OPENSIEL_MASTER_KEY, "base64");
  if (masterKey.length !== 32) {
    throw new Error("OPENSIEL_MASTER_KEY must decode to exactly 32 bytes (openssl rand -base64 32)");
  }
  const nextMasterKeyRaw = s.OPENSIEL_MASTER_KEY_NEXT?.trim() || undefined;
  const nextMasterKey = nextMasterKeyRaw ? Buffer.from(nextMasterKeyRaw, "base64") : undefined;
  if (nextMasterKey && nextMasterKey.length !== 32) {
    throw new Error("OPENSIEL_MASTER_KEY_NEXT must decode to exactly 32 bytes");
  }
  const nextMasterKeyVersion =
    s.OPENSIEL_MASTER_KEY_NEXT_VERSION ?? (nextMasterKey ? s.OPENSIEL_MASTER_KEY_VERSION + 1 : undefined);
  if (nextMasterKey && nextMasterKeyVersion !== undefined && nextMasterKeyVersion <= s.OPENSIEL_MASTER_KEY_VERSION) {
    throw new Error("OPENSIEL_MASTER_KEY_NEXT_VERSION must be greater than OPENSIEL_MASTER_KEY_VERSION");
  }
  const isProd = s.NODE_ENV === "production";
  const oidcValues = [s.OPENSIEL_OIDC_ISSUER, s.OPENSIEL_OIDC_CLIENT_ID, s.OPENSIEL_OIDC_CLIENT_SECRET];
  const oidcConfigured = oidcValues.filter(Boolean).length;
  if (oidcConfigured > 0 && oidcConfigured < 3) {
    throw new Error(
      "OPENSIEL_OIDC_ISSUER, OPENSIEL_OIDC_CLIENT_ID and OPENSIEL_OIDC_CLIENT_SECRET must all be set",
    );
  }

  const publicUrl = s.OPENSIEL_PUBLIC_URL;
  const oidc: OidcConfig | undefined =
    oidcConfigured === 3
      ? {
          issuer: s.OPENSIEL_OIDC_ISSUER!,
          clientId: s.OPENSIEL_OIDC_CLIENT_ID!,
          clientSecret: s.OPENSIEL_OIDC_CLIENT_SECRET!,
          redirectUri:
            s.OPENSIEL_OIDC_REDIRECT_URI ??
            `${(publicUrl ?? `http://localhost:${s.PORT}`).replace(/\/$/, "")}/api/auth/oidc/callback`,
          scopes: s.OPENSIEL_OIDC_SCOPES,
          allowedDomains: (s.OPENSIEL_OIDC_ALLOWED_DOMAINS ?? "")
            .split(",")
            .map((domain) => domain.trim().toLowerCase())
            .filter(Boolean),
          autoCreate: s.OPENSIEL_OIDC_AUTO_CREATE === "true",
        }
      : undefined;

  return {
    nodeEnv: s.NODE_ENV,
    port: s.PORT,
    host: s.HOST,
    databaseUrl: s.DATABASE_URL,
    masterKey,
    masterKeyVersion: s.OPENSIEL_MASTER_KEY_VERSION,
    nextMasterKey,
    nextMasterKeyVersion,
    jwtSecret: s.OPENSIEL_JWT_SECRET,
    publicUrl,
    webDir: s.OPENSIEL_WEB_DIR,
    allowSignup: s.OPENSIEL_ALLOW_SIGNUP === "true",
    autoMigrate: s.OPENSIEL_AUTO_MIGRATE === "true",
    rateLimit: s.OPENSIEL_RATE_LIMIT === "true",
    isProd,
    secureCookies: publicUrl ? publicUrl.startsWith("https://") : isProd,
    oidc,
  };
}

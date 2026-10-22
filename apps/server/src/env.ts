import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

loadDotenv({
  path: [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../.env"),
  ],
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  OPENSIEL_MASTER_KEY: z.string().optional(),
  OPENSIEL_MASTER_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  OPENSIEL_MASTER_KEY_NEXT: z.string().optional(),
  OPENSIEL_MASTER_KEY_NEXT_VERSION: z.coerce.number().int().min(1).optional(),
  OPENSIEL_KMS_KEY_ID: z.string().optional(),
  OPENSIEL_KMS_WRAPPED_MASTER_KEY: z.string().optional(),
  OPENSIEL_KMS_REGION: z.string().default("us-east-1"),
  OPENSIEL_KMS_ENDPOINT: z.string().url().optional(),
  OPENSIEL_KMS_ACCESS_KEY_ID: z.string().optional(),
  OPENSIEL_KMS_SECRET_ACCESS_KEY: z.string().optional(),
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
  OPENSIEL_SAML_ENTRY_POINT: z.string().url().optional(),
  OPENSIEL_SAML_ISSUER: z.string().min(1).optional(),
  OPENSIEL_SAML_IDP_CERT: z.string().optional(),
  OPENSIEL_SAML_CALLBACK_URL: z.string().url().optional(),
  OPENSIEL_SAML_AUDIENCE: z.string().optional(),
  OPENSIEL_SAML_ALLOWED_DOMAINS: z.string().optional(),
  OPENSIEL_SAML_AUTO_CREATE: z.enum(["true", "false"]).default("true"),
  OPENSIEL_AUDIT_SINK: z.enum(["off", "http", "splunk", "datadog", "s3"]).default("off"),
  OPENSIEL_AUDIT_SINK_URL: z.string().url().optional(),
  OPENSIEL_AUDIT_SINK_TOKEN: z.string().optional(),
  OPENSIEL_AUDIT_SINK_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  OPENSIEL_AUDIT_SINK_BATCH: z.coerce.number().int().min(1).max(1000).default(200),
  OPENSIEL_AUDIT_SINK_BUCKET: z.string().optional(),
  OPENSIEL_AUDIT_SINK_PREFIX: z.string().default("opensiel-audit"),
  OPENSIEL_AUDIT_SINK_REGION: z.string().default("us-east-1"),
  OPENSIEL_AUDIT_SINK_ENDPOINT: z.string().url().optional(),
  OPENSIEL_AUDIT_SINK_ACCESS_KEY_ID: z.string().optional(),
  OPENSIEL_AUDIT_SINK_SECRET_ACCESS_KEY: z.string().optional(),
});

export interface KmsConfig {
  keyId: string;
  wrappedKey: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface SamlConfig {
  entryPoint: string;
  issuer: string;
  idpCert: string;
  callbackUrl: string;
  audience: string;
  allowedDomains: string[];
  autoCreate: boolean;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  allowedDomains: string[];
  autoCreate: boolean;
}

export interface AuditSinkConfig {
  type: "http" | "splunk" | "datadog" | "s3";
  intervalSeconds: number;
  batchSize: number;
  url?: string;
  token?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface Env {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  databaseUrl: string;
  masterKey: Buffer;
  kms?: KmsConfig;
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
  saml?: SamlConfig;
  auditSink?: AuditSinkConfig;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  const s = parsed.data;
  const kmsConfigured =
    Boolean(s.OPENSIEL_KMS_KEY_ID) || Boolean(s.OPENSIEL_KMS_WRAPPED_MASTER_KEY);
  if (kmsConfigured && (!s.OPENSIEL_KMS_KEY_ID || !s.OPENSIEL_KMS_WRAPPED_MASTER_KEY)) {
    throw new Error("OPENSIEL_KMS_KEY_ID and OPENSIEL_KMS_WRAPPED_MASTER_KEY must both be set");
  }
  if (!s.OPENSIEL_MASTER_KEY && !kmsConfigured) {
    throw new Error("set OPENSIEL_MASTER_KEY or configure AWS KMS");
  }

  let masterKey = Buffer.alloc(0);
  if (s.OPENSIEL_MASTER_KEY) {
    masterKey = Buffer.from(s.OPENSIEL_MASTER_KEY, "base64");
    if (masterKey.length !== 32) {
      throw new Error(
        "OPENSIEL_MASTER_KEY must decode to exactly 32 bytes (openssl rand -base64 32)",
      );
    }
  }

  const kms: KmsConfig | undefined = kmsConfigured
    ? {
        keyId: s.OPENSIEL_KMS_KEY_ID!,
        wrappedKey: s.OPENSIEL_KMS_WRAPPED_MASTER_KEY!,
        region: s.OPENSIEL_KMS_REGION,
        endpoint: s.OPENSIEL_KMS_ENDPOINT,
        accessKeyId: s.OPENSIEL_KMS_ACCESS_KEY_ID,
        secretAccessKey: s.OPENSIEL_KMS_SECRET_ACCESS_KEY,
      }
    : undefined;
  const nextMasterKeyRaw = s.OPENSIEL_MASTER_KEY_NEXT?.trim() || undefined;
  const nextMasterKey = nextMasterKeyRaw ? Buffer.from(nextMasterKeyRaw, "base64") : undefined;
  if (nextMasterKey && nextMasterKey.length !== 32) {
    throw new Error("OPENSIEL_MASTER_KEY_NEXT must decode to exactly 32 bytes");
  }
  const nextMasterKeyVersion =
    s.OPENSIEL_MASTER_KEY_NEXT_VERSION ??
    (nextMasterKey ? s.OPENSIEL_MASTER_KEY_VERSION + 1 : undefined);
  if (
    nextMasterKey &&
    nextMasterKeyVersion !== undefined &&
    nextMasterKeyVersion <= s.OPENSIEL_MASTER_KEY_VERSION
  ) {
    throw new Error(
      "OPENSIEL_MASTER_KEY_NEXT_VERSION must be greater than OPENSIEL_MASTER_KEY_VERSION",
    );
  }
  const isProd = s.NODE_ENV === "production";
  const oidcValues = [
    s.OPENSIEL_OIDC_ISSUER,
    s.OPENSIEL_OIDC_CLIENT_ID,
    s.OPENSIEL_OIDC_CLIENT_SECRET,
  ];
  const oidcConfigured = oidcValues.filter(Boolean).length;
  if (oidcConfigured > 0 && oidcConfigured < 3) {
    throw new Error(
      "OPENSIEL_OIDC_ISSUER, OPENSIEL_OIDC_CLIENT_ID and OPENSIEL_OIDC_CLIENT_SECRET must all be set",
    );
  }

  const publicUrl = s.OPENSIEL_PUBLIC_URL;
  const samlConfigured = Boolean(s.OPENSIEL_SAML_ENTRY_POINT) || Boolean(s.OPENSIEL_SAML_IDP_CERT);
  if (samlConfigured && (!s.OPENSIEL_SAML_ENTRY_POINT || !s.OPENSIEL_SAML_IDP_CERT)) {
    throw new Error("OPENSIEL_SAML_ENTRY_POINT and OPENSIEL_SAML_IDP_CERT must both be set");
  }

  let saml: SamlConfig | undefined;
  if (s.OPENSIEL_SAML_ENTRY_POINT && s.OPENSIEL_SAML_IDP_CERT) {
    const issuer = s.OPENSIEL_SAML_ISSUER ?? publicUrl ?? `http://localhost:${s.PORT}`;
    saml = {
      entryPoint: s.OPENSIEL_SAML_ENTRY_POINT,
      issuer,
      idpCert: s.OPENSIEL_SAML_IDP_CERT.replace(/\\n/g, "\n"),
      callbackUrl:
        s.OPENSIEL_SAML_CALLBACK_URL ??
        `${(publicUrl ?? `http://localhost:${s.PORT}`).replace(/\/$/, "")}/api/auth/saml/callback`,
      audience: s.OPENSIEL_SAML_AUDIENCE ?? issuer,
      allowedDomains: (s.OPENSIEL_SAML_ALLOWED_DOMAINS ?? "")
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
      autoCreate: s.OPENSIEL_SAML_AUTO_CREATE === "true",
    };
  }
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

  let auditSink: AuditSinkConfig | undefined;
  if (s.OPENSIEL_AUDIT_SINK !== "off") {
    if (s.OPENSIEL_AUDIT_SINK === "s3") {
      if (!s.OPENSIEL_AUDIT_SINK_BUCKET) {
        throw new Error("OPENSIEL_AUDIT_SINK_BUCKET is required for the s3 audit sink");
      }
    } else {
      if (!s.OPENSIEL_AUDIT_SINK_URL) {
        throw new Error("OPENSIEL_AUDIT_SINK_URL is required for this audit sink");
      }
      if (
        (s.OPENSIEL_AUDIT_SINK === "splunk" || s.OPENSIEL_AUDIT_SINK === "datadog") &&
        !s.OPENSIEL_AUDIT_SINK_TOKEN
      ) {
        throw new Error("OPENSIEL_AUDIT_SINK_TOKEN is required for this audit sink");
      }
    }
    auditSink = {
      type: s.OPENSIEL_AUDIT_SINK,
      intervalSeconds: s.OPENSIEL_AUDIT_SINK_INTERVAL_SECONDS,
      batchSize: s.OPENSIEL_AUDIT_SINK_BATCH,
      url: s.OPENSIEL_AUDIT_SINK_URL,
      token: s.OPENSIEL_AUDIT_SINK_TOKEN,
      bucket: s.OPENSIEL_AUDIT_SINK_BUCKET,
      prefix: s.OPENSIEL_AUDIT_SINK_PREFIX,
      region: s.OPENSIEL_AUDIT_SINK_REGION,
      endpoint: s.OPENSIEL_AUDIT_SINK_ENDPOINT,
      accessKeyId: s.OPENSIEL_AUDIT_SINK_ACCESS_KEY_ID,
      secretAccessKey: s.OPENSIEL_AUDIT_SINK_SECRET_ACCESS_KEY,
    };
  }

  return {
    nodeEnv: s.NODE_ENV,
    port: s.PORT,
    host: s.HOST,
    databaseUrl: s.DATABASE_URL,
    masterKey,
    kms,
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
    saml,
    auditSink,
  };
}

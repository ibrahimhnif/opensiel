import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  OPENSIEL_MASTER_KEY: z.string().min(1),
  OPENSIEL_JWT_SECRET: z.string().min(32, "OPENSIEL_JWT_SECRET must be at least 32 characters"),
  OPENSIEL_PUBLIC_URL: z.string().url().optional(),
  OPENSIEL_WEB_DIR: z.string().optional(),
  OPENSIEL_ALLOW_SIGNUP: z.enum(["true", "false"]).default("false"),
  OPENSIEL_AUTO_MIGRATE: z.enum(["true", "false"]).default("true"),
  OPENSIEL_RATE_LIMIT: z.enum(["true", "false"]).default("true"),
});

export interface Env {
  nodeEnv: "development" | "production" | "test";
  port: number;
  host: string;
  databaseUrl: string;
  masterKey: Buffer;
  jwtSecret: string;
  publicUrl?: string;
  webDir?: string;
  allowSignup: boolean;
  autoMigrate: boolean;
  rateLimit: boolean;
  isProd: boolean;
  secureCookies: boolean;
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
  const isProd = s.NODE_ENV === "production";
  return {
    nodeEnv: s.NODE_ENV,
    port: s.PORT,
    host: s.HOST,
    databaseUrl: s.DATABASE_URL,
    masterKey,
    jwtSecret: s.OPENSIEL_JWT_SECRET,
    publicUrl: s.OPENSIEL_PUBLIC_URL,
    webDir: s.OPENSIEL_WEB_DIR,
    allowSignup: s.OPENSIEL_ALLOW_SIGNUP === "true",
    autoMigrate: s.OPENSIEL_AUTO_MIGRATE === "true",
    rateLimit: s.OPENSIEL_RATE_LIMIT === "true",
    isProd,
    secureCookies: s.OPENSIEL_PUBLIC_URL ? s.OPENSIEL_PUBLIC_URL.startsWith("https://") : isProd,
  };
}

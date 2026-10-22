import { buildApp } from "./app.js";
import { startAuditSink } from "./audit-sink.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { revokeExpiredLeases } from "./dynamic.js";
import { startRotationScheduler } from "./rotation.js";
import { loadEnv } from "./env.js";
import { resolveMasterKey } from "./kms.js";

const env = loadEnv();
env.masterKey = await resolveMasterKey(env);
if (env.kms) console.log("master key decrypted with AWS KMS");
const { db, sql } = createDb(env.databaseUrl);
const deps = { env, db, sql };

if (env.autoMigrate) {
  const ran = await runMigrations(sql);
  if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);
}

const app = await buildApp(deps);

await app.listen({ port: env.port, host: env.host });

const reaper =
  env.nodeEnv === "test"
    ? undefined
    : setInterval(() => {
        void revokeExpiredLeases(deps).catch((error: unknown) => {
          console.error(
            "dynamic lease reaper failed:",
            error instanceof Error ? error.message : error,
          );
        });
      }, 60_000);
reaper?.unref();

const auditSink = startAuditSink(deps);
const rotations = startRotationScheduler(deps);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  if (reaper) clearInterval(reaper);
  if (auditSink) clearInterval(auditSink);
  if (rotations) clearInterval(rotations);
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

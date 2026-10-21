import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db, sql } = createDb(env.databaseUrl);

if (env.autoMigrate) {
  const ran = await runMigrations(sql);
  if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);
}

const app = await buildApp({ env, db, sql });

await app.listen({ port: env.port, host: env.host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

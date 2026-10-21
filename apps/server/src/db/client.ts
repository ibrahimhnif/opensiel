import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Sql = ReturnType<typeof postgres>;
export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  db: Db;
  sql: Sql;
}

export function createDb(databaseUrl: string, options: { max?: number } = {}): Database {
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

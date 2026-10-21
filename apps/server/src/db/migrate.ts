import type { Sql } from "./client.js";
import { migrations } from "./migrations.js";

export async function runMigrations(sql: Sql): Promise<string[]> {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
  const rows = await sql<{ name: string }[]>`select name from _migrations`;
  const applied = new Set(rows.map((row) => row.name));
  const ran: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const statements = migration.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }
      await tx`insert into _migrations (name) values (${migration.name})`;
    });
    ran.push(migration.name);
  }

  return ran;
}

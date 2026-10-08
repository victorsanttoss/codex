import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeMigrationClient } from "./client";

/**
 * Runner de migrations SQL versionadas. Roda como a role `migrator` (DDL).
 * Aplica `migrations/*.sql` em ordem, idempotente via tabela schema_migrations.
 */
async function main(): Promise<void> {
  const { sql } = makeMigrationClient();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;

    const dir = join(__dirname, "..", "migrations");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const done = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
      if (done.length > 0) {
        console.log(`= ${file} (já aplicada)`);
        continue;
      }
      const ddl = readFileSync(join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      console.log(`+ ${file} aplicada`);
    }
    console.log("Migrations concluídas.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Falha nas migrations:", err);
  process.exit(1);
});

import "dotenv/config";
import fs from "fs/promises";
import path from "path";

import { closeDatabasePool, query } from "../../lib/db";

const MIGRATIONS_TABLE = "schema_migrations";

type MigrationRecord = {
  filename: string;
  applied_at: Date;
};

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isMigrationApplied(filename: string) {
  const result = await query<MigrationRecord>(
    `
      SELECT filename, applied_at
      FROM ${MIGRATIONS_TABLE}
      WHERE filename = $1
      LIMIT 1
    `,
    [filename]
  );

  return Boolean(result.rows[0]);
}

async function registerMigration(filename: string) {
  await query(
    `
      INSERT INTO ${MIGRATIONS_TABLE} (filename)
      VALUES ($1)
      ON CONFLICT (filename) DO NOTHING
    `,
    [filename]
  );
}

async function runMigrations() {
  const migrationsDir = path.resolve(process.cwd(), "src/database/migration");
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  if (!files.length) {
    console.log("No SQL migrations found.");
    return;
  }

  await ensureMigrationsTable();

  let appliedCount = 0;

  for (const file of files) {
    if (await isMigrationApplied(file)) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");

    await query("BEGIN");

    try {
      await query(sql);
      await registerMigration(file);
      await query("COMMIT");
      appliedCount += 1;
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  }

  if (appliedCount === 0) {
    console.log("No pending migrations.");
    return;
  }

  console.log("Migrations completed.");
}

runMigrations()
  .then(async () => {
    await closeDatabasePool();
  })
  .catch(async (error) => {
    console.error("Migration failed:", error);
    await closeDatabasePool();
    process.exit(1);
  });

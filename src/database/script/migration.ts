import "dotenv/config";
import fs from "fs/promises";
import path from "path";

import { closeDatabasePool, query } from "../../lib/db";
import { consoleUi, formatDuration } from "./console-ui";

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
    [filename],
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
    [filename],
  );
}

async function runMigrations() {
  const startedAt = Date.now();
  const migrationsDir = path.resolve(process.cwd(), "src/database/migration");
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  consoleUi.header(
    "🗃️",
    "DATABASE MIGRATIONS",
    `Penalyze • ${files.length} migration file${files.length === 1 ? "" : "s"} discovered`,
  );

  if (!files.length) {
    consoleUi.warning("No SQL migration files were found.");
    consoleUi.noChanges("Nothing to migrate", Date.now() - startedAt);
    return;
  }

  const tableStartedAt = Date.now();
  await ensureMigrationsTable();
  consoleUi.success(`Migration registry ready: ${MIGRATIONS_TABLE}`, Date.now() - tableStartedAt);

  const pendingFiles: string[] = [];
  let alreadyAppliedCount = 0;

  for (const file of files) {
    if (await isMigrationApplied(file)) {
      alreadyAppliedCount += 1;
    } else {
      pendingFiles.push(file);
    }
  }

  consoleUi.summary([
    { label: "Discovered", value: files.length, tone: "info" },
    { label: "Already applied", value: alreadyAppliedCount, tone: "success" },
    {
      label: "Pending",
      value: pendingFiles.length,
      tone: pendingFiles.length ? "warning" : "success",
    },
  ]);

  if (!pendingFiles.length) {
    consoleUi.noChanges("Database schema is already up to date", Date.now() - startedAt);
    return;
  }

  consoleUi.section("🚀", "Applying pending migrations");

  let appliedCount = 0;

  for (const [index, file] of pendingFiles.entries()) {
    const migrationStartedAt = Date.now();
    consoleUi.progress(index + 1, pendingFiles.length, file);
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");

    await query("BEGIN");

    try {
      await query(sql);
      await registerMigration(file);
      await query("COMMIT");
      appliedCount += 1;
      consoleUi.success(`Applied ${file}`, Date.now() - migrationStartedAt);
    } catch (error) {
      await query("ROLLBACK");
      consoleUi.warning(`Rolled back ${file} after an error.`);
      throw error;
    }
  }

  consoleUi.summary([
    { label: "Applied this run", value: appliedCount, tone: "success" },
    { label: "Skipped", value: alreadyAppliedCount, tone: "info" },
    { label: "Total migrations", value: files.length, tone: "info" },
    { label: "Elapsed", value: formatDuration(Date.now() - startedAt), tone: "success" },
  ]);
  consoleUi.completed("Migrations completed successfully", Date.now() - startedAt);
}

runMigrations()
  .then(async () => {
    await closeDatabasePool();
  })
  .catch(async (error) => {
    consoleUi.error("Migration process failed", error);
    await closeDatabasePool();
    process.exit(1);
  });

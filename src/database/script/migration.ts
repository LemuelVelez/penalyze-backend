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

  consoleUi.header(
    "🗃️",
    "DATABASE MIGRATIONS",
    "Penalyze • safe, ordered and transaction-wrapped schema updates",
  );

  const discoveryTask = consoleUi.task("Discovering migration files", {
    detail: migrationsDir,
  });
  let files: string[];
  try {
    files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    discoveryTask.succeed(
      "Migration files discovered",
      `${files.length} SQL file${files.length === 1 ? "" : "s"}`,
    );
  } catch (error) {
    discoveryTask.fail("Unable to read migration directory");
    throw error;
  }

  if (!files.length) {
    consoleUi.warning("No SQL migration files were found.");
    consoleUi.noChanges("Nothing to migrate", Date.now() - startedAt);
    return;
  }

  const registryTask = consoleUi.task("Preparing migration registry", {
    detail: MIGRATIONS_TABLE,
  });
  try {
    await ensureMigrationsTable();
    registryTask.succeed("Migration registry ready", MIGRATIONS_TABLE);
  } catch (error) {
    registryTask.fail("Migration registry could not be prepared", MIGRATIONS_TABLE);
    throw error;
  }

  consoleUi.section("🔎", "Checking migration state");
  const stateTask = consoleUi.task("Comparing migration files with database history", {
    detail: `0/${files.length} checked`,
  });
  const pendingFiles: string[] = [];
  let alreadyAppliedCount = 0;

  try {
    for (const [index, file] of files.entries()) {
      stateTask.update(`Checking ${file}`, `${index + 1}/${files.length} checked`);
      if (await isMigrationApplied(file)) {
        alreadyAppliedCount += 1;
      } else {
        pendingFiles.push(file);
      }
    }
    stateTask.succeed(
      "Migration state checked",
      `${alreadyAppliedCount} applied • ${pendingFiles.length} pending`,
    );
  } catch (error) {
    stateTask.fail("Unable to read migration history");
    throw error;
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
  consoleUi.info("Each migration runs inside its own transaction and is registered only after success.");

  let appliedCount = 0;

  for (const [index, file] of pendingFiles.entries()) {
    const prefix = `[${String(index + 1).padStart(String(pendingFiles.length).length, "0")}/${pendingFiles.length}]`;
    const migrationTask = consoleUi.task(file, {
      prefix,
      detail: "Reading SQL file",
    });

    try {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      const statementCount = sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean).length;

      migrationTask.update(file, `Opening transaction • ~${statementCount} SQL statement${statementCount === 1 ? "" : "s"}`);
      await query("BEGIN");

      migrationTask.update(file, "Executing SQL changes");
      await query(sql);

      migrationTask.update(file, "Recording migration in schema_migrations");
      await registerMigration(file);

      migrationTask.update(file, "Committing transaction");
      await query("COMMIT");

      appliedCount += 1;
      migrationTask.succeed(file, `${statementCount} statement${statementCount === 1 ? "" : "s"} committed`);
    } catch (error) {
      migrationTask.update(file, "Error detected • rolling back transaction");
      try {
        await query("ROLLBACK");
        migrationTask.fail(file, "Transaction rolled back — no partial migration kept");
      } catch (rollbackError) {
        migrationTask.fail(file, "Migration failed and rollback also reported an error");
        consoleUi.warning(
          `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  consoleUi.summary([
    { label: "Applied this run", value: appliedCount, tone: "success" },
    { label: "Already applied", value: alreadyAppliedCount, tone: "info" },
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

import "dotenv/config";
import fs from "fs/promises";
import path from "path";

import { closeDatabasePool, query } from "../../lib/db";

async function runMigrations() {
  const migrationsDir = path.resolve(process.cwd(), "src/database/migration");
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  if (!files.length) {
    console.log("No SQL migrations found.");
    return;
  }

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await query(sql);
    console.log(`Applied migration: ${file}`);
  }
}

runMigrations()
  .then(async () => {
    await closeDatabasePool();
    console.log("Migrations completed.");
  })
  .catch(async (error) => {
    console.error("Migration failed:", error);
    await closeDatabasePool();
    process.exit(1);
  });
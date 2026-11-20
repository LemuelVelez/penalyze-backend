#!/usr/bin/env node
// One-time developer maintenance: delete original attendance fixtures.
// Run from penalyze-backend: npm run security:purge-fixtures
// IMPORTANT: For previously published Git repositories, also remove all old
// fixture blobs from history with git-filter-repo/BFG and rotate credentials.
import { readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixtures = join(root, "src", "database", "seeder", "data");
const synthetic = /^synthetic-[\w.-]+\.(csv|txt|xlsx)$/i;
const deletions = [];

async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && !synthetic.test(entry.name)) deletions.push(file);
  }
}

try { await visit(fixtures); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
for (const file of deletions) {
  const path = relative(root, file).split(sep).join("/");
  // Remove from Git's index as well, so the next commit records the deletion.
  try { execFileSync("git", ["rm", "--force", "--", path], { cwd: root, stdio: "ignore" }); }
  catch { await rm(file); }
}
console.log(`Removed ${deletions.length} non-synthetic fixture files. Commit the deletions and clean the remote Git history separately.`);

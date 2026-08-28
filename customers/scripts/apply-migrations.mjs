#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { customersDirectory } from "./lib/config.mjs";
import { executeSql, queryRows } from "./lib/db.mjs";

const migrationDirectory = path.join(customersDirectory, "migrations");
const migrations = (await fs.readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
let applied = new Set();
try {
  applied = new Set((await queryRows("SELECT migration_name FROM schema_migrations;", { bootstrap: true })).map((row) => row.migration_name));
} catch (error) {
  if (!String(error.message).includes("schema_migrations")) throw error;
}
for (const migration of migrations) {
  if (applied.has(migration)) {
    console.log(`Already applied ${migration}`);
    continue;
  }
  const sql = await fs.readFile(path.join(migrationDirectory, migration), "utf8");
  await executeSql(sql, { application: "portomatic_migrations", bootstrap: true });
  console.log(`Applied ${migration}`);
}

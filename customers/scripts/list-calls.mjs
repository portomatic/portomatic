#!/usr/bin/env node
import { parseArgs } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";

const args = parseArgs(process.argv.slice(2));
const limit = Math.min(1000, Math.max(1, Number(args.limit || 100)));
if (!Number.isInteger(limit)) throw new Error("--limit must be an integer");
const filter = args.customer ? `WHERE customer_slug = ${sqlLiteral(args.customer)}` : "";
const rows = await queryRows(`
  SELECT call_id, customer_name, recorded_at, recording_count, segment_count
  FROM call_catalog
  ${filter}
  ORDER BY recorded_at DESC
  LIMIT ${limit};
`, { rowLimit: limit });

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.table(rows.map((row) => ({
    call_id: row.call_id,
    customer: row.customer_name,
    recorded_at: row.recorded_at,
    recordings: row.recording_count,
    segments: row.segment_count,
  })));
}

#!/usr/bin/env node
import { parseArgs } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";

const args = parseArgs(process.argv.slice(2));
const limit = Math.min(1000, Math.max(1, Number(args.limit || 100)));
if (!Number.isInteger(limit)) throw new Error("--limit must be an integer");
const filters = ["review_status = 'confirmed'", "portomatic_relevance = 'relevant'"];
if (args.customer) filters.push(`customer_slug = ${sqlLiteral(args.customer)}`);
const rows = await queryRows(`
  SELECT segment_id, customer_name, company, recorded_local_date::text AS recorded_local_date,
         recorded_at, recorded_at_precision,
         source_title, start_ms, end_ms, interaction_type, identity_confidence
  FROM conversation_catalog
  WHERE ${filters.join(" AND ")}
  ORDER BY recorded_at DESC, start_ms
  LIMIT ${limit};
`, { rowLimit: limit });

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.table(rows.map((row) => ({
    conversation: row.segment_id,
    person: row.customer_name,
    company: row.company,
    recorded_date: row.recorded_local_date,
    precision: row.recorded_at_precision,
    source: row.source_title,
    range: `${formatMs(row.start_ms)}–${formatMs(row.end_ms)}`,
    type: row.interaction_type,
    identity: row.identity_confidence,
  })));
}

function formatMs(value) {
  const total = Math.floor(Number(value) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

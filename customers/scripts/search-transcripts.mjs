#!/usr/bin/env node
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";
import { formatTimestamp } from "./lib/time.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["query"]);
const limit = Math.min(500, Math.max(1, Number(args.limit || 50)));
if (!Number.isInteger(limit)) throw new Error("--limit must be an integer");
const filters = [`(search_document @@ websearch_to_tsquery('english', ${sqlLiteral(args.query)}) OR transcript ILIKE ${sqlLiteral(`%${args.query}%`)})`];
if (args["call-id"]) filters.push(`call_id = ${sqlLiteral(args["call-id"])}`);
if (args.customer) filters.push(`customer_slug = ${sqlLiteral(args.customer)}`);
const rows = await queryRows(`
  SELECT call_id, customer_name, recording_uri, start_ms, end_ms, speaker, transcript
  FROM current_transcript_segments
  WHERE ${filters.join(" AND ")}
  ORDER BY call_recorded_at DESC, start_ms
  LIMIT ${limit};
`, { rowLimit: limit });

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    const at = Number(row.start_ms) / 1000;
    console.log(`${row.call_id}  ${formatTimestamp(at)}  ${row.speaker || "—"}\n${row.transcript}\nopen: npm run customers:url -- --call-id ${row.call_id} --recording-uri ${row.recording_uri} --at ${at}\n`);
  }
}

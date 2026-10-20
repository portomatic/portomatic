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
const rows = args['call-id'] || args.customer ? await queryRows(`
  SELECT call_id, customer_name, recording_uri, start_ms, end_ms, speaker, transcript
  FROM current_transcript_segments
  WHERE ${filters.join(" AND ")}
  ORDER BY call_recorded_at DESC, start_ms
  LIMIT ${limit};
`, { rowLimit: limit }) : await queryRows(`
  WITH searchable AS (
    SELECT NULL::text AS call_id,NULL::text AS customer_name,t.title AS source_title,
      t.touchpoint_id AS crm_recording_id,t.storage_uri AS recording_uri,t.occurred_at AS recorded_at,
      s.start_ms,s.end_ms,s.speaker,s.transcript,s.search_document
    FROM crm_transcript_segments s JOIN crm_transcripts tr USING(run_id)
    JOIN crm_touchpoints t USING(touchpoint_id) WHERE tr.is_current
    UNION ALL
    SELECT v.call_id,v.customer_name,NULL::text,NULL::uuid,v.recording_uri,v.call_recorded_at,
      v.start_ms,v.end_ms,v.speaker,v.transcript,v.search_document
    FROM current_transcript_segments v WHERE NOT EXISTS(
      SELECT 1 FROM crm_transcripts tr JOIN crm_touchpoints t USING(touchpoint_id)
      WHERE tr.is_current AND t.storage_uri=v.recording_uri)
  ) SELECT call_id,customer_name,source_title,crm_recording_id,recording_uri,start_ms,end_ms,speaker,transcript
  FROM searchable WHERE ${filters.join(' AND ')} ORDER BY recorded_at DESC,start_ms LIMIT ${limit};
`,{rowLimit:limit});

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    const at = Number(row.start_ms) / 1000;
    const open=row.crm_recording_id?`https://crm.portomatic.com/api/recording/${row.crm_recording_id}#t=${at}`:`npm run customers:url -- --call-id ${row.call_id} --recording-uri ${row.recording_uri} --at ${at}`;
    console.log(`${row.call_id||row.source_title}  ${formatTimestamp(at)}  ${row.speaker || "—"}\n${row.transcript}\nopen: ${open}\n`);
  }
}

#!/usr/bin/env node
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id"]);
const callId = sqlLiteral(args["call-id"]);
const calls = await queryRows(`SELECT * FROM call_catalog WHERE call_id = ${callId};`, { rowLimit: 1 });
if (calls.length !== 1) throw new Error(`Unknown call_id: ${args["call-id"]}`);
const recordings = await queryRows(`
  SELECT cr.sequence, ro.storage_uri, ro.object_generation, ro.sha256, ro.bytes, ro.duration_ms, ro.recorded_at, ro.source_filename
  FROM call_recordings cr JOIN recording_objects ro USING (recording_id)
  WHERE cr.call_id = ${callId} ORDER BY cr.sequence;
`);
const segments = await queryRows(`
  SELECT recording_uri, sequence, start_ms, end_ms, speaker, transcript, model, transcript_status
  FROM current_transcript_segments
  WHERE call_id = ${callId}
  ORDER BY recording_recorded_at, sequence;
`, { rowLimit: 100000 });
console.log(JSON.stringify({ call: calls[0], recordings, transcript_segments: segments }, null, 2));

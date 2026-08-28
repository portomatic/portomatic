#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, requireArgs, run } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";
import { signUrl } from "./lib/sign-url.mjs";
import { buildViewerHtml } from "./lib/viewer.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id"]);
const callId = sqlLiteral(args["call-id"]);
const calls = await queryRows(`SELECT title, customer_name FROM call_catalog WHERE call_id = ${callId};`, { rowLimit: 1 });
if (calls.length !== 1) throw new Error(`Unknown call_id: ${args["call-id"]}`);
const recordings = await queryRows(`
  SELECT ro.storage_uri
  FROM active_call_recordings cr JOIN recording_objects ro USING (recording_id)
  WHERE cr.call_id = ${callId} ORDER BY cr.sequence;
`);
const uniqueUris = recordings.map((row) => row.storage_uri);
const signed = new Map(uniqueUris.map((uri) => [uri, signUrl(uri, args.duration)]));
const segments = await queryRows(`
  SELECT recording_uri, recording_recorded_at AS recorded_at,
         (start_ms::numeric / 1000)::text AS segment_start_seconds,
         speaker, transcript
  FROM current_transcript_segments
  WHERE call_id = ${callId}
  ORDER BY recording_recorded_at, sequence;
`, { rowLimit: 100000 });
const rows = segments.length ? segments : recordings.map((row) => ({
  recording_uri: row.storage_uri,
  recorded_at: "",
  segment_start_seconds: "0",
  speaker: "",
  transcript: "",
}));
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portomatic-call-"));
await fs.chmod(temporaryDirectory, 0o700);
const outputPath = path.join(temporaryDirectory, `${args["call-id"]}.html`);
const title = `${calls[0].customer_name} — ${args["call-id"]}`;
const html = buildViewerHtml({ title, rows, signedByUri: signed });
await fs.writeFile(outputPath, html, { mode: 0o600 });
console.log(outputPath);
if (args.open) run("open", [outputPath]);

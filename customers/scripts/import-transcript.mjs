#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { readCallLog, rowsForVtt, validateCallLog, writeCallLog } from "./lib/call-log.mjs";
import { parseTimestamp } from "./lib/time.mjs";
import { parseVtt } from "./lib/vtt.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id", "vtt"]);
const rows = await readCallLog();
let candidates = rows.filter((row) => row.call_id === args["call-id"] && row.recording_uri);
if (args["recording-uri"]) candidates = candidates.filter((row) => row.recording_uri === args["recording-uri"]);
const uris = [...new Set(candidates.map((row) => row.recording_uri))];
if (uris.length !== 1) throw new Error("Call must resolve to exactly one recording; pass --recording-uri gs://...");
const recordingUri = uris[0];
const commonRow = candidates[0];
const vttPath = path.resolve(args.vtt);
const cues = parseVtt(await fs.readFile(vttPath, "utf8"));
if (cues.length === 0) throw new Error("The WebVTT file contains no transcript cues");
const common = {
  call_id: commonRow.call_id,
  customer_slug: commonRow.customer_slug,
  customer_name: commonRow.customer_name,
  recorded_at: commonRow.recorded_at,
  recording_uri: commonRow.recording_uri,
  recording_sha256: commonRow.recording_sha256,
  recording_bytes: commonRow.recording_bytes,
  recording_duration_seconds: commonRow.recording_duration_seconds,
  source: `${commonRow.source}; transcript ${path.basename(vttPath)}`,
};
const replacement = rowsForVtt(common, cues, parseTimestamp(args.offset ?? "0"), args.status || "complete");
const retained = rows.filter((row) => !(row.call_id === args["call-id"] && row.recording_uri === recordingUri));
const updated = [...retained, ...replacement];
const errors = validateCallLog(updated, { allowPendingUri: false });
if (errors.length) throw new Error(`Call log validation failed:\n${errors.join("\n")}`);
await writeCallLog(updated);
console.log(`Replaced ${candidates.length} row(s) with ${replacement.length} timestamped transcript segment(s)`);

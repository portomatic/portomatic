#!/usr/bin/env node
import { readCallLog, validateCallLog } from "./lib/call-log.mjs";

const rows = await readCallLog();
const errors = validateCallLog(rows);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const calls = new Set(rows.map((row) => row.call_id));
const recordings = new Set(rows.map((row) => row.recording_uri).filter(Boolean));
console.log(`PASS: ${rows.length} transcript row(s), ${calls.size} call(s), ${recordings.size} recording object(s)`);

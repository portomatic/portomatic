#!/usr/bin/env node
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { readCallLog } from "./lib/call-log.mjs";
import { signUrl } from "./lib/sign-url.mjs";
import { parseTimestamp } from "./lib/time.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id"]);
const rows = (await readCallLog()).filter((row) => row.call_id === args["call-id"]);
if (rows.length === 0) throw new Error(`Unknown call_id: ${args["call-id"]}`);
let uris = [...new Set(rows.map((row) => row.recording_uri).filter(Boolean))];
if (args["recording-uri"]) uris = uris.filter((uri) => uri === args["recording-uri"]);
if (uris.length !== 1) throw new Error("This call references multiple recordings; pass --recording-uri gs://...");
const at = parseTimestamp(args.at ?? "0");
const { signedUrl, duration } = signUrl(uris[0], args.duration);
console.error(`Temporary bearer URL; expires after ${duration}. Do not commit or share it.`);
console.log(`${signedUrl}#t=${at}`);

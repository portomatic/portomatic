#!/usr/bin/env node
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { queryRows, sqlLiteral } from "./lib/db.mjs";
import { signUrl } from "./lib/sign-url.mjs";
import { parseTimestamp } from "./lib/time.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id"]);
let rows = await queryRows(`
  SELECT ro.storage_uri
  FROM active_call_recordings cr
  JOIN recording_objects ro USING (recording_id)
  WHERE cr.call_id = ${sqlLiteral(args["call-id"])}
  ORDER BY cr.sequence;
`);
if (rows.length === 0) throw new Error(`Unknown call_id: ${args["call-id"]}`);
if (args["recording-uri"]) rows = rows.filter((row) => row.storage_uri === args["recording-uri"]);
const uris = rows.map((row) => row.storage_uri);
if (uris.length !== 1) throw new Error("This call references multiple recordings; pass --recording-uri gs://...");
const at = parseTimestamp(args.at ?? "0");
const { signedUrl, duration } = signUrl(uris[0], args.duration);
console.error(`Temporary bearer URL; expires after ${duration}. Do not commit or share it.`);
console.log(`${signedUrl}#t=${at}`);

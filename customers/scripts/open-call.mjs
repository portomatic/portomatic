#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, requireArgs, run } from "./lib/cli.mjs";
import { readCallLog } from "./lib/call-log.mjs";
import { signUrl } from "./lib/sign-url.mjs";
import { buildViewerHtml } from "./lib/viewer.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id"]);
const rows = (await readCallLog()).filter((row) => row.call_id === args["call-id"]);
if (rows.length === 0) throw new Error(`Unknown call_id: ${args["call-id"]}`);

const uniqueUris = [...new Set(rows.map((row) => row.recording_uri).filter(Boolean))];
if (uniqueUris.length === 0) throw new Error("This call has not been uploaded yet");
const signed = new Map(uniqueUris.map((uri) => [uri, signUrl(uri, args.duration)]));
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "portomatic-call-"));
await fs.chmod(temporaryDirectory, 0o700);
const outputPath = path.join(temporaryDirectory, `${args["call-id"]}.html`);
const title = `${rows[0].customer_name} — ${args["call-id"]}`;
const html = buildViewerHtml({ title, rows, signedByUri: signed });
await fs.writeFile(outputPath, html, { mode: 0o600 });
console.log(outputPath);
if (args.open) run("open", [outputPath]);

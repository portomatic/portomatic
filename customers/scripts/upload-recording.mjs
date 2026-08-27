#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArgs, run } from "./lib/cli.mjs";
import { loadConfig, requireConfig, repositoryRoot } from "./lib/config.mjs";
import { readCallLog, rowsForVtt, validateCallLog, writeCallLog } from "./lib/call-log.mjs";
import { parseTimestamp } from "./lib/time.mjs";
import { parseVtt } from "./lib/vtt.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["file", "call-id", "customer-name", "customer-slug", "recorded-at"]);
const config = loadConfig();
requireConfig(config, ["projectId", "bucket", "uploaderServiceAccount"]);

const sourcePath = path.resolve(args.file);
const sourceStat = await fsp.stat(sourcePath);
if (!sourceStat.isFile()) throw new Error(`Not a file: ${sourcePath}`);
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args["call-id"])) throw new Error("--call-id must be lowercase kebab-case");
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args["customer-slug"])) throw new Error("--customer-slug must be lowercase kebab-case");
if (Number.isNaN(Date.parse(args["recorded-at"]))) throw new Error("--recorded-at must be ISO 8601 with a timezone");

run("bash", ["customers/scripts/verify-private-gcs.sh"], { cwd: repositoryRoot });

const sha256 = await hashFile(sourcePath);
const duration = mediaDuration(sourcePath);
const date = args["recorded-at"].slice(0, 10);
const extension = path.extname(sourcePath).toLowerCase() || ".mov";
const defaultKey = `customers/${args["customer-slug"]}/recordings/${date}/${args["call-id"]}${extension}`;
const objectKey = args["object-key"] || defaultKey;
if (objectKey.startsWith("/") || objectKey.includes("..")) throw new Error("--object-key must be a safe bucket-relative key");
const storageUri = `gs://${config.bucket}/${objectKey}`;
const rows = await readCallLog();
if (rows.some((row) => row.call_id === args["call-id"] && row.recording_uri === storageUri)) {
  throw new Error(`call-log.csv already contains ${args["call-id"]} at ${storageUri}`);
}

run("gcloud", [
  "storage",
  "cp",
  "--no-clobber",
  `--project=${config.projectId}`,
  `--impersonate-service-account=${config.uploaderServiceAccount}`,
  `--content-type=${contentType(extension)}`,
  `--custom-metadata=portomatic-call-id=${args["call-id"]},portomatic-sha256=${sha256}`,
  sourcePath,
  storageUri,
]);

const objectDescription = JSON.parse(run("gcloud", [
  "storage",
  "objects",
  "describe",
  storageUri,
  `--project=${config.projectId}`,
  `--impersonate-service-account=${config.uploaderServiceAccount}`,
  "--format=json",
], { capture: true }));
const remoteSha256 = objectDescription.metadata?.["portomatic-sha256"] || objectDescription.custom_metadata?.["portomatic-sha256"];
if (remoteSha256 !== sha256 || Number(objectDescription.size) !== sourceStat.size) {
  throw new Error(`Remote object verification failed for ${storageUri}; refusing to update the call log`);
}

const recordingStart = parseTimestamp(args["recording-start"] ?? "0");
const recordingEnd = parseTimestamp(args["recording-end"] ?? String(duration));
if (recordingEnd > duration + 0.01) throw new Error("--recording-end is after the media duration");
const common = {
  call_id: args["call-id"],
  customer_slug: args["customer-slug"],
  customer_name: args["customer-name"],
  recorded_at: args["recorded-at"],
  recording_uri: storageUri,
  recording_sha256: sha256,
  recording_bytes: String(sourceStat.size),
  recording_duration_seconds: duration.toFixed(3),
  source: path.basename(sourcePath),
};

let newRows;
if (args["transcript-vtt"]) {
  const cues = parseVtt(await fsp.readFile(path.resolve(args["transcript-vtt"]), "utf8"));
  if (cues.length === 0) throw new Error("The WebVTT file contains no transcript cues");
  const transcriptOffset = parseTimestamp(args["transcript-offset"] ?? "0");
  newRows = rowsForVtt(common, cues, transcriptOffset);
} else {
  newRows = [{
    ...common,
    segment_start_seconds: String(recordingStart),
    segment_end_seconds: String(recordingEnd),
    speaker: "",
    transcript: "",
    transcript_status: "pending",
  }];
}

const updatedRows = [...rows, ...newRows];
const errors = validateCallLog(updatedRows, { allowPendingUri: false });
if (errors.length > 0) throw new Error(`Call log validation failed:\n${errors.join("\n")}`);
await writeCallLog(updatedRows);
console.log(`Uploaded ${sourcePath} to ${storageUri}`);
console.log(`Added ${newRows.length} row(s) to customers/call-log.csv`);

function mediaDuration(filename) {
  const output = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filename], { capture: true });
  const value = Number(output.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not determine media duration for ${filename}`);
  return value;
}

async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function contentType(extension) {
  return ({
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
  })[extension] || "application/octet-stream";
}

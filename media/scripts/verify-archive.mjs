#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, run } from "../../customers/scripts/lib/cli.mjs";
import { queryRows, sqlLiteral } from "../../customers/scripts/lib/db.mjs";
import { loadMediaConfig, requireMediaConfig, repositoryRoot } from "./lib/config.mjs";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".avi", ".mkv"]);
const args = parseArgs(process.argv.slice(2));
const sourceDirectory = path.resolve(args.directory || path.join(os.homedir(), "Desktop"));
const config = loadMediaConfig();
requireMediaConfig(config, ["projectId", "bucket", "uploaderServiceAccount"]);
run("bash", ["media/scripts/verify-private-gcs.sh"], { cwd: repositoryRoot });

const names = (await fsp.readdir(sourceDirectory)).filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
if (!names.length) throw new Error(`No videos found in ${sourceDirectory}`);
const rows = await queryRows(`SELECT * FROM media_archive_catalog WHERE source_filename IN (${names.map(sqlLiteral).join(",")});`, { rowLimit: Math.max(10000, names.length * 2) });
const byName = new Map(rows.map((row) => [row.source_filename, row]));
const verified = [];
let totalBytes = 0;

for (const [index, name] of names.sort().entries()) {
  const filename = path.join(sourceDirectory, name);
  const statBefore = await fsp.stat(filename);
  process.stdout.write(`[${index + 1}/${names.length}] Verifying ${name} ... `);
  const hashes = await hashFile(filename);
  const statAfter = await fsp.stat(filename);
  if (statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs) throw new Error(`File changed during verification: ${filename}`);
  const row = byName.get(name);
  if (!row) throw new Error(`No database catalog entry for ${name}`);
  if (row.sha256 !== hashes.sha256 || row.md5_base64 !== hashes.md5Base64 || Number(row.bytes) !== statAfter.size) throw new Error(`Local/catalog mismatch for ${name}`);
  const object = describeObject(row.storage_uri);
  if (String(object.generation) !== String(row.object_generation) || Number(object.size) !== statAfter.size || readMd5(object) !== hashes.md5Base64 || readMetadata(object)["portomatic-sha256"] !== hashes.sha256) throw new Error(`Cloud object mismatch for ${name}`);
  const manifestObject = describeObject(row.manifest_uri);
  if (String(manifestObject.generation) !== String(row.manifest_generation) || readMetadata(manifestObject)["portomatic-sha256"] !== row.manifest_sha256) throw new Error(`Manifest object mismatch for ${name}`);
  const manifestBody = run("gcloud", ["storage", "cat", row.manifest_uri, `--project=${config.projectId}`, `--impersonate-service-account=${config.uploaderServiceAccount}`], { capture: true, maxBuffer: 1024 * 1024 });
  if (crypto.createHash("sha256").update(manifestBody).digest("hex") !== row.manifest_sha256) throw new Error(`Manifest content hash mismatch for ${name}`);
  const manifest = JSON.parse(manifestBody);
  if (manifest.asset.asset_id !== row.asset_id || manifest.asset.storage_uri !== row.storage_uri || manifest.asset.sha256 !== hashes.sha256 || Number(manifest.asset.bytes) !== statAfter.size) throw new Error(`Manifest contents mismatch for ${name}`);
  verified.push({ filename, size: statAfter.size, mtimeMs: statAfter.mtimeMs });
  totalBytes += statAfter.size;
  console.log("PASS");
}

if (rows.length !== names.length || byName.size !== names.length) throw new Error(`Catalog completeness mismatch: ${names.length} local files, ${rows.length} database rows`);
const first = rows[0];
const anonymousStatus = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `https://storage.googleapis.com/${config.bucket}/${encodeObjectPath(first.storage_uri)}`], { capture: true }).trim();
if (!["401", "403"].includes(anonymousStatus)) throw new Error(`Anonymous object request returned ${anonymousStatus}, expected 401 or 403`);

console.log(`PASS: ${verified.length} local videos (${formatBytes(totalBytes)}) match their exact private GCS generations, hashes, sizes, content-addressed manifests, and Cloud SQL catalog rows.`);
console.log(`PASS: anonymous access is denied with HTTP ${anonymousStatus}.`);

if (args["delete-local"]) {
  for (const item of verified) {
    const current = await fsp.stat(item.filename);
    if (current.size !== item.size || current.mtimeMs !== item.mtimeMs) throw new Error(`Refusing deletion because file changed after verification: ${item.filename}`);
  }
  for (const item of verified) await fsp.unlink(item.filename);
  console.log(`Deleted ${verified.length} independently verified local videos and reclaimed ${formatBytes(totalBytes)}.`);
} else {
  console.log("Local files retained. Pass --delete-local only when deletion is intended.");
}

function describeObject(uri) { return JSON.parse(run("gcloud", ["storage", "objects", "describe", uri, `--project=${config.projectId}`, `--impersonate-service-account=${config.uploaderServiceAccount}`, "--format=json"], { capture: true })); }
function readMetadata(object) { return object.metadata || object.custom_metadata || object.custom_fields || {}; }
function readMd5(object) { return object.md5Hash || object.md5_hash || ""; }
function encodeObjectPath(uri) { return uri.replace(/^gs:\/\/[^/]+\//, "").split("/").map(encodeURIComponent).join("/"); }
async function hashFile(filename) {
  const sha256 = crypto.createHash("sha256"); const md5 = crypto.createHash("md5");
  await new Promise((resolve, reject) => { const stream = fs.createReadStream(filename); stream.on("data", (chunk) => { sha256.update(chunk); md5.update(chunk); }); stream.on("error", reject); stream.on("end", resolve); });
  return { sha256: sha256.digest("hex"), md5Base64: md5.digest("base64") };
}
function formatBytes(bytes) { return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`; }

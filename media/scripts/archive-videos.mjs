#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, run } from "../../customers/scripts/lib/cli.mjs";
import { executeSql, sqlLiteral } from "../../customers/scripts/lib/db.mjs";
import { loadMediaConfig, requireMediaConfig, repositoryRoot } from "./lib/config.mjs";

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".avi", ".mkv"]);
const DERIVED_PARENTS = new Map([
  ["toonworld-first-concert-under-500mb.mp4", "Screen Recording 2026-06-15 at 4.50.36 PM.mov"],
  ["launch1-under-500mb.mp4", "launch1 .mp4"],
  ["Screen Recording 2026-06-26 at 9.12.34 PM.discord-under-500mb.mp4", "Screen Recording 2026-06-26 at 9.12.34 PM.mov"],
  ["backingup-under-500mb.mp4", "backingup.original.mov"],
  ["Screen Recording 2026-04-20 at 8.50.31 PM-compressed.mp4", "Screen Recording 2026-04-20 at 8.50.31 PM.mov"],
  ["Screen Recording 2026-06-20 at 12.11.34 PM-20m38s-to-20m48s-silent-under-10mb.mp4", "Screen Recording 2026-06-20 at 12.11.34 PM.mov"],
  ["Screen Recording 2026-06-20 at 12.11.34 PM-16m38s-to-16m46s-silent-under-10mb.mp4", "Screen Recording 2026-06-20 at 12.11.34 PM.mov"],
]);
const CLASSIFICATIONS = new Map([
  ["Screen Recording 2026-07-31 at 2.38.18 PM.mov", "business-conversation"],
  ["Screen Recording 2026-08-17 at 2.18.17 PM.mov", "business-conversation"],
  ["Screen Recording 2026-08-21 at 1.00.02 PM.mov", "business-conversation"],
  ["Screen Recording 2026-08-24 at 7.28.52 PM.mov", "business-conversation"],
  ["Screen Recording 2026-08-28 at 5.29.12 PM.mov", "company-workshop"],
]);

const args = parseArgs(process.argv.slice(2));
const sourceDirectory = path.resolve(args.directory || path.join(os.homedir(), "Desktop"));
const config = loadMediaConfig();
requireMediaConfig(config, ["projectId", "bucket", "uploaderServiceAccount"]);
run("bash", ["media/scripts/verify-private-gcs.sh"], { cwd: repositoryRoot });

const names = (await fsp.readdir(sourceDirectory)).filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
const assets = [];
for (const name of names) {
  const filename = path.join(sourceDirectory, name);
  const stat = await fsp.stat(filename);
  if (!stat.isFile()) continue;
  process.stdout.write(`Hashing ${name} ... `);
  const hashes = await hashFile(filename);
  console.log(hashes.sha256);
  const captured = captureTime(name, stat);
  assets.push({
    name, filename, stat, ...hashes, ...captured,
    assetId: stableUuid(`${hashes.sha256}\0${name}`),
    durationMs: mediaDuration(filename),
    classification: CLASSIFICATIONS.get(name) || args.classification || "company-media",
    parentName: DERIVED_PARENTS.get(name) || null,
  });
}
const byName = new Map(assets.map((asset) => [asset.name, asset]));
for (const asset of assets) {
  asset.parent = asset.parentName ? byName.get(asset.parentName) : null;
  if (asset.parentName && !asset.parent) throw new Error(`Missing local parent ${asset.parentName} for ${asset.name}`);
}
assets.sort((left, right) => Number(Boolean(left.parent)) - Number(Boolean(right.parent)) || left.name.localeCompare(right.name));

let uploadedBytes = 0;
for (const [index, asset] of assets.entries()) {
  const date = asset.capturedAt.slice(0, 10).replaceAll("-", "/");
  const objectKey = `raw-videos/${date}/${asset.sha256}/${asset.name}`;
  const storageUri = `gs://${config.bucket}/${objectKey}`;
  console.log(`[${index + 1}/${assets.length}] Archiving ${asset.name}`);
  run("gcloud", ["storage", "cp", "--no-clobber", `--content-md5=${asset.md5Base64}`,
    `--project=${config.projectId}`, `--impersonate-service-account=${config.uploaderServiceAccount}`,
    `--content-type=${contentType(asset.name)}`,
    `--custom-metadata=portomatic-sha256=${asset.sha256},portomatic-asset-id=${asset.assetId},portomatic-source=private-media-original`,
    asset.filename, storageUri], { cwd: repositoryRoot });
  const object = describeObject(storageUri, config);
  verifyRemote(asset, object, storageUri);

  const manifest = {
    manifest_version: 1,
    asset: {
      asset_id: asset.assetId,
      storage_uri: storageUri,
      object_generation: String(object.generation),
      sha256: asset.sha256,
      md5_base64: asset.md5Base64,
      bytes: String(asset.stat.size),
      duration_ms: asset.durationMs == null ? null : String(asset.durationMs),
      content_type: contentType(asset.name),
      source_filename: asset.name,
      captured_at: asset.capturedAt,
      captured_at_precision: asset.capturedAtPrecision,
      classification: asset.classification,
      source_kind: asset.parent ? "derived" : "original",
      parent_asset_id: asset.parent?.assetId || null,
      gcs_crc32c: object.crc32c || object.crc32c_hash || null,
    },
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = crypto.createHash("sha256").update(manifestBody).digest("hex");
  const manifestMd5 = crypto.createHash("md5").update(manifestBody).digest("base64");
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "portomatic-media-manifest-"));
  const manifestFile = path.join(temporaryDirectory, "manifest.json");
  await fsp.writeFile(manifestFile, manifestBody, { mode: 0o600 });
  const manifestUri = `gs://${config.bucket}/manifests/${asset.assetId}/${manifestSha256}.json`;
  try {
    run("gcloud", ["storage", "cp", "--no-clobber", `--content-md5=${manifestMd5}`,
      `--project=${config.projectId}`, `--impersonate-service-account=${config.uploaderServiceAccount}`,
      "--content-type=application/json", `--custom-metadata=portomatic-sha256=${manifestSha256},portomatic-asset-id=${asset.assetId},portomatic-source=media-manifest`,
      manifestFile, manifestUri], { cwd: repositoryRoot });
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
  const manifestObject = describeObject(manifestUri, config);
  if (Number(manifestObject.size) !== Buffer.byteLength(manifestBody) || readMetadata(manifestObject)["portomatic-sha256"] !== manifestSha256 || readMd5(manifestObject) !== manifestMd5) {
    throw new Error(`Manifest verification failed for ${manifestUri}`);
  }

  await executeSql(buildInsertSql({ asset, object, storageUri, manifestUri, manifestSha256, manifestObject }), { application: "portomatic_media_archive" });
  uploadedBytes += asset.stat.size;
  console.log(`Verified ${storageUri} (${formatBytes(uploadedBytes)} cumulative)`);
}
console.log(`Archived and cataloged ${assets.length} videos totaling ${formatBytes(uploadedBytes)}. Local files were retained pending an independent verification pass.`);

function buildInsertSql({ asset, object, storageUri, manifestUri, manifestSha256, manifestObject }) {
  const values = [asset.assetId, storageUri, String(object.generation), asset.sha256, asset.md5Base64, asset.stat.size,
    asset.durationMs, contentType(asset.name), asset.name, asset.capturedAt, asset.capturedAtPrecision, asset.classification,
    asset.parent ? "derived" : "original", asset.parent?.assetId || null, manifestUri, String(manifestObject.generation), manifestSha256];
  const columns = ["asset_id", "storage_uri", "object_generation", "sha256", "md5_base64", "bytes", "duration_ms", "content_type", "source_filename", "captured_at", "captured_at_precision", "classification", "source_kind", "parent_asset_id", "manifest_uri", "manifest_generation", "manifest_sha256"];
  return `BEGIN;\nINSERT INTO media_archive_assets(${columns.join(", ")}) VALUES (${values.map(sqlLiteral).join(", ")}) ON CONFLICT (asset_id) DO NOTHING;\nDO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM media_archive_assets WHERE asset_id=${sqlLiteral(asset.assetId)}::uuid AND storage_uri=${sqlLiteral(storageUri)} AND object_generation=${sqlLiteral(String(object.generation))}::bigint AND sha256=${sqlLiteral(asset.sha256)} AND bytes=${asset.stat.size} AND manifest_uri=${sqlLiteral(manifestUri)} AND manifest_generation=${sqlLiteral(String(manifestObject.generation))}::bigint AND manifest_sha256=${sqlLiteral(manifestSha256)}) THEN RAISE EXCEPTION 'immutable media asset conflicts with existing catalog entry'; END IF; END $$;\nCOMMIT;`;
}

function describeObject(uri, settings) {
  return JSON.parse(run("gcloud", ["storage", "objects", "describe", uri, `--project=${settings.projectId}`, `--impersonate-service-account=${settings.uploaderServiceAccount}`, "--format=json"], { capture: true }));
}
function verifyRemote(asset, object, uri) {
  if (Number(object.size) !== asset.stat.size) throw new Error(`Remote size mismatch for ${uri}`);
  if (readMd5(object) !== asset.md5Base64) throw new Error(`Remote MD5 mismatch for ${uri}`);
  if (readMetadata(object)["portomatic-sha256"] !== asset.sha256) throw new Error(`Remote SHA-256 metadata mismatch for ${uri}`);
  if (!object.generation) throw new Error(`Remote generation missing for ${uri}`);
}
function readMetadata(object) { return object.metadata || object.custom_metadata || object.custom_fields || {}; }
function readMd5(object) { return object.md5Hash || object.md5_hash || ""; }
async function hashFile(filename) {
  const sha256 = crypto.createHash("sha256");
  const md5 = crypto.createHash("md5");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on("data", (chunk) => { sha256.update(chunk); md5.update(chunk); });
    stream.on("error", reject); stream.on("end", resolve);
  });
  return { sha256: sha256.digest("hex"), md5Base64: md5.digest("base64") };
}
function stableUuid(input) {
  const bytes = crypto.createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function captureTime(name, stat) {
  const match = name.match(/Screen Recording (\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})\s*([AP]M)/i);
  if (!match) return { capturedAt: (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString(), capturedAtPrecision: "filesystem" };
  let hour = Number(match[4]) % 12; if (match[7].toUpperCase() === "PM") hour += 12;
  const value = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, Number(match[5]), Number(match[6]));
  return { capturedAt: value.toISOString(), capturedAtPrecision: "second" };
}
function mediaDuration(filename) {
  try { const value = Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filename], { capture: true }).trim()); return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null; } catch { return null; }
}
function contentType(name) { return path.extname(name).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4"; }
function formatBytes(bytes) { return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`; }

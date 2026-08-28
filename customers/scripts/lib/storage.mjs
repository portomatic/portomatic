import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, requireConfig, repositoryRoot } from "./config.mjs";
import { run } from "./cli.mjs";

export async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function mediaDuration(filename) {
  const output = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filename], { capture: true });
  const value = Number(output.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Could not determine media duration for ${filename}`);
  return value;
}

export function describeObject(storageUri) {
  const config = loadConfig();
  requireConfig(config, ["projectId", "uploaderServiceAccount"]);
  return JSON.parse(run("gcloud", [
    "storage", "objects", "describe", storageUri,
    `--project=${config.projectId}`,
    `--impersonate-service-account=${config.uploaderServiceAccount}`,
    "--format=json",
  ], { capture: true }));
}

export async function uploadJsonObject(objectKey, value, metadata = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "portomatic-json-"));
  const filename = path.join(directory, "object.json");
  await fsp.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    return await uploadDerivedFile(filename, objectKey, "application/json", metadata);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

export async function uploadDerivedFile(filename, objectKey, contentType, metadata = {}) {
  const config = loadConfig();
  requireConfig(config, ["projectId", "bucket", "uploaderServiceAccount"]);
  const sha256 = await hashFile(filename);
  const storageUri = `gs://${config.bucket}/${objectKey}`;
  const customMetadata = { ...metadata, "portomatic-sha256": sha256 };
  run("gcloud", [
    "storage", "cp", "--no-clobber",
    `--project=${config.projectId}`,
    `--impersonate-service-account=${config.uploaderServiceAccount}`,
    `--content-type=${contentType}`,
    `--custom-metadata=${Object.entries(customMetadata).map(([key, value]) => `${key}=${String(value)}`).join(",")}`,
    path.resolve(filename), storageUri,
  ], { cwd: repositoryRoot });
  const description = describeObject(storageUri);
  if (Number(description.size) !== (await fsp.stat(filename)).size) throw new Error(`Remote size verification failed for ${storageUri}`);
  const remoteSha = objectMetadata(description)["portomatic-sha256"];
  if (remoteSha !== sha256) throw new Error(`Remote SHA-256 verification failed for ${storageUri}`);
  return { storageUri, sha256, description };
}

export function objectMetadata(description) {
  return description.metadata || description.custom_metadata || description.custom_fields || {};
}

export function parseGsUri(uri) {
  const match = String(uri).match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid GCS URI: ${uri}`);
  return { bucket: match[1], objectKey: match[2] };
}

export function contentType(extension) {
  return ({
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".vtt": "text/vtt; charset=utf-8",
  })[extension.toLowerCase()] || "application/octet-stream";
}

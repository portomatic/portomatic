#!/usr/bin/env node
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, requireArgs, run } from "./lib/cli.mjs";
import { loadConfig, requireConfig, repositoryRoot } from "./lib/config.mjs";
import { executeSql, sqlLiteral } from "./lib/db.mjs";
import { contentType, describeObject, hashFile, mediaDuration, objectMetadata, uploadJsonObject } from "./lib/storage.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["file", "manifest"]);
const config = loadConfig();
requireConfig(config, ["projectId", "bucket", "uploaderServiceAccount", "cloudSqlInstance", "cloudSqlDatabase"]);

const sourcePath = path.resolve(args.file);
const manifestPath = path.resolve(args.manifest);
const sourceStat = await fsp.stat(sourcePath);
if (!sourceStat.isFile()) throw new Error(`Not a file: ${sourcePath}`);
const input = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
validateManifest(input);
if (args["validate-only"]) {
  console.log(`Valid source manifest: ${manifestPath}`);
  process.exit(0);
}

run("bash", ["customers/scripts/verify-private-gcs.sh"], { cwd: repositoryRoot });

const sha256 = await hashFile(sourcePath);
const normalizedAudioSha256 = await decodedAudioHash(sourcePath);
const durationMs = Math.round(mediaDuration(sourcePath) * 1000);
for (const segment of input.segments) {
  if (segment.end_ms > durationMs) throw new Error(`Segment ${segment.segment_id} extends past the recording duration`);
}

const extension = path.extname(sourcePath).toLowerCase() || ".bin";
const date = input.source.recorded_at.slice(0, 10).replaceAll("-", "/");
const objectKey = input.source.object_key || `raw-recordings/${date}/${input.source.source_id}${extension}`;
if (objectKey.startsWith("/") || objectKey.includes("..")) throw new Error("source.object_key must be a safe bucket-relative key");
const storageUri = `gs://${config.bucket}/${objectKey}`;

run("gcloud", [
  "storage", "cp", "--no-clobber",
  `--project=${config.projectId}`,
  `--impersonate-service-account=${config.uploaderServiceAccount}`,
  `--content-type=${contentType(extension)}`,
  `--custom-metadata=portomatic-source-id=${input.source.source_id},portomatic-sha256=${sha256},portomatic-normalized-audio-sha256=${normalizedAudioSha256},portomatic-source=raw-recording`,
  sourcePath, storageUri,
], { cwd: repositoryRoot });

const object = describeObject(storageUri);
const remoteMetadata = objectMetadata(object);
if (
  remoteMetadata["portomatic-sha256"] !== sha256 ||
  remoteMetadata["portomatic-normalized-audio-sha256"] !== normalizedAudioSha256 ||
  Number(object.size) !== sourceStat.size
) {
  throw new Error(`Remote object verification failed for ${storageUri}; refusing to write database metadata`);
}

const sourceManifest = {
  manifest_version: 2,
  source: {
    ...input.source,
    storage_uri: storageUri,
    object_generation: String(object.generation),
    sha256,
    normalized_audio_sha256: normalizedAudioSha256,
    bytes: String(sourceStat.size),
    duration_ms: String(durationMs),
    source_filename: path.basename(sourcePath),
    content_type: contentType(extension),
    gcs_crc32c: object.crc32c || object.crc32c_hash || null,
  },
  calls: input.calls,
  segments: input.segments,
};
const expectedManifestSha256 = crypto.createHash("sha256").update(`${JSON.stringify(sourceManifest, null, 2)}\n`).digest("hex");
const manifestKey = `source-manifests/${input.source.source_id}/${sha256}/${expectedManifestSha256}.json`;
const { storageUri: manifestUri, sha256: manifestSha256, description: manifestObject } = await uploadJsonObject(manifestKey, sourceManifest, {
  "portomatic-source-id": input.source.source_id,
  "portomatic-recording-sha256": sha256,
  "portomatic-source": "source-manifest",
});
if (manifestSha256 !== expectedManifestSha256) throw new Error("Source manifest serialization was not deterministic");

const sql = buildSql({
  input,
  storageUri,
  manifestUri,
  object,
  sha256,
  normalizedAudioSha256,
  sourceStat,
  sourcePath,
  extension,
  durationMs,
  manifestSha256,
  manifestObject,
});
await executeSql(sql, { application: "portomatic_source_upload" });

console.log(`Uploaded and verified immutable source: ${storageUri}`);
console.log(`Stored reconstruction manifest: ${manifestUri}`);
console.log(`Indexed ${input.segments.length} timestamped segment(s) across ${input.calls.length} conversation(s).`);

function validateManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Manifest must be a JSON object");
  const source = value.source;
  if (!source || typeof source !== "object") throw new Error("Manifest requires source");
  for (const field of ["source_id", "title", "source_type", "recorded_at", "recorded_at_precision"]) {
    if (!source[field]) throw new Error(`Manifest source requires ${field}`);
  }
  validateId(source.source_id, "source.source_id");
  if (Number.isNaN(Date.parse(source.recorded_at))) throw new Error("source.recorded_at must be ISO 8601 with a timezone");
  if (!["second", "minute", "calendar", "day"].includes(source.recorded_at_precision)) {
    throw new Error("source.recorded_at_precision must be second, minute, calendar, or day");
  }
  if (!Array.isArray(value.calls)) throw new Error("Manifest calls must be an array");
  if (!Array.isArray(value.segments)) throw new Error("Manifest segments must be an array");
  if (value.calls.length === 0 || value.segments.length === 0) {
    if (value.calls.length !== 0 || value.segments.length !== 0) throw new Error("A manifest must have both calls and segments, or neither");
    if (source.review_status !== "excluded" || !source.exclusion_reason) {
      throw new Error("A zero-call correction requires source.review_status=excluded and source.exclusion_reason");
    }
  }
  const callIds = new Set();
  for (const call of value.calls) {
    for (const field of ["call_id", "title", "recorded_at"]) if (!call[field]) throw new Error(`Call requires ${field}`);
    if (!call.customer) throw new Error(`Call ${call.call_id} requires customer`);
    for (const field of ["slug", "name"]) if (!call.customer[field]) throw new Error(`Call ${call.call_id} customer requires ${field}`);
    validateId(call.call_id, "call.call_id");
    validateId(call.customer.slug, "call.customer.slug");
    if (Number.isNaN(Date.parse(call.recorded_at))) throw new Error(`Call ${call.call_id} recorded_at must be ISO 8601 with a timezone`);
    if (callIds.has(call.call_id)) throw new Error(`Duplicate call_id: ${call.call_id}`);
    callIds.add(call.call_id);
  }
  const segmentIds = new Set();
  for (const segment of value.segments) {
    validateId(segment.segment_id, "segment.segment_id");
    if (segmentIds.has(segment.segment_id)) throw new Error(`Duplicate segment_id: ${segment.segment_id}`);
    segmentIds.add(segment.segment_id);
    if (!callIds.has(segment.call_id)) throw new Error(`Segment ${segment.segment_id} references an unknown call_id`);
    if (!Number.isInteger(segment.start_ms) || !Number.isInteger(segment.end_ms) || segment.start_ms < 0 || segment.end_ms <= segment.start_ms) {
      throw new Error(`Segment ${segment.segment_id} has invalid integer millisecond boundaries`);
    }
    for (const field of ["segment_kind", "interaction_type", "portomatic_relevance", "identity_confidence", "review_status"]) {
      if (!segment[field]) throw new Error(`Segment ${segment.segment_id} requires ${field}`);
    }
  }
  for (const segment of value.segments) {
    if (segment.parent_segment_id && !segmentIds.has(segment.parent_segment_id)) {
      throw new Error(`Segment ${segment.segment_id} references an unknown parent_segment_id`);
    }
  }
}

function validateId(value, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${name} must be lowercase kebab-case`);
}

async function decodedAudioHash(filename) {
  const hash = crypto.createHash("sha256");
  const process = spawn("ffmpeg", [
    "-v", "error", "-i", filename, "-map", "0:a:0", "-vn",
    "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  process.stdout.on("data", (chunk) => hash.update(chunk));
  process.stderr.setEncoding("utf8");
  process.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    process.on("error", reject);
    process.on("close", resolve);
  });
  if (status !== 0) throw new Error(`ffmpeg could not decode ${filename}: ${stderr.trim()}`);
  return hash.digest("hex");
}

function buildSql(context) {
  const {
    input, storageUri, manifestUri, object, sha256, normalizedAudioSha256,
    sourceStat, sourcePath, extension, durationMs, manifestSha256, manifestObject,
  } = context;
  const statements = ["BEGIN;"];
  for (const call of input.calls) {
    statements.push(`
INSERT INTO customers(slug, name, company)
VALUES (${sqlLiteral(call.customer.slug)}, ${sqlLiteral(call.customer.name)}, ${sqlLiteral(call.customer.company || null)})
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  company = EXCLUDED.company;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customers
    WHERE slug = ${sqlLiteral(call.customer.slug)}
      AND name = ${sqlLiteral(call.customer.name)}
      AND company IS NOT DISTINCT FROM ${sqlLiteral(call.customer.company || null)}
  ) THEN RAISE EXCEPTION 'customer identity conflicts with existing slug'; END IF;
END $$;

INSERT INTO calls(call_id, primary_customer_id, title, recorded_at, notes)
SELECT ${sqlLiteral(call.call_id)}, customer_id, ${sqlLiteral(call.title)},
       ${sqlLiteral(call.recorded_at)}::timestamptz, ${sqlLiteral(call.notes || null)}
FROM customers WHERE slug = ${sqlLiteral(call.customer.slug)}
ON CONFLICT (call_id) DO UPDATE SET
  primary_customer_id = EXCLUDED.primary_customer_id,
  title = EXCLUDED.title,
  recorded_at = EXCLUDED.recorded_at,
  notes = EXCLUDED.notes;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM calls c JOIN customers cu ON cu.customer_id = c.primary_customer_id
    WHERE c.call_id = ${sqlLiteral(call.call_id)}
      AND cu.slug = ${sqlLiteral(call.customer.slug)}
      AND c.title = ${sqlLiteral(call.title)}
      AND c.recorded_at = ${sqlLiteral(call.recorded_at)}::timestamptz
      AND c.notes IS NOT DISTINCT FROM ${sqlLiteral(call.notes || null)}
  ) THEN RAISE EXCEPTION 'call identity conflicts with existing customer'; END IF;
END $$;`);
  }
  statements.push(`
INSERT INTO recording_objects(
  storage_uri, object_generation, sha256, bytes, duration_ms, recorded_at,
  source_filename, content_type, gcs_crc32c, source_id, source_title, source_type,
  recorded_at_precision, recorded_local_date, normalized_audio_sha256, source_manifest_uri
) VALUES (
  ${sqlLiteral(storageUri)}, ${sqlLiteral(String(object.generation))}::bigint, ${sqlLiteral(sha256)},
  ${sourceStat.size}, ${durationMs}, ${sqlLiteral(input.source.recorded_at)}::timestamptz,
  ${sqlLiteral(path.basename(sourcePath))}, ${sqlLiteral(contentType(extension))},
  ${sqlLiteral(object.crc32c || object.crc32c_hash || null)}, ${sqlLiteral(input.source.source_id)},
  ${sqlLiteral(input.source.title)}, ${sqlLiteral(input.source.source_type)},
  ${sqlLiteral(input.source.recorded_at_precision)}, ${sqlLiteral(input.source.recorded_at.slice(0, 10))}::date,
  ${sqlLiteral(normalizedAudioSha256)}, ${sqlLiteral(manifestUri)}
)
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recording_objects
    WHERE source_id = ${sqlLiteral(input.source.source_id)}
      AND storage_uri = ${sqlLiteral(storageUri)}
      AND object_generation = ${sqlLiteral(String(object.generation))}::bigint
      AND sha256 = ${sqlLiteral(sha256)}
      AND bytes = ${sourceStat.size}
      AND duration_ms = ${durationMs}
      AND recorded_at = ${sqlLiteral(input.source.recorded_at)}::timestamptz
      AND recorded_local_date = ${sqlLiteral(input.source.recorded_at.slice(0, 10))}::date
      AND source_filename = ${sqlLiteral(path.basename(sourcePath))}
      AND content_type = ${sqlLiteral(contentType(extension))}
      AND normalized_audio_sha256 = ${sqlLiteral(normalizedAudioSha256)}
      AND source_title = ${sqlLiteral(input.source.title)}
      AND source_type = ${sqlLiteral(input.source.source_type)}
      AND recorded_at_precision = ${sqlLiteral(input.source.recorded_at_precision)}
  ) THEN RAISE EXCEPTION 'source identity conflicts with an existing immutable recording'; END IF;
END $$;`);
  statements.push(`
INSERT INTO recording_source_manifests(
  recording_id, storage_uri, object_generation, sha256, is_current
)
SELECT recording_id, ${sqlLiteral(manifestUri)}, ${sqlLiteral(String(manifestObject.generation))}::bigint,
       ${sqlLiteral(manifestSha256)}, false
FROM recording_objects WHERE source_id = ${sqlLiteral(input.source.source_id)}
ON CONFLICT (storage_uri, object_generation) DO NOTHING;`);
  for (const call of input.calls) {
    statements.push(`
INSERT INTO call_recordings(call_id, recording_id, sequence, manifest_uri)
SELECT ${sqlLiteral(call.call_id)}, recording_id,
       COALESCE((SELECT max(sequence) + 1 FROM call_recordings WHERE call_id = ${sqlLiteral(call.call_id)}), 1),
       ${sqlLiteral(manifestUri)}
FROM recording_objects WHERE source_id = ${sqlLiteral(input.source.source_id)}
ON CONFLICT (call_id, recording_id) DO UPDATE SET manifest_uri = EXCLUDED.manifest_uri;`);
  }
  statements.push(`
DELETE FROM recording_segments rs
USING recording_objects ro
WHERE rs.recording_id = ro.recording_id
  AND ro.source_id = ${sqlLiteral(input.source.source_id)}
  AND rs.parent_segment_id IS NULL;`);
  for (const segment of topologicallyOrderedSegments(input.segments)) {
    statements.push(segmentInsert(segment, input.source.source_id, manifestUri, manifestObject.generation));
  }
  statements.push(`
UPDATE recording_source_manifests rsm
SET is_current = false
FROM recording_objects ro
WHERE rsm.recording_id = ro.recording_id
  AND ro.source_id = ${sqlLiteral(input.source.source_id)}
  AND rsm.is_current;

UPDATE recording_source_manifests
SET is_current = true
WHERE storage_uri = ${sqlLiteral(manifestUri)}
  AND object_generation = ${sqlLiteral(String(manifestObject.generation))}::bigint
  AND sha256 = ${sqlLiteral(manifestSha256)};

UPDATE transcript_runs tr
SET is_current = false
FROM call_recordings cr
JOIN recording_objects ro USING (recording_id)
WHERE tr.call_id = cr.call_id
  AND tr.recording_id = cr.recording_id
  AND ro.source_id = ${sqlLiteral(input.source.source_id)}
  AND tr.is_current
  AND NOT EXISTS (
    SELECT 1 FROM recording_segments rs
    JOIN recording_source_manifests rsm USING (manifest_id)
    WHERE rs.call_id = tr.call_id
      AND rs.recording_id = tr.recording_id
      AND rsm.is_current
      AND rs.review_status IN ('confirmed', 'provisional')
      AND rs.portomatic_relevance <> 'not_relevant'
  );`);
  statements.push("COMMIT;");
  return statements.join("\n");
}

function segmentInsert(segment, sourceId, manifestUri, manifestGeneration) {
  return `
INSERT INTO recording_segments(
  segment_id, recording_id, manifest_id, call_id, parent_segment_id, start_ms, end_ms,
  segment_kind, interaction_type, portomatic_relevance, identity_confidence,
  review_status, evidence, notes
)
SELECT
  ${sqlLiteral(segment.segment_id)}, ro.recording_id, rsm.manifest_id, ${sqlLiteral(segment.call_id)},
  ${sqlLiteral(segment.parent_segment_id || null)}, ${segment.start_ms}, ${segment.end_ms},
  ${sqlLiteral(segment.segment_kind)}, ${sqlLiteral(segment.interaction_type)},
  ${sqlLiteral(segment.portomatic_relevance)}, ${sqlLiteral(segment.identity_confidence)},
  ${sqlLiteral(segment.review_status)}, ${sqlLiteral(segment.evidence || null)}, ${sqlLiteral(segment.notes || null)}
FROM recording_objects ro
JOIN recording_source_manifests rsm ON rsm.recording_id = ro.recording_id
WHERE ro.source_id = ${sqlLiteral(sourceId)}
  AND rsm.storage_uri = ${sqlLiteral(manifestUri)}
  AND rsm.object_generation = ${sqlLiteral(String(manifestGeneration))}::bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recording_segments rs JOIN recording_objects ro USING (recording_id)
    WHERE rs.segment_id = ${sqlLiteral(segment.segment_id)}
      AND ro.source_id = ${sqlLiteral(sourceId)}
      AND rs.call_id = ${sqlLiteral(segment.call_id)}
      AND rs.parent_segment_id IS NOT DISTINCT FROM ${sqlLiteral(segment.parent_segment_id || null)}
      AND rs.start_ms = ${segment.start_ms} AND rs.end_ms = ${segment.end_ms}
      AND rs.segment_kind = ${sqlLiteral(segment.segment_kind)}
      AND rs.interaction_type = ${sqlLiteral(segment.interaction_type)}
      AND rs.portomatic_relevance = ${sqlLiteral(segment.portomatic_relevance)}
      AND rs.identity_confidence = ${sqlLiteral(segment.identity_confidence)}
      AND rs.review_status = ${sqlLiteral(segment.review_status)}
      AND rs.evidence IS NOT DISTINCT FROM ${sqlLiteral(segment.evidence || null)}
      AND rs.notes IS NOT DISTINCT FROM ${sqlLiteral(segment.notes || null)}
  ) THEN RAISE EXCEPTION 'segment identity conflicts with existing metadata'; END IF;
END $$;`;
}

function topologicallyOrderedSegments(segments) {
  const pending = new Map(segments.map((segment) => [segment.segment_id, segment]));
  const inserted = new Set();
  const ordered = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [segmentId, segment] of pending) {
      if (!segment.parent_segment_id || inserted.has(segment.parent_segment_id)) {
        ordered.push(segment);
        inserted.add(segmentId);
        pending.delete(segmentId);
        progressed = true;
      }
    }
    if (!progressed) throw new Error("Segment parent relationships contain a cycle");
  }
  return ordered;
}

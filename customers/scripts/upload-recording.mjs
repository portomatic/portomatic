#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArgs, run } from "./lib/cli.mjs";
import { loadConfig, requireConfig, repositoryRoot } from "./lib/config.mjs";
import { executeSql, sqlLiteral } from "./lib/db.mjs";
import { contentType, describeObject, hashFile, mediaDuration, objectMetadata, uploadJsonObject } from "./lib/storage.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["file", "call-id", "customer-name", "customer-slug", "recorded-at"]);
const config = loadConfig();
requireConfig(config, ["projectId", "bucket", "uploaderServiceAccount", "cloudSqlInstance", "cloudSqlDatabase"]);

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
const objectKey = args["object-key"] || `raw-recordings/${date.replaceAll("-", "/")}/${args["call-id"]}${extension}`;
if (objectKey.startsWith("/") || objectKey.includes("..")) throw new Error("--object-key must be a safe bucket-relative key");
const storageUri = `gs://${config.bucket}/${objectKey}`;

run("gcloud", [
  "storage", "cp", "--no-clobber",
  `--project=${config.projectId}`,
  `--impersonate-service-account=${config.uploaderServiceAccount}`,
  `--content-type=${contentType(extension)}`,
  `--custom-metadata=portomatic-call-id=${args["call-id"]},portomatic-sha256=${sha256},portomatic-source=raw-recording`,
  sourcePath, storageUri,
]);

const object = describeObject(storageUri);
const remoteSha256 = objectMetadata(object)["portomatic-sha256"];
if (remoteSha256 !== sha256 || Number(object.size) !== sourceStat.size) {
  throw new Error(`Remote object verification failed for ${storageUri}; refusing to write metadata`);
}

const manifest = {
  manifest_version: 1,
  call: {
    call_id: args["call-id"],
    customer_slug: args["customer-slug"],
    customer_name: args["customer-name"],
    title: args.title || args["customer-name"],
    recorded_at: args["recorded-at"],
  },
  recording: {
    storage_uri: storageUri,
    object_generation: String(object.generation),
    sha256,
    bytes: String(sourceStat.size),
    duration_ms: String(Math.round(duration * 1000)),
    recorded_at: args["recorded-at"],
    source_filename: path.basename(sourcePath),
    content_type: contentType(extension),
    gcs_crc32c: object.crc32c || object.crc32c_hash || null,
  },
};
const manifestKey = `call-manifests/${args["call-id"]}/${sha256}.json`;
const { storageUri: manifestUri } = await uploadJsonObject(manifestKey, manifest, {
  "portomatic-call-id": args["call-id"],
  "portomatic-recording-sha256": sha256,
  "portomatic-source": "call-manifest",
});

const sql = `
BEGIN;
INSERT INTO customers(slug, name)
VALUES (${sqlLiteral(args["customer-slug"])}, ${sqlLiteral(args["customer-name"])})
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customers
    WHERE slug = ${sqlLiteral(args["customer-slug"])} AND name = ${sqlLiteral(args["customer-name"])}
  ) THEN
    RAISE EXCEPTION 'customer identity conflicts with existing slug';
  END IF;
END $$;

INSERT INTO calls(call_id, primary_customer_id, title, recorded_at)
SELECT ${sqlLiteral(args["call-id"])}, customer_id, ${sqlLiteral(args.title || args["customer-name"])}, ${sqlLiteral(args["recorded-at"])}::timestamptz
FROM customers WHERE slug = ${sqlLiteral(args["customer-slug"])}
ON CONFLICT (call_id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM calls c JOIN customers cu ON cu.customer_id = c.primary_customer_id
    WHERE c.call_id = ${sqlLiteral(args["call-id"])} AND cu.slug = ${sqlLiteral(args["customer-slug"])}
  ) THEN
    RAISE EXCEPTION 'call identity conflicts with existing customer';
  END IF;
END $$;

INSERT INTO recording_objects(
  storage_uri, object_generation, sha256, bytes, duration_ms, recorded_at,
  source_filename, content_type, gcs_crc32c
) VALUES (
  ${sqlLiteral(storageUri)}, ${sqlLiteral(String(object.generation))}::bigint, ${sqlLiteral(sha256)},
  ${sourceStat.size}, ${Math.round(duration * 1000)}, ${sqlLiteral(args["recorded-at"])}::timestamptz,
  ${sqlLiteral(path.basename(sourcePath))}, ${sqlLiteral(contentType(extension))},
  ${sqlLiteral(object.crc32c || object.crc32c_hash || null)}
);

INSERT INTO call_recordings(call_id, recording_id, sequence, manifest_uri)
SELECT ${sqlLiteral(args["call-id"])}, recording_id,
       COALESCE((SELECT max(sequence) + 1 FROM call_recordings WHERE call_id = ${sqlLiteral(args["call-id"])}), 1),
       ${sqlLiteral(manifestUri)}
FROM recording_objects WHERE storage_uri = ${sqlLiteral(storageUri)};
COMMIT;
`;
await executeSql(sql, { application: "portomatic_upload" });

console.log(`Uploaded and verified immutable recording: ${storageUri}`);
console.log(`Stored reconstruction manifest: ${manifestUri}`);
console.log(`Indexed call in Cloud SQL: ${args["call-id"]}`);

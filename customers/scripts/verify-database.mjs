#!/usr/bin/env node
import { queryRows } from "./lib/db.mjs";
import { describeObject, objectMetadata } from "./lib/storage.mjs";

const summaries = await queryRows(`
  SELECT
    (SELECT count(*) FROM calls) AS calls,
    (SELECT count(*) FROM recording_objects) AS recordings,
    (SELECT count(*) FROM transcript_runs WHERE is_current) AS current_transcripts,
    (SELECT count(*) FROM current_transcript_segments) AS current_segments,
    (SELECT count(*) FROM transcript_runs tr
      WHERE tr.is_current AND NOT EXISTS (
        SELECT 1 FROM transcript_segments ts WHERE ts.transcript_run_id = tr.transcript_run_id
      )) AS empty_current_transcripts;
`, { rowLimit: 1 });
const summary = summaries[0];
if (!summary || Number(summary.empty_current_transcripts) !== 0) throw new Error("Database has an invalid current transcript run");

const recordings = await queryRows(`
  SELECT storage_uri, object_generation, sha256, bytes
  FROM recording_objects ORDER BY recorded_at, storage_uri;
`, { rowLimit: 100000 });
for (const recording of recordings) {
  const remote = describeObject(recording.storage_uri);
  const remoteSha = objectMetadata(remote)["portomatic-sha256"];
  if (String(remote.generation) !== String(recording.object_generation)) throw new Error(`GCS generation mismatch: ${recording.storage_uri}`);
  if (String(remote.size) !== String(recording.bytes)) throw new Error(`GCS size mismatch: ${recording.storage_uri}`);
  if (remoteSha !== recording.sha256) throw new Error(`GCS SHA-256 metadata mismatch: ${recording.storage_uri}`);
}

const manifests = await queryRows(`SELECT manifest_uri FROM call_recordings ORDER BY call_id, sequence;`, { rowLimit: 100000 });
for (const manifest of manifests) describeObject(manifest.manifest_uri);

const artifacts = await queryRows(`
  SELECT artifact_uri, artifact_sha256 FROM transcript_runs WHERE is_current ORDER BY call_id, recording_id;
`, { rowLimit: 100000 });
for (const artifact of artifacts) {
  const remote = describeObject(artifact.artifact_uri);
  if (objectMetadata(remote)["portomatic-sha256"] !== artifact.artifact_sha256) {
    throw new Error(`Transcript artifact SHA-256 mismatch: ${artifact.artifact_uri}`);
  }
}

console.log(`PASS: ${summary.calls} calls, ${summary.recordings} immutable recordings, ${summary.current_transcripts} current transcripts, ${summary.current_segments} searchable segments.`);
console.log("PASS: every recording generation, byte count, and SHA-256 matches protected GCS.");
console.log("PASS: every reconstruction manifest and current derived-transcript artifact exists in protected GCS.");

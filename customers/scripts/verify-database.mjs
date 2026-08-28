#!/usr/bin/env node
import { queryRows } from "./lib/db.mjs";
import { describeObject, objectMetadata } from "./lib/storage.mjs";

const summaries = await queryRows(`
  SELECT
    (SELECT count(*) FROM calls) AS calls,
    (SELECT count(*) FROM recording_objects) AS recordings,
    (SELECT count(*) FROM recording_segments) AS recording_segments,
    (SELECT count(*) FROM conversation_catalog) AS conversations,
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
  SELECT storage_uri, object_generation, sha256, normalized_audio_sha256, bytes, source_manifest_uri
  FROM recording_objects ORDER BY recorded_at, storage_uri;
`, { rowLimit: 100000 });
for (const recording of recordings) {
  const remote = describeObject(recording.storage_uri);
  const remoteSha = objectMetadata(remote)["portomatic-sha256"];
  if (String(remote.generation) !== String(recording.object_generation)) throw new Error(`GCS generation mismatch: ${recording.storage_uri}`);
  if (String(remote.size) !== String(recording.bytes)) throw new Error(`GCS size mismatch: ${recording.storage_uri}`);
  if (remoteSha !== recording.sha256) throw new Error(`GCS SHA-256 metadata mismatch: ${recording.storage_uri}`);
  if (recording.normalized_audio_sha256 && objectMetadata(remote)["portomatic-normalized-audio-sha256"] !== recording.normalized_audio_sha256) {
    throw new Error(`GCS normalized-audio SHA-256 metadata mismatch: ${recording.storage_uri}`);
  }
  if (recording.source_manifest_uri) describeObject(recording.source_manifest_uri);
}

const sourceManifests = await queryRows(`
  SELECT rsm.storage_uri, rsm.object_generation, rsm.sha256
  FROM recording_source_manifests rsm
  JOIN recording_objects ro USING (recording_id)
  WHERE rsm.is_current
  ORDER BY ro.recorded_at, rsm.storage_uri;
`, { rowLimit: 100000 });
const sourceRecordingCounts = await queryRows(`
  SELECT
    count(*) FILTER (WHERE source_id IS NOT NULL) AS sources,
    count(*) FILTER (
      WHERE source_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM recording_source_manifests rsm
        WHERE rsm.recording_id = recording_objects.recording_id AND rsm.is_current
      )
    ) AS sources_with_manifest
  FROM recording_objects;
`, { rowLimit: 1 });
if (sourceRecordingCounts[0]?.sources !== sourceRecordingCounts[0]?.sources_with_manifest) {
  throw new Error("A source recording does not have exactly one pinned current manifest");
}
const staleSegmentCounts = await queryRows(`
  SELECT count(*) AS count
  FROM recording_segments rs
  JOIN recording_source_manifests rsm ON rsm.manifest_id = rs.manifest_id
  WHERE NOT rsm.is_current;
`, { rowLimit: 1 });
if (Number(staleSegmentCounts[0]?.count) !== 0) throw new Error("A catalog segment is not linked to its recording's current manifest");
const inactiveTranscriptCounts = await queryRows(`
  SELECT count(*) AS count
  FROM transcript_runs tr
  LEFT JOIN active_call_recordings acr USING (call_id, recording_id)
  WHERE tr.is_current AND acr.call_id IS NULL;
`, { rowLimit: 1 });
if (Number(inactiveTranscriptCounts[0]?.count) !== 0) throw new Error("An inactive corrected call still has a current transcript");
for (const manifest of sourceManifests) {
  const remote = describeObject(manifest.storage_uri);
  if (String(remote.generation) !== String(manifest.object_generation)) throw new Error(`Source manifest generation mismatch: ${manifest.storage_uri}`);
  if (objectMetadata(remote)["portomatic-sha256"] !== manifest.sha256) throw new Error(`Source manifest SHA-256 mismatch: ${manifest.storage_uri}`);
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
console.log(`PASS: ${summary.conversations || 0} confirmed/annotated conversations and ${summary.recording_segments || 0} source-timeline segments are queryable.`);
console.log("PASS: every recording generation, byte count, and SHA-256 matches protected GCS.");
console.log("PASS: every reconstruction manifest and current derived-transcript artifact exists in protected GCS.");

#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { loadConfig, requireConfig } from "./lib/config.mjs";
import { executeSql, queryRows, sqlLiteral, sqlValues } from "./lib/db.mjs";
import { hashFile, uploadDerivedFile } from "./lib/storage.mjs";
import { parseTimestamp } from "./lib/time.mjs";
import { parseVtt } from "./lib/vtt.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["call-id", "vtt"]);
const config = loadConfig();
requireConfig(config, ["bucket", "transcriptModel"]);
const model = args.model || config.transcriptModel;
const status = args.status || "complete";
if (!new Set(["partial", "complete"]).has(status)) throw new Error("--status must be partial or complete");

const callId = sqlLiteral(args["call-id"]);
const recordingFilter = args["recording-uri"] ? `AND ro.storage_uri = ${sqlLiteral(args["recording-uri"])}` : "";
const recordings = await queryRows(`
  SELECT ro.recording_id, ro.storage_uri, ro.sha256, ro.duration_ms
  FROM call_recordings cr JOIN recording_objects ro USING (recording_id)
  WHERE cr.call_id = ${callId} ${recordingFilter}
  ORDER BY cr.sequence;
`);
if (recordings.length !== 1) throw new Error("Call must resolve to exactly one recording; pass --recording-uri gs://...");
const recording = recordings[0];

const vttPath = path.resolve(args.vtt);
const cues = parseVtt(await fs.readFile(vttPath, "utf8"));
if (cues.length === 0) throw new Error("The WebVTT file contains no transcript cues");
const offset = parseTimestamp(args.offset ?? "0");
const durationMs = Number(recording.duration_ms);
const segments = cues.map((cue, index) => ({
  sequence: index + 1,
  startMs: Math.round((cue.start + offset) * 1000),
  endMs: Math.round((cue.end + offset) * 1000),
  speaker: cue.speaker || null,
  transcript: cue.transcript,
}));
for (const segment of segments) {
  if (segment.startMs < 0 || segment.endMs < segment.startMs || segment.endMs > durationMs + 10) {
    throw new Error(`Transcript cue ${segment.sequence} is outside the recording duration`);
  }
}

const artifactSha256 = await hashFile(vttPath);
const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "unknown";
const artifactKey = `derived-transcripts/${args["call-id"]}/${recording.sha256}/${modelSlug}-${artifactSha256}.vtt`;
const { storageUri: artifactUri } = await uploadDerivedFile(vttPath, artifactKey, "text/vtt; charset=utf-8", {
  "portomatic-call-id": args["call-id"],
  "portomatic-recording-sha256": recording.sha256,
  "portomatic-transcript-model": modelSlug,
  "portomatic-source": "derived-transcript",
});

const proposedRunId = crypto.randomUUID();
await executeSql(`
  INSERT INTO transcript_runs(
    transcript_run_id, call_id, recording_id, artifact_uri, artifact_sha256,
    model, language, status, is_current
  ) VALUES (
    ${sqlLiteral(proposedRunId)}::uuid, ${callId}, ${sqlLiteral(recording.recording_id)}::uuid,
    ${sqlLiteral(artifactUri)}, ${sqlLiteral(artifactSha256)}, ${sqlLiteral(model)},
    ${sqlLiteral(args.language || null)}, ${sqlLiteral(status)}, false
  )
  ON CONFLICT (artifact_uri) DO NOTHING;
`, { application: "portomatic_transcript" });
const runRows = await queryRows(`SELECT transcript_run_id FROM transcript_runs WHERE artifact_uri = ${sqlLiteral(artifactUri)};`, { rowLimit: 1 });
if (runRows.length !== 1) throw new Error("Could not resolve transcript run after insert");
const runId = runRows[0].transcript_run_id;

for (let index = 0; index < segments.length; index += 250) {
  const batch = segments.slice(index, index + 250).map((segment) => [
    runId, segment.sequence, segment.startMs, segment.endMs, segment.speaker, segment.transcript,
  ]);
  await executeSql(`
    INSERT INTO transcript_segments(transcript_run_id, sequence, start_ms, end_ms, speaker, transcript)
    VALUES ${sqlValues(batch)}
    ON CONFLICT (transcript_run_id, sequence) DO NOTHING;
  `, { application: "portomatic_transcript" });
}

const counts = await queryRows(`SELECT count(*) AS count FROM transcript_segments WHERE transcript_run_id = ${sqlLiteral(runId)}::uuid;`, { rowLimit: 1 });
if (Number(counts[0]?.count) !== segments.length) throw new Error("Transcript segment verification failed; previous current transcript remains active");
await executeSql(`
BEGIN;
UPDATE transcript_runs
SET is_current = false
WHERE call_id = ${callId} AND recording_id = ${sqlLiteral(recording.recording_id)}::uuid AND is_current;
UPDATE transcript_runs
SET is_current = true, status = ${sqlLiteral(status)}
WHERE transcript_run_id = ${sqlLiteral(runId)}::uuid;
COMMIT;
`, { application: "portomatic_transcript" });

console.log(`Stored immutable transcript artifact: ${artifactUri}`);
console.log(`Activated ${segments.length} derived transcript segments for ${args["call-id"]}`);

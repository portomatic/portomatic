import fs from "node:fs/promises";
import { callLogPath } from "./config.mjs";
import { recordsFromCsv, recordsToCsv } from "./csv.mjs";

export const headers = [
  "call_id",
  "customer_slug",
  "customer_name",
  "recorded_at",
  "recording_uri",
  "recording_sha256",
  "recording_bytes",
  "recording_duration_seconds",
  "segment_start_seconds",
  "segment_end_seconds",
  "speaker",
  "transcript",
  "transcript_status",
  "source",
];

export async function readCallLog() {
  const text = await fs.readFile(callLogPath, "utf8");
  const parsed = recordsFromCsv(text);
  if (parsed.headers.join("\u0000") !== headers.join("\u0000")) {
    throw new Error(`Unexpected call-log headers. Expected: ${headers.join(",")}`);
  }
  return parsed.records;
}

export async function writeCallLog(records) {
  const temporaryPath = `${callLogPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, recordsToCsv(headers, records), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, callLogPath);
}

export function rowsForVtt(common, cues, offset = 0, status = "complete") {
  return cues.map((cue) => ({
    ...common,
    segment_start_seconds: String(cue.start + offset),
    segment_end_seconds: String(cue.end + offset),
    speaker: cue.speaker,
    transcript: cue.transcript,
    transcript_status: status,
  }));
}

export function validateCallLog(records, { allowPendingUri = true } = {}) {
  const errors = [];
  const identityByCall = new Map();
  const metadataByUri = new Map();

  records.forEach((row, index) => {
    const line = index + 2;
    for (const field of ["call_id", "customer_slug", "customer_name", "recorded_at", "transcript_status"]) {
      if (!row[field]) errors.push(`line ${line}: ${field} is required`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.call_id || "")) errors.push(`line ${line}: invalid call_id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.customer_slug || "")) errors.push(`line ${line}: invalid customer_slug`);
    if (Number.isNaN(Date.parse(row.recorded_at))) errors.push(`line ${line}: recorded_at must be ISO 8601`);
    if (!new Set(["pending", "partial", "complete"]).has(row.transcript_status)) errors.push(`line ${line}: invalid transcript_status`);
    if (/^https?:/i.test(row.recording_uri || "") || /X-Goog-(?:Signature|Credential)/i.test(row.recording_uri || "")) {
      errors.push(`line ${line}: commit only durable gs:// URIs, never HTTPS or signed URLs`);
    }
    if (!row.recording_uri && !(allowPendingUri && row.transcript_status === "pending")) errors.push(`line ${line}: recording_uri is required`);
    if (row.recording_uri && !/^gs:\/\/[a-z0-9][a-z0-9._-]+\/.+/.test(row.recording_uri)) errors.push(`line ${line}: invalid recording_uri`);
    if (row.recording_sha256 && !/^[a-f0-9]{64}$/.test(row.recording_sha256)) errors.push(`line ${line}: invalid recording_sha256`);

    const duration = numeric(row.recording_duration_seconds, "recording_duration_seconds", line, errors, true);
    const start = numeric(row.segment_start_seconds, "segment_start_seconds", line, errors, false);
    const end = numeric(row.segment_end_seconds, "segment_end_seconds", line, errors, false);
    numeric(row.recording_bytes, "recording_bytes", line, errors, true);
    if (start != null && end != null && end < start) errors.push(`line ${line}: segment_end_seconds is before start`);
    if (duration != null && start != null && start > duration) errors.push(`line ${line}: segment starts after recording ends`);
    if (duration != null && end != null && end > duration + 0.01) errors.push(`line ${line}: segment ends after recording ends`);

    const identity = `${row.customer_slug}\u0000${row.customer_name}`;
    if (identityByCall.has(row.call_id) && identityByCall.get(row.call_id) !== identity) errors.push(`line ${line}: inconsistent customer identity for call_id`);
    identityByCall.set(row.call_id, identity);

    if (row.recording_uri) {
      const metadata = `${row.recording_sha256}\u0000${row.recording_bytes}\u0000${row.recording_duration_seconds}`;
      if (metadataByUri.has(row.recording_uri) && metadataByUri.get(row.recording_uri) !== metadata) errors.push(`line ${line}: inconsistent metadata for recording_uri`);
      metadataByUri.set(row.recording_uri, metadata);
    }
  });
  return errors;
}

function numeric(value, field, line, errors, required) {
  if (value === "") {
    if (required) errors.push(`line ${line}: ${field} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    errors.push(`line ${line}: ${field} must be a non-negative number`);
    return null;
  }
  return parsed;
}

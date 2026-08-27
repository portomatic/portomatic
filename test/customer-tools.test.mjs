import test from "node:test";
import assert from "node:assert/strict";
import { encodeCsv, parseCsv, recordsFromCsv } from "../customers/scripts/lib/csv.mjs";
import { rowsForVtt, validateCallLog } from "../customers/scripts/lib/call-log.mjs";
import { formatTimestamp, parseTimestamp } from "../customers/scripts/lib/time.mjs";
import { parseVtt } from "../customers/scripts/lib/vtt.mjs";
import { buildViewerHtml } from "../customers/scripts/lib/viewer.mjs";

test("CSV round-trips commas, quotes, and multiline transcripts", () => {
  const rows = [["name", "transcript"], ["Mitchell", "one, two\n\"three\""]];
  assert.deepEqual(parseCsv(encodeCsv(rows)), rows);
  assert.equal(recordsFromCsv(encodeCsv(rows)).records[0].transcript, "one, two\n\"three\"");
});

test("timestamps parse and format recording-relative time", () => {
  assert.equal(parseTimestamp("01:02:03.5"), 3723.5);
  assert.equal(parseTimestamp("15:17"), 917);
  assert.equal(formatTimestamp(917.9), "00:15:17");
  assert.throws(() => parseTimestamp("01:99"));
});

test("WebVTT parser preserves cue timing and speaker", () => {
  const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Mitchell>Hello there\n\n00:00:04.000 --> 00:00:05.000\nKevin: Hi\n");
  assert.deepEqual(cues, [
    { start: 1, end: 3.5, speaker: "Mitchell", transcript: "Hello there" },
    { start: 4, end: 5, speaker: "Kevin", transcript: "Hi" },
  ]);
});

test("VTT rows can be shifted to recording-relative timestamps", () => {
  const rows = rowsForVtt({ call_id: "call" }, [{ start: 1, end: 3, speaker: "A", transcript: "Hello" }], 120);
  assert.equal(rows[0].segment_start_seconds, "121");
  assert.equal(rows[0].segment_end_seconds, "123");
});

test("call-log validation rejects signed URLs and inconsistent metadata", () => {
  const base = {
    call_id: "2026-08-20-mitchell",
    customer_slug: "mitchell",
    customer_name: "Mitchell",
    recorded_at: "2026-08-20T12:30:52-07:00",
    recording_uri: "gs://private-bucket/customers/mitchell/call.mov",
    recording_sha256: "a".repeat(64),
    recording_bytes: "1000",
    recording_duration_seconds: "60",
    segment_start_seconds: "10",
    segment_end_seconds: "20",
    speaker: "Mitchell",
    transcript: "Test",
    transcript_status: "complete",
    source: "call.mov",
  };
  assert.deepEqual(validateCallLog([base], { allowPendingUri: false }), []);
  const badUrl = { ...base, recording_uri: "https://storage.googleapis.com/file?X-Goog-Signature=secret" };
  assert.ok(validateCallLog([badUrl]).some((error) => error.includes("never HTTPS")));
  const inconsistent = { ...base, recording_sha256: "b".repeat(64), transcript: "Another" };
  assert.ok(validateCallLog([base, inconsistent]).some((error) => error.includes("inconsistent metadata")));
});

test("viewer links transcript text to the exact recording timestamp", () => {
  const uri = "gs://private-bucket/customer/call.mov";
  const html = buildViewerHtml({
    title: "Call <one>",
    rows: [{ recorded_at: "2026-08-20T12:30:52-07:00", recording_uri: uri, segment_start_seconds: "917", speaker: "Mitchell", transcript: "Run <the app>" }],
    signedByUri: new Map([[uri, { signedUrl: "https://example.test/private?signature=value", duration: "15m" }]]),
  });
  assert.match(html, /#t=917/);
  assert.match(html, /data-seconds="917"/);
  assert.match(html, /Run &lt;the app&gt;/);
  assert.doesNotMatch(html, /Call <one>/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, parseTimestamp } from "../customers/scripts/lib/time.mjs";
import { parseVtt } from "../customers/scripts/lib/vtt.mjs";
import { buildViewerHtml } from "../customers/scripts/lib/viewer.mjs";
import { sqlIdentifier, sqlLiteral, sqlValues } from "../customers/scripts/lib/db.mjs";

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

test("database values are escaped before entering operational SQL", () => {
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlIdentifier('founder"name'), '"founder""name"');
  assert.equal(sqlValues([["call", 1000, null]]), "('call', 1000, NULL)");
});

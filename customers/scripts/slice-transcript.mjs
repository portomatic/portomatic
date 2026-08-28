#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireArgs } from "./lib/cli.mjs";
import { parseTimestamp } from "./lib/time.mjs";
import { parseVtt } from "./lib/vtt.mjs";

const args = parseArgs(process.argv.slice(2));
requireArgs(args, ["input", "output", "start", "end"]);
const inputPath = path.resolve(args.input);
const outputPath = path.resolve(args.output);
const start = parseTimestamp(args.start);
const end = parseTimestamp(args.end);
if (end <= start) throw new Error("--end must be after --start");

const cues = parseVtt(await fsp.readFile(inputPath, "utf8"))
  .filter((cue) => cue.start < end && cue.end > start)
  .map((cue) => ({ ...cue, start: Math.max(cue.start, start), end: Math.min(cue.end, end) }));
if (cues.length === 0) throw new Error("No transcript cues overlap the requested range");

const blocks = cues.map((cue) => {
  const text = cue.speaker ? `<v ${cue.speaker}>${cue.transcript}` : cue.transcript;
  return `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${text}`;
});
await fsp.writeFile(outputPath, `WEBVTT\n\n${blocks.join("\n\n")}\n`, { mode: 0o600 });
console.log(`Wrote ${cues.length} cues to ${outputPath}`);

function formatTimestamp(value) {
  const milliseconds = Math.round(value * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const fraction = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

import { parseTimestamp } from "./time.mjs";

export function parseVtt(text) {
  const normalized = text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;
    const [rawStart, rawEndWithSettings] = lines[timingIndex].split("-->").map((value) => value.trim());
    const rawEnd = rawEndWithSettings.split(/\s+/)[0];
    const rawText = lines.slice(timingIndex + 1).join(" ")
      .replace(/<v\s+([^>]+)>/gi, "$1: ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!rawText) continue;
    const speakerMatch = rawText.match(/^([^:]{1,80}):\s+(.+)$/);
    cues.push({
      start: parseTimestamp(rawStart.replace(",", ".")),
      end: parseTimestamp(rawEnd.replace(",", ".")),
      speaker: speakerMatch ? speakerMatch[1].trim() : "",
      transcript: speakerMatch ? speakerMatch[2].trim() : rawText,
    });
  }
  return cues;
}

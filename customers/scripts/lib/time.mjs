export function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value);
  const parts = String(value).trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length === 1 ? Number(parts[0]) : 0;
  if (minutes >= 60 || seconds >= 60) throw new Error(`Invalid timestamp: ${value}`);
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

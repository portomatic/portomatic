import { loadConfig, requireConfig } from "./config.mjs";
import { run } from "./cli.mjs";

export function signUrl(storageUri, durationOverride) {
  if (!storageUri.startsWith("gs://")) throw new Error(`Cannot sign non-GCS URI: ${storageUri}`);
  const config = loadConfig();
  requireConfig(config, ["projectId", "signerServiceAccount"]);
  const duration = durationOverride || config.signedUrlDuration;
  const output = run("gcloud", [
    "storage",
    "sign-url",
    storageUri,
    `--duration=${duration}`,
    `--region=${config.location}`,
    `--impersonate-service-account=${config.signerServiceAccount}`,
    `--project=${config.projectId}`,
    "--format=json",
  ], { capture: true });
  const parsed = JSON.parse(output);
  const signedUrl = findSignedUrl(parsed);
  if (!signedUrl) throw new Error("gcloud did not return a signed URL");
  return { signedUrl, duration };
}

function findSignedUrl(value) {
  if (typeof value === "string" && /^https:\/\//.test(value) && /X-Goog-Signature/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSignedUrl(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/signed.?url/i.test(key) && typeof item === "string") return item;
      const found = findSignedUrl(item);
      if (found) return found;
    }
  }
  return null;
}

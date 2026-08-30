import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libraryDirectory = path.dirname(fileURLToPath(import.meta.url));
export const mediaDirectory = path.resolve(libraryDirectory, "../..");
export const repositoryRoot = path.resolve(mediaDirectory, "..");

export function loadMediaConfig() {
  const customerValues = readEnvFile(path.join(repositoryRoot, "customers/.env"));
  const mediaValues = readEnvFile(path.join(mediaDirectory, ".env"));
  const value = (name, fallback = "") => process.env[name] || mediaValues[name] || customerValues[name] || fallback;
  const projectId = value("PORTOMATIC_GCP_PROJECT_ID");
  return {
    projectId,
    organizationId: value("PORTOMATIC_GCP_ORGANIZATION_ID"),
    location: value("PORTOMATIC_GCS_LOCATION", "us-west1"),
    bucket: value("PORTOMATIC_MEDIA_GCS_BUCKET"),
    uploaderServiceAccount: value(
      "PORTOMATIC_MEDIA_GCS_UPLOADER_SERVICE_ACCOUNT",
      projectId ? `portomatic-media-uploader@${projectId}.iam.gserviceaccount.com` : "",
    ),
    founderPrincipals: value("PORTOMATIC_GCP_FOUNDER_PRINCIPALS"),
    trustedOperatorPrincipals: value("PORTOMATIC_GCP_TRUSTED_OPERATOR_PRINCIPALS"),
  };
}

export function requireMediaConfig(config, names) {
  const missing = names.filter((name) => !config[name]);
  if (missing.length) throw new Error(`Missing private media configuration: ${missing.join(", ")}`);
}

function readEnvFile(filename) {
  if (!fs.existsSync(filename)) return {};
  return Object.fromEntries(fs.readFileSync(filename, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      const name = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return [name, value];
    }));
}

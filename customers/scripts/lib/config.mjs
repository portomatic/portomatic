import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libraryDirectory = path.dirname(fileURLToPath(import.meta.url));
export const customersDirectory = path.resolve(libraryDirectory, "../..");
export const repositoryRoot = path.resolve(customersDirectory, "..");

export function loadConfig() {
  const fileValues = readEnvFile(path.join(customersDirectory, ".env"));
  const value = (name, fallback = "") => process.env[name] || fileValues[name] || fallback;
  const projectId = value("PORTOMATIC_GCP_PROJECT_ID");
  const location = value("PORTOMATIC_GCS_LOCATION", "us-west1");
  return {
    organizationId: value("PORTOMATIC_GCP_ORGANIZATION_ID"),
    projectId,
    bucket: value("PORTOMATIC_GCS_BUCKET"),
    location,
    founderPrincipals: value("PORTOMATIC_GCP_FOUNDER_PRINCIPALS"),
    uploaderServiceAccount: value(
      "PORTOMATIC_GCS_UPLOADER_SERVICE_ACCOUNT",
      projectId ? `customer-recording-uploader@${projectId}.iam.gserviceaccount.com` : "",
    ),
    signerServiceAccount: value(
      "PORTOMATIC_GCS_SIGNER_SERVICE_ACCOUNT",
      projectId ? `customer-recording-signer@${projectId}.iam.gserviceaccount.com` : "",
    ),
    signedUrlDuration: value("PORTOMATIC_GCS_SIGNED_URL_DURATION", "15m"),
    cloudSqlInstance: value("PORTOMATIC_CLOUD_SQL_INSTANCE", "portomatic-calls"),
    cloudSqlDatabase: value("PORTOMATIC_CLOUD_SQL_DATABASE", "portomatic_calls"),
    cloudSqlBootstrapSecretVersion: value(
      "PORTOMATIC_CLOUD_SQL_BOOTSTRAP_SECRET_VERSION",
      projectId ? `projects/${projectId}/locations/${location}/secrets/portomatic-cloud-sql-bootstrap/versions/latest` : "",
    ),
    transcriptModel: value("PORTOMATIC_TRANSCRIPT_MODEL", "unknown"),
  };
}

export function requireConfig(config, names) {
  const missing = names.filter((name) => !config[name]);
  if (missing.length > 0) {
    throw new Error(`Missing customer storage configuration: ${missing.join(", ")}. Copy customers/config.example.env to customers/.env.`);
  }
}

function readEnvFile(filename) {
  if (!fs.existsSync(filename)) return {};
  return Object.fromEntries(
    fs.readFileSync(filename, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const name = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return [name, value];
      }),
  );
}

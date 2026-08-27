#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
customers_dir="$(cd "${script_dir}/.." && pwd)"
if [[ -f "${customers_dir}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${customers_dir}/.env"
  set +a
fi

: "${PORTOMATIC_GCP_PROJECT_ID:?Missing PORTOMATIC_GCP_PROJECT_ID}"
: "${PORTOMATIC_GCS_BUCKET:?Missing PORTOMATIC_GCS_BUCKET}"

bucket_json="$(gcloud storage buckets describe "gs://${PORTOMATIC_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"
policy_json="$(gcloud storage buckets get-iam-policy "gs://${PORTOMATIC_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"

# The single-quoted program is intentionally passed verbatim to Node.
# shellcheck disable=SC2016
BUCKET_JSON="${bucket_json}" POLICY_JSON="${policy_json}" node --input-type=module -e '
const bucket = JSON.parse(process.env.BUCKET_JSON);
const policy = JSON.parse(process.env.POLICY_JSON);
const iam = bucket.iamConfiguration || bucket.iam_configuration || {};
const failures = [];
if ((iam.publicAccessPrevention || iam.public_access_prevention) !== "enforced") failures.push("public access prevention is not enforced");
const uniform = iam.uniformBucketLevelAccess || iam.uniform_bucket_level_access || {};
if (!uniform.enabled) failures.push("uniform bucket-level access is not enabled");
if (!bucket.versioning?.enabled) failures.push("versioning is not enabled");
const softDelete = bucket.softDeletePolicy || bucket.soft_delete_policy || {};
const retention = Number(softDelete.retentionDurationSeconds || softDelete.retention_duration_seconds || 0);
if (retention < 30 * 24 * 60 * 60) failures.push("soft-delete retention is shorter than 30 days");
for (const binding of policy.bindings || []) {
  for (const member of binding.members || []) {
    if (member === "allUsers" || member === "allAuthenticatedUsers") failures.push(`public IAM member ${member} has ${binding.role}`);
  }
}
if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`PASS: gs://${bucket.name} blocks public access, uses uniform IAM, versions objects, and retains soft-deleted objects for at least 30 days.`);
'

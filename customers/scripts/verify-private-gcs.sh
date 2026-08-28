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
uploader="${PORTOMATIC_GCS_UPLOADER_SERVICE_ACCOUNT:-customer-recording-uploader@${PORTOMATIC_GCP_PROJECT_ID}.iam.gserviceaccount.com}"
signer="${PORTOMATIC_GCS_SIGNER_SERVICE_ACCOUNT:-customer-recording-signer@${PORTOMATIC_GCP_PROJECT_ID}.iam.gserviceaccount.com}"
founders="${PORTOMATIC_GCP_FOUNDER_PRINCIPALS:-}"
trusted_operators="${PORTOMATIC_GCP_TRUSTED_OPERATOR_PRINCIPALS:-}"

bucket_json="$(gcloud storage buckets describe "gs://${PORTOMATIC_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"
policy_json="$(gcloud storage buckets get-iam-policy "gs://${PORTOMATIC_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"
project_policy_json="$(gcloud projects get-iam-policy "${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"

# The single-quoted program is intentionally passed verbatim to Node.
# shellcheck disable=SC2016
BUCKET_JSON="${bucket_json}" POLICY_JSON="${policy_json}" PROJECT_POLICY_JSON="${project_policy_json}" \
UPLOADER="${uploader}" SIGNER="${signer}" FOUNDERS="${founders}" TRUSTED_OPERATORS="${trusted_operators}" \
node --input-type=module -e '
const bucket = JSON.parse(process.env.BUCKET_JSON);
const policy = JSON.parse(process.env.POLICY_JSON);
const projectPolicy = JSON.parse(process.env.PROJECT_POLICY_JSON);
const uploaderMember = `serviceAccount:${process.env.UPLOADER}`;
const allowedMembers = new Set([
  uploaderMember,
  `serviceAccount:${process.env.SIGNER}`,
  ...process.env.FOUNDERS.split(",").map((value) => value.trim()).filter(Boolean),
  ...process.env.TRUSTED_OPERATORS.split(",").map((value) => value.trim()).filter(Boolean),
]);
const iam = bucket.iamConfiguration || bucket.iam_configuration || {};
const failures = [];
if ((iam.publicAccessPrevention || iam.public_access_prevention || bucket.public_access_prevention) !== "enforced") failures.push("public access prevention is not enforced");
const uniform = iam.uniformBucketLevelAccess || iam.uniform_bucket_level_access || {};
if (!(uniform.enabled || bucket.uniform_bucket_level_access === true)) failures.push("uniform bucket-level access is not enabled");
if (!(bucket.versioning?.enabled || bucket.versioning_enabled === true)) failures.push("versioning is not enabled");
const softDelete = bucket.softDeletePolicy || bucket.soft_delete_policy || {};
const retention = Number(softDelete.retentionDurationSeconds || softDelete.retention_duration_seconds || 0);
if (retention < 30 * 24 * 60 * 60) failures.push("soft-delete retention is shorter than 30 days");
for (const binding of policy.bindings || []) {
  for (const member of binding.members || []) {
    if (member === "allUsers" || member === "allAuthenticatedUsers") failures.push(`public IAM member ${member} has ${binding.role}`);
    if (!allowedMembers.has(member)) failures.push(`unapproved direct bucket member ${member} has ${binding.role}`);
    if (member === uploaderMember && new Set(["roles/storage.admin", "roles/storage.objectAdmin", "roles/storage.objectUser"]).has(binding.role)) {
      failures.push(`uploader has destructive role ${binding.role}`);
    }
  }
}
const inheritedDataRoles = new Set([
  "roles/owner", "roles/editor", "roles/storage.admin", "roles/storage.objectAdmin",
  "roles/storage.objectUser", "roles/storage.objectViewer", "roles/storage.legacyObjectOwner",
  "roles/storage.legacyObjectReader",
]);
for (const binding of projectPolicy.bindings || []) {
  if (!inheritedDataRoles.has(binding.role)) continue;
  for (const member of binding.members || []) {
    if (!allowedMembers.has(member)) failures.push(`undeclared project-level data principal ${member} has ${binding.role}`);
  }
}
if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`PASS: gs://${bucket.name} blocks public access, has no undeclared direct or inherited data principals, versions objects, retains soft-deleted objects for at least 30 days, and denies the uploader delete/overwrite access.`);
'

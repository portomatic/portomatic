#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/../.." && pwd)"
for env_file in "${repo_dir}/customers/.env" "${repo_dir}/media/.env"; do
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
done

: "${PORTOMATIC_GCP_PROJECT_ID:?Missing PORTOMATIC_GCP_PROJECT_ID}"
: "${PORTOMATIC_MEDIA_GCS_BUCKET:?Missing PORTOMATIC_MEDIA_GCS_BUCKET}"
uploader="${PORTOMATIC_MEDIA_GCS_UPLOADER_SERVICE_ACCOUNT:-portomatic-media-uploader@${PORTOMATIC_GCP_PROJECT_ID}.iam.gserviceaccount.com}"

bucket_json="$(gcloud storage buckets describe "gs://${PORTOMATIC_MEDIA_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"
policy_json="$(gcloud storage buckets get-iam-policy "gs://${PORTOMATIC_MEDIA_GCS_BUCKET}" --project="${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"
project_policy_json="$(gcloud projects get-iam-policy "${PORTOMATIC_GCP_PROJECT_ID}" --format=json)"

# shellcheck disable=SC2016
BUCKET_JSON="${bucket_json}" POLICY_JSON="${policy_json}" PROJECT_POLICY_JSON="${project_policy_json}" \
UPLOADER="${uploader}" FOUNDERS="${PORTOMATIC_GCP_FOUNDER_PRINCIPALS:-}" \
TRUSTED_OPERATORS="${PORTOMATIC_GCP_TRUSTED_OPERATOR_PRINCIPALS:-}" node --input-type=module -e '
const bucket = JSON.parse(process.env.BUCKET_JSON);
const policy = JSON.parse(process.env.POLICY_JSON);
const projectPolicy = JSON.parse(process.env.PROJECT_POLICY_JSON);
const uploaderMember = `serviceAccount:${process.env.UPLOADER}`;
const allowed = new Set([
  uploaderMember,
  ...process.env.FOUNDERS.split(",").map((v) => v.trim()).filter(Boolean),
  ...process.env.TRUSTED_OPERATORS.split(",").map((v) => v.trim()).filter(Boolean),
]);
const failures = [];
const iam = bucket.iamConfiguration || {};
if ((iam.publicAccessPrevention || bucket.public_access_prevention) !== "enforced") failures.push("public access prevention is not enforced");
if (!(iam.uniformBucketLevelAccess?.enabled || bucket.uniform_bucket_level_access === true)) failures.push("uniform bucket-level access is not enabled");
if (!(bucket.versioning?.enabled || bucket.versioning_enabled === true)) failures.push("versioning is not enabled");
if (Number(bucket.softDeletePolicy?.retentionDurationSeconds || bucket.soft_delete_policy?.retentionDurationSeconds || 0) < 2592000) failures.push("soft delete is shorter than 30 days");
if (!bucket.autoclass?.enabled) failures.push("Autoclass is not enabled");
for (const binding of policy.bindings || []) for (const member of binding.members || []) {
  if (["allUsers", "allAuthenticatedUsers"].includes(member)) failures.push(`public member ${member} has ${binding.role}`);
  if (!allowed.has(member)) failures.push(`unapproved bucket member ${member} has ${binding.role}`);
  if (member === uploaderMember && ["roles/storage.admin", "roles/storage.objectAdmin", "roles/storage.objectUser"].includes(binding.role)) failures.push(`uploader has destructive role ${binding.role}`);
}
const dataRoles = new Set(["roles/owner", "roles/editor", "roles/storage.admin", "roles/storage.objectAdmin", "roles/storage.objectUser", "roles/storage.objectViewer", "roles/storage.legacyObjectOwner", "roles/storage.legacyObjectReader"]);
for (const binding of projectPolicy.bindings || []) if (dataRoles.has(binding.role)) for (const member of binding.members || []) {
  if (!allowed.has(member)) failures.push(`undeclared project data principal ${member} has ${binding.role}`);
}
if (failures.length) { console.error(failures.map((v) => `FAIL: ${v}`).join("\n")); process.exit(1); }
console.log(`PASS: gs://${bucket.name} is private, versioned, soft-delete protected, Autoclass-enabled, and its uploader cannot overwrite or delete objects.`);
'

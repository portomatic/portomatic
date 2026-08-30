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

: "${PORTOMATIC_GCP_ORGANIZATION_ID:?Missing PORTOMATIC_GCP_ORGANIZATION_ID}"
: "${PORTOMATIC_GCP_PROJECT_ID:?Missing PORTOMATIC_GCP_PROJECT_ID}"
: "${PORTOMATIC_MEDIA_GCS_BUCKET:?Missing PORTOMATIC_MEDIA_GCS_BUCKET}"
: "${PORTOMATIC_GCP_FOUNDER_PRINCIPALS:?Missing PORTOMATIC_GCP_FOUNDER_PRINCIPALS}"

project_id="${PORTOMATIC_GCP_PROJECT_ID}"
bucket="${PORTOMATIC_MEDIA_GCS_BUCKET}"
location="${PORTOMATIC_GCS_LOCATION:-us-west1}"
uploader="${PORTOMATIC_MEDIA_GCS_UPLOADER_SERVICE_ACCOUNT:-portomatic-media-uploader@${project_id}.iam.gserviceaccount.com}"

parent="$(gcloud projects describe "${project_id}" --format='value(parent.type,parent.id)')"
read -r parent_type parent_id <<<"${parent}"
if [[ "${parent_type}" != "organization" || "${parent_id}" != "${PORTOMATIC_GCP_ORGANIZATION_ID}" ]]; then
  echo "Refusing to provision outside the configured Portomatic organization." >&2
  exit 1
fi

gcloud services enable storage.googleapis.com iamcredentials.googleapis.com --project="${project_id}"

if ! gcloud storage buckets describe "gs://${bucket}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${bucket}" \
    --project="${project_id}" --location="${location}" \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d
fi
gcloud storage buckets update "gs://${bucket}" --project="${project_id}" \
  --uniform-bucket-level-access --public-access-prevention --versioning \
  --soft-delete-duration=30d --enable-autoclass

expected_domain="${project_id}.iam.gserviceaccount.com"
if [[ "${uploader#*@}" != "${expected_domain}" ]]; then
  echo "Refusing uploader outside ${expected_domain}." >&2
  exit 1
fi
if ! gcloud iam service-accounts describe "${uploader}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${uploader%%@*}" --project="${project_id}" \
    --display-name="Portomatic private media archive uploader"
fi

gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
  --project="${project_id}" --member="serviceAccount:${uploader}" --role="roles/storage.objectCreator" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
  --project="${project_id}" --member="serviceAccount:${uploader}" --role="roles/storage.objectViewer" >/dev/null
gcloud storage buckets remove-iam-policy-binding "gs://${bucket}" \
  --project="${project_id}" --member="serviceAccount:${uploader}" --role="roles/storage.objectUser" >/dev/null 2>&1 || true

for legacy_binding in \
  "roles/storage.legacyBucketOwner projectEditor:${project_id}" \
  "roles/storage.legacyBucketOwner projectOwner:${project_id}" \
  "roles/storage.legacyBucketReader projectViewer:${project_id}" \
  "roles/storage.legacyObjectOwner projectEditor:${project_id}" \
  "roles/storage.legacyObjectOwner projectOwner:${project_id}" \
  "roles/storage.legacyObjectReader projectViewer:${project_id}"
do
  read -r legacy_role legacy_member <<<"${legacy_binding}"
  gcloud storage buckets remove-iam-policy-binding "gs://${bucket}" \
    --project="${project_id}" --member="${legacy_member}" --role="${legacy_role}" >/dev/null 2>&1 || true
done

principals="${PORTOMATIC_GCP_FOUNDER_PRINCIPALS},${PORTOMATIC_GCP_TRUSTED_OPERATOR_PRINCIPALS:-}"
IFS=',' read -r -a principal_list <<<"${principals}"
for raw_principal in "${principal_list[@]}"; do
  principal="$(printf '%s' "${raw_principal}" | xargs)"
  [[ -n "${principal}" ]] || continue
  gcloud iam service-accounts add-iam-policy-binding "${uploader}" \
    --project="${project_id}" --member="${principal}" --role="roles/iam.serviceAccountTokenCreator" >/dev/null
done

bash "${script_dir}/verify-private-gcs.sh"
echo "Private company-media storage is ready at gs://${bucket}."

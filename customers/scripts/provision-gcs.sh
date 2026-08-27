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

required=(
  PORTOMATIC_GCP_ORGANIZATION_ID
  PORTOMATIC_GCP_PROJECT_ID
  PORTOMATIC_GCS_BUCKET
  PORTOMATIC_GCP_FOUNDER_PRINCIPALS
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing ${name}. Copy customers/config.example.env to customers/.env." >&2
    exit 1
  fi
done

project_id="${PORTOMATIC_GCP_PROJECT_ID}"
organization_id="${PORTOMATIC_GCP_ORGANIZATION_ID}"
bucket="${PORTOMATIC_GCS_BUCKET}"
location="${PORTOMATIC_GCS_LOCATION:-us-west1}"
uploader="${PORTOMATIC_GCS_UPLOADER_SERVICE_ACCOUNT:-customer-recording-uploader@${project_id}.iam.gserviceaccount.com}"
signer="${PORTOMATIC_GCS_SIGNER_SERVICE_ACCOUNT:-customer-recording-signer@${project_id}.iam.gserviceaccount.com}"

parent="$(gcloud projects describe "${project_id}" --format='value(parent.type,parent.id)')"
read -r parent_type parent_id <<<"${parent}"
if [[ "${parent_type}" != "organization" || "${parent_id}" != "${organization_id}" ]]; then
  echo "Refusing to provision: project ${project_id} belongs to ${parent_type:-none}/${parent_id:-none}, not Portomatic organization ${organization_id}." >&2
  exit 1
fi

gcloud services enable storage.googleapis.com iamcredentials.googleapis.com --project="${project_id}"

if ! gcloud storage buckets describe "gs://${bucket}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${bucket}" \
    --project="${project_id}" \
    --location="${location}" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --soft-delete-duration=30d
fi

gcloud storage buckets update "gs://${bucket}" \
  --project="${project_id}" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --versioning \
  --soft-delete-duration=30d

ensure_service_account() {
  local email="$1"
  local display_name="$2"
  local expected_domain="${project_id}.iam.gserviceaccount.com"
  if [[ "${email#*@}" != "${expected_domain}" ]]; then
    echo "Refusing to create service account outside ${expected_domain}: ${email}" >&2
    exit 1
  fi
  local account_id="${email%%@*}"
  if ! gcloud iam service-accounts describe "${email}" --project="${project_id}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${account_id}" --project="${project_id}" --display-name="${display_name}"
  fi
}

ensure_service_account "${uploader}" "Portomatic customer recording uploader"
ensure_service_account "${signer}" "Portomatic customer recording URL signer"

gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
  --member="serviceAccount:${uploader}" --role="roles/storage.objectUser" --project="${project_id}" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
  --member="serviceAccount:${uploader}" --role="roles/storage.legacyBucketReader" --project="${project_id}" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${bucket}" \
  --member="serviceAccount:${signer}" --role="roles/storage.objectViewer" --project="${project_id}" >/dev/null

IFS=',' read -r -a principals <<<"${PORTOMATIC_GCP_FOUNDER_PRINCIPALS}"
for raw_principal in "${principals[@]}"; do
  principal="$(printf '%s' "${raw_principal}" | xargs)"
  [[ -n "${principal}" ]] || continue
  gcloud iam service-accounts add-iam-policy-binding "${uploader}" \
    --project="${project_id}" --member="${principal}" --role="roles/iam.serviceAccountTokenCreator" >/dev/null
  gcloud iam service-accounts add-iam-policy-binding "${signer}" \
    --project="${project_id}" --member="${principal}" --role="roles/iam.serviceAccountTokenCreator" >/dev/null
done

bash "${script_dir}/verify-private-gcs.sh"
echo "Private customer-recording storage is ready at gs://${bucket}."

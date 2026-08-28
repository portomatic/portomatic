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

: "${PORTOMATIC_GCP_ORGANIZATION_ID:?Missing PORTOMATIC_GCP_ORGANIZATION_ID}"
: "${PORTOMATIC_GCP_PROJECT_ID:?Missing PORTOMATIC_GCP_PROJECT_ID}"
: "${PORTOMATIC_GCP_FOUNDER_PRINCIPALS:?Missing PORTOMATIC_GCP_FOUNDER_PRINCIPALS}"

project_id="${PORTOMATIC_GCP_PROJECT_ID}"
organization_id="${PORTOMATIC_GCP_ORGANIZATION_ID}"
instance="${PORTOMATIC_CLOUD_SQL_INSTANCE:-portomatic-calls}"
database="${PORTOMATIC_CLOUD_SQL_DATABASE:-portomatic_calls}"
region="${PORTOMATIC_GCS_LOCATION:-us-west1}"
range_name="portomatic-cloud-sql-psa"
bootstrap_secret="portomatic-cloud-sql-bootstrap"
secret_endpoint="https://secretmanager.${region}.rep.googleapis.com/"

parent="$(gcloud projects describe "${project_id}" --format='value(parent.type,parent.id)')"
read -r parent_type parent_id <<<"${parent}"
if [[ "${parent_type}" != "organization" || "${parent_id}" != "${organization_id}" ]]; then
  echo "Refusing to provision outside Portomatic organization ${organization_id}." >&2
  exit 1
fi

gcloud services enable sqladmin.googleapis.com servicenetworking.googleapis.com secretmanager.googleapis.com --project="${project_id}"

if ! gcloud compute addresses describe "${range_name}" --global --project="${project_id}" >/dev/null 2>&1; then
  gcloud compute addresses create "${range_name}" --global --purpose=VPC_PEERING --prefix-length=24 --network=default --project="${project_id}"
fi
if ! gcloud services vpc-peerings list --network=default --project="${project_id}" --format='value(peering)' | grep -q .; then
  gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges="${range_name}" --network=default --project="${project_id}"
fi

if ! gcloud sql instances describe "${instance}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud sql instances create "${instance}" \
    --project="${project_id}" \
    --database-version=POSTGRES_16 \
    --edition=enterprise \
    --region="${region}" \
    --tier=db-f1-micro \
    --storage-size=10 \
    --storage-type=SSD \
    --storage-auto-increase \
    --network=default \
    --no-assign-ip \
    --data-api-access=ALLOW_DATA_API \
    --connector-enforcement=REQUIRED \
    --ssl-mode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED \
    --database-flags=cloudsql.iam_authentication=on \
    --backup-start-time=10:00 \
    --enable-point-in-time-recovery \
    --retained-backups-count=14 \
    --retained-transaction-log-days=7 \
    --deletion-protection \
    --availability-type=zonal \
    --maintenance-window-day=SUN \
    --maintenance-window-hour=11
fi

if ! gcloud sql databases describe "${database}" --instance="${instance}" --project="${project_id}" >/dev/null 2>&1; then
  gcloud sql databases create "${database}" --instance="${instance}" --project="${project_id}"
fi

if ! CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER="${secret_endpoint}" gcloud secrets describe "${bootstrap_secret}" --location="${region}" --project="${project_id}" >/dev/null 2>&1; then
  CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER="${secret_endpoint}" gcloud secrets create "${bootstrap_secret}" \
    --location="${region}" --project="${project_id}" >/dev/null
fi
if ! CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER="${secret_endpoint}" gcloud secrets versions list "${bootstrap_secret}" --location="${region}" --project="${project_id}" --filter='state=ENABLED' --format='value(name)' | grep -q .; then
  bootstrap_password="$(openssl rand -base64 36)"
  printf '%s' "${bootstrap_password}" | CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER="${secret_endpoint}" gcloud secrets versions add "${bootstrap_secret}" \
    --location="${region}" --project="${project_id}" --data-file=- >/dev/null
else
  bootstrap_password="$(CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER="${secret_endpoint}" gcloud secrets versions access latest --secret="${bootstrap_secret}" --location="${region}" --project="${project_id}")"
fi
gcloud sql users set-password postgres --instance="${instance}" --project="${project_id}" --password="${bootstrap_password}" >/dev/null
unset bootstrap_password

active_account="$(gcloud config get-value account 2>/dev/null)"
if [[ "${active_account}" == *.gserviceaccount.com ]]; then
  principals=("serviceAccount:${active_account}")
else
  principals=("user:${active_account}")
fi
IFS=',' read -r -a founders <<<"${PORTOMATIC_GCP_FOUNDER_PRINCIPALS}"
principals+=("${founders[@]}")

for raw_principal in "${principals[@]}"; do
  principal="$(printf '%s' "${raw_principal}" | xargs)"
  [[ -n "${principal}" ]] || continue
  kind="${principal%%:*}"
  identity="${principal#*:}"
  case "${kind}" in
    user) database_type="cloud_iam_user"; database_identity="${identity}" ;;
    serviceAccount) database_type="cloud_iam_service_account"; database_identity="${identity%.gserviceaccount.com}" ;;
    *) echo "Unsupported principal ${principal}" >&2; exit 1 ;;
  esac
  gcloud projects add-iam-policy-binding "${project_id}" --member="${principal}" --role=roles/cloudsql.instanceUser --condition=None >/dev/null
  if ! gcloud sql users list --instance="${instance}" --project="${project_id}" --format='value(name)' | grep -Fxq "${database_identity}"; then
    gcloud sql users create "${database_identity}" --instance="${instance}" --project="${project_id}" --type="${database_type}"
  fi
done

node "${script_dir}/apply-migrations.mjs"
node "${script_dir}/grant-database-access.mjs"
echo "Private Cloud SQL customer-call database is ready: ${project_id}:${region}:${instance}/${database}"

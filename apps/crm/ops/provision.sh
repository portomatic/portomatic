#!/bin/bash
set -euo pipefail
CRM_PROJECT=affable-heading-498721-f4
CRM_SA=portomatic-crm@$CRM_PROJECT.iam.gserviceaccount.com
if ! gcloud iam service-accounts describe "$CRM_SA" --project="$CRM_PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create portomatic-crm --display-name='Portomatic CRM' --project="$CRM_PROJECT"
fi
gcloud services enable aiplatform.googleapis.com --project="$CRM_PROJECT" --quiet
gcloud projects add-iam-policy-binding "$CRM_PROJECT" --member="serviceAccount:$CRM_SA" --role=roles/aiplatform.user --condition=None --quiet >/dev/null
gcloud projects add-iam-policy-binding "$CRM_PROJECT" --member="serviceAccount:$CRM_SA" --role=roles/cloudsql.instanceUser --condition=None --quiet >/dev/null
for CRM_BUCKET in portomatic-private-media-400742035256 portomatic-customer-recordings-400742035256; do
  gcloud storage buckets add-iam-policy-binding "gs://$CRM_BUCKET" --member="serviceAccount:$CRM_SA" --role=roles/storage.objectViewer --quiet >/dev/null
done
# Derived transcripts/manifests can be created, but originals cannot be overwritten or deleted.
gcloud storage buckets add-iam-policy-binding gs://portomatic-private-media-400742035256 --member="serviceAccount:$CRM_SA" --role=roles/storage.objectCreator --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$CRM_SA" --member="serviceAccount:$CRM_SA" --role=roles/iam.serviceAccountTokenCreator --project="$CRM_PROJECT" --quiet >/dev/null
for CRM_SECRET in crm-cloudflared-token; do
  if ! gcloud secrets describe "$CRM_SECRET" --project="$CRM_PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$CRM_SECRET" --replication-policy=automatic --project="$CRM_PROJECT" --quiet
  fi
  gcloud secrets add-iam-policy-binding "$CRM_SECRET" --member="serviceAccount:$CRM_SA" --role=roles/secretmanager.secretAccessor --project="$CRM_PROJECT" --quiet >/dev/null
done
gcloud secrets versions add crm-cloudflared-token --data-file=apps/crm/.state/tunnel-token --project="$CRM_PROJECT" --quiet >/dev/null
if ! gcloud sql users list --instance=portomatic-calls --project="$CRM_PROJECT" --format='value(name)' | grep -Fxq "${CRM_SA%.gserviceaccount.com}"; then
 gcloud sql users create "${CRM_SA%.gserviceaccount.com}" --instance=portomatic-calls --type=cloud_iam_service_account --project="$CRM_PROJECT" --quiet
fi
if ! gcloud compute networks describe crm --project="$CRM_PROJECT" >/dev/null 2>&1; then
 gcloud compute networks create crm --subnet-mode=custom --project="$CRM_PROJECT" --quiet
 gcloud compute networks subnets create crm-us-central1 --network=crm --range=10.86.0.0/24 --region=us-central1 --project="$CRM_PROJECT" --quiet
 gcloud compute firewall-rules create crm-iap-ssh --network=crm --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=crm --project="$CRM_PROJECT" --quiet
fi
if ! gcloud compute instances describe portomatic-crm --zone=us-central1-a --project="$CRM_PROJECT" >/dev/null 2>&1; then
 gcloud compute instances create portomatic-crm --zone=us-central1-a --machine-type=e2-medium --subnet=crm-us-central1 --service-account="$CRM_SA" --scopes=cloud-platform --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=100GB --boot-disk-type=pd-balanced --tags=crm --metadata=enable-oslogin=TRUE --shielded-secure-boot --project="$CRM_PROJECT" --quiet
fi

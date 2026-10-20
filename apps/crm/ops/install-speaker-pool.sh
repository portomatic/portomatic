#!/bin/bash
# Change only the CRM consumer. Pool production services remain untouched.
set -euo pipefail
[ "$(hostname)" = portomatic-crm ] || { echo 'Wrong host' >&2; exit 1; }
cat > /usr/local/sbin/crm-load-pool-secret <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
install -d -o crm -g crm -m 700 /run/portomatic-crm
install -d -m 700 /run/portomatic-crm-loader
CRM_POOL_TEMP=$(mktemp /run/portomatic-crm/pool-key.XXXXXX)
trap 'rm -f "$CRM_POOL_TEMP"' EXIT
CLOUDSDK_CONFIG=/run/portomatic-crm-loader gcloud secrets versions access latest --secret=crm-pool-api-key --project=affable-heading-498721-f4 --out-file="$CRM_POOL_TEMP" --quiet
chown crm:crm "$CRM_POOL_TEMP"
chmod 600 "$CRM_POOL_TEMP"
mv -f "$CRM_POOL_TEMP" /run/portomatic-crm/pool-key
SCRIPT
chmod 700 /usr/local/sbin/crm-load-pool-secret
/usr/local/sbin/crm-load-pool-secret
install -d /etc/systemd/system/portomatic-speakers.service.d /etc/systemd/system/portomatic-crm.service.d
cat > /etc/systemd/system/portomatic-speakers.service.d/pool.conf <<'UNIT'
[Service]
Environment=CRM_SPEAKER_BACKEND=pool
Environment=CRM_SPEAKER_MODEL=gpt-6.1-sol
Environment=CRM_SPEAKER_REASONING_EFFORT=medium
Environment=CRM_POOL_KEY_FILE=/run/portomatic-crm/pool-key
ExecStartPre=+/usr/local/sbin/crm-load-pool-secret
UNIT
cat > /etc/systemd/system/portomatic-crm.service.d/pool-speakers.conf <<'UNIT'
[Service]
Environment=CRM_SPEAKER_BACKEND=pool
Environment=CRM_SPEAKER_MODEL=gpt-6.1-sol
Environment=CRM_SPEAKER_REASONING_EFFORT=medium
Environment=CRM_POOL_KEY_FILE=/run/portomatic-crm/pool-key
UNIT
systemctl daemon-reload
systemctl start portomatic-speakers
systemctl restart portomatic-crm

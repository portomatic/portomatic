#!/bin/bash
# Run as root on the dedicated CRM VM after deploying code and migration 020.
set -euo pipefail
[ "$(hostname)" = portomatic-crm ] || { echo 'Wrong host' >&2; exit 1; }
apt-get update -qq
apt-get install -y -qq tesseract-ocr >/dev/null
cat > /usr/local/sbin/crm-load-openai-secret <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /run/portomatic-crm /run/portomatic-crm-loader
CLOUDSDK_CONFIG=/run/portomatic-crm-loader gcloud secrets versions access latest --secret=crm-openai-api-key --project=affable-heading-498721-f4 > /run/portomatic-crm/openai-key.tmp
chown crm:crm /run/portomatic-crm/openai-key.tmp
mv /run/portomatic-crm/openai-key.tmp /run/portomatic-crm/openai-key
chown crm:crm /run/portomatic-crm
chmod 700 /run/portomatic-crm
SCRIPT
chmod 700 /usr/local/sbin/crm-load-openai-secret
/usr/local/sbin/crm-load-openai-secret
mkdir -p /etc/systemd/system/portomatic-crm.service.d
cat > /etc/systemd/system/portomatic-crm.service.d/speakers.conf <<'UNIT'
[Service]
Environment=CRM_OPENAI_KEY_FILE=/run/portomatic-crm/openai-key
UNIT
cat > /etc/systemd/system/portomatic-speakers.service <<'UNIT'
[Unit]
Description=Portomatic contextual speaker agents
After=network-online.target
Wants=network-online.target
[Service]
User=crm
WorkingDirectory=/opt/portomatic
EnvironmentFile=/etc/portomatic-crm.env
Environment=CRM_OPENAI_KEY_FILE=/run/portomatic-crm/openai-key
Environment=CRM_SPEAKER_MODEL=latest-luna
Environment=CRM_SPEAKER_CONCURRENCY=3
ExecStartPre=+/usr/local/sbin/crm-load-openai-secret
ExecStart=/usr/local/bin/node apps/crm/speaker-worker.mjs
KillMode=mixed
TimeoutStopSec=10min
Restart=always
RestartSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/portomatic/apps/crm/.state /var/lib/portomatic-crm /run/portomatic-crm
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now portomatic-speakers
systemctl restart portomatic-crm

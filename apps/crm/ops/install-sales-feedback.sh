#!/bin/bash
set -euo pipefail
[ "$(hostname)" = portomatic-crm ] || { echo 'Wrong host' >&2; exit 1; }
[ -x /usr/local/bin/yc ]
[ -x /usr/local/sbin/crm-load-yc-secret ]
cat > /etc/systemd/system/portomatic-sales-feedback.service <<'UNIT'
[Unit]
Description=Portomatic automatic YC sales feedback
After=network-online.target
Wants=network-online.target
[Service]
User=crm
WorkingDirectory=/opt/portomatic
EnvironmentFile=/etc/portomatic-crm.env
Environment=CRM_OPENAI_KEY_FILE=/run/portomatic-crm/openai-key
Environment=CRM_YC_BIN=/usr/local/bin/yc
ExecStartPre=+/usr/local/sbin/crm-load-openai-secret
ExecStartPre=+/usr/local/sbin/crm-load-yc-secret
ExecStart=/usr/local/bin/node apps/crm/sales-feedback-worker.mjs
Restart=always
RestartSec=15
KillMode=mixed
TimeoutStopSec=180
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/portomatic/apps/crm/.state /var/lib/portomatic-crm /run/portomatic-crm
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now portomatic-sales-feedback
systemctl restart portomatic-crm

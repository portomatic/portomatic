#!/bin/bash
# Run on the dedicated CRM VM, never on Pool.
set -euo pipefail
[ "$(hostname)" = portomatic-crm ] || { echo 'Wrong host' >&2; exit 1; }
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils ffmpeg >/dev/null
if ! /usr/local/bin/node --version 2>/dev/null | grep -q '^v24'; then
 cd /tmp
 curl -fsSLO https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz
 curl -fsSLO https://nodejs.org/dist/v24.15.0/SHASUMS256.txt
 grep ' node-v24.15.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
 tar -xJf node-v24.15.0-linux-x64.tar.xz --strip-components=1 -C /usr/local
fi
if ! command -v cloudflared >/dev/null; then
 curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/crm-cloudflared.deb
 dpkg -i /tmp/crm-cloudflared.deb >/dev/null
fi
id crm >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/portomatic-crm crm
mkdir -p /opt/portomatic/apps/crm/.state
chown -R crm:crm /opt/portomatic
chmod 700 /opt/portomatic/apps/crm/.state
cd /opt/portomatic/apps/crm
/usr/local/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund
cat > /usr/local/sbin/crm-load-secrets <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /run/portomatic-crm
mkdir -p /run/portomatic-crm-loader
for pair in 'crm-cloudflared-token:tunnel-token'; do
 CLOUDSDK_CONFIG=/run/portomatic-crm-loader gcloud secrets versions access latest --secret="${pair%%:*}" --project=affable-heading-498721-f4 > "/run/portomatic-crm/${pair#*:}.tmp.$$"
 chown crm:crm "/run/portomatic-crm/${pair#*:}.tmp.$$"
 mv "/run/portomatic-crm/${pair#*:}.tmp.$$" "/run/portomatic-crm/${pair#*:}"
done
chown crm:crm /run/portomatic-crm
chmod 700 /run/portomatic-crm
SCRIPT
chmod 700 /usr/local/sbin/crm-load-secrets
/usr/local/sbin/crm-load-secrets
cat > /etc/systemd/system/portomatic-crm.service <<'UNIT'
[Unit]
Description=Portomatic CRM
After=network-online.target
Wants=network-online.target
[Service]
User=crm
WorkingDirectory=/opt/portomatic
EnvironmentFile=/etc/portomatic-crm.env
ExecStart=/usr/local/bin/node apps/crm/server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/portomatic/apps/crm/.state /var/lib/portomatic-crm
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/portomatic-transcription.service <<'UNIT'
[Unit]
Description=Portomatic recording transcription
After=network-online.target
Wants=network-online.target
[Service]
User=crm
WorkingDirectory=/opt/portomatic
EnvironmentFile=/etc/portomatic-crm.env
Environment=CRM_TRANSCRIPTION_CONCURRENCY=4
ExecStart=/usr/local/bin/node apps/crm/transcribe-worker.mjs
KillMode=mixed
TimeoutStopSec=20min
Restart=always
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/portomatic/apps/crm/.state /var/lib/portomatic-crm /run/portomatic-crm
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/portomatic-crm-tunnel.service <<'UNIT'
[Unit]
Description=Portomatic CRM Cloudflare tunnel
After=network-online.target portomatic-transcription.service
Wants=network-online.target
[Service]
User=crm
ExecStartPre=+/usr/local/sbin/crm-load-secrets
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token-file /run/portomatic-crm/tunnel-token
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/run/portomatic-crm
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now portomatic-crm portomatic-transcription portomatic-crm-tunnel

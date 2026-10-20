#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"
CRM_NODE="$(command -v node)"
CRM_NODE_DIR="$(dirname "$CRM_NODE")"
CRM_HOME="$HOME"
CRM_LABEL="com.portomatic.crm"
CRM_AGENT="$CRM_HOME/Library/LaunchAgents/$CRM_LABEL.plist"
mkdir -p "$CRM_HOME/Library/LaunchAgents" "$CRM_HOME/Library/Logs" "$APP_DIR/.state"
chmod 700 "$APP_DIR/.state"
npm --prefix "$APP_DIR" ci --omit=dev --ignore-scripts --no-audit --no-fund
node "$APP_DIR/cli.mjs" init
CRM_APP="$APP_DIR" CRM_NODE_PATH="$CRM_NODE" CRM_NODE_FOLDER="$CRM_NODE_DIR" CRM_PLIST="$CRM_AGENT" python3 - <<'PY'
import os,plistlib
p={
 'Label':'com.portomatic.crm',
 'ProgramArguments':[os.environ['CRM_NODE_PATH'],os.environ['CRM_APP']+'/server.mjs'],
 'WorkingDirectory':os.environ['CRM_APP'],
 'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,
 'EnvironmentVariables':{'PATH':os.environ['CRM_NODE_FOLDER']+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
 'StandardOutPath':os.path.expanduser('~/Library/Logs/portomatic-crm.log'),
 'StandardErrorPath':os.path.expanduser('~/Library/Logs/portomatic-crm.log')}
with open(os.environ['CRM_PLIST'],'wb') as f:plistlib.dump(p,f)
PY
plutil -lint -s "$CRM_AGENT"
if launchctl print "gui/$(id -u)/$CRM_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$CRM_LABEL"
fi
launchctl bootstrap "gui/$(id -u)" "$CRM_AGENT"
CRM_CADDY_ETC="$(brew --prefix)/etc"
mkdir -p "$CRM_CADDY_ETC/caddy.d"
cp "$APP_DIR/ops/Caddyfile.crm.localhost" "$CRM_CADDY_ETC/caddy.d/crm.localhost.caddy"
caddy validate --config "$CRM_CADDY_ETC/Caddyfile" >/dev/null
caddy reload --config "$CRM_CADDY_ETC/Caddyfile"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null http://crm.localhost/api/health; then
    echo "Portomatic CRM is running at http://crm.localhost"
    exit 0
  fi
  sleep 1
done
echo "CRM did not start. See ~/Library/Logs/portomatic-crm.log" >&2
exit 1

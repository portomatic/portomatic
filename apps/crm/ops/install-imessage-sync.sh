#!/bin/bash
set -euo pipefail
CRM_APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRM_NODE_PATH="$(command -v node)"
CRM_SYNC_LABEL="com.portomatic.crm.imessage-sync"
CRM_SYNC_PLIST="$HOME/Library/LaunchAgents/$CRM_SYNC_LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
CRM_SYNC_APP="$CRM_APP_DIR" CRM_SYNC_NODE="$CRM_NODE_PATH" CRM_SYNC_AGENT="$CRM_SYNC_PLIST" python3 - <<'PY'
import os,plistlib
node=os.environ['CRM_SYNC_NODE']
value={
 'Label':'com.portomatic.crm.imessage-sync',
 'ProgramArguments':[node,os.environ['CRM_SYNC_APP']+'/cli.mjs','imessage-sync'],
 'WorkingDirectory':os.environ['CRM_SYNC_APP'],
 'RunAtLoad':True,'StartInterval':60,'ProcessType':'Background',
 'EnvironmentVariables':{'PATH':os.path.dirname(node)+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
 'StandardOutPath':os.path.expanduser('~/Library/Logs/portomatic-imessage-sync.log'),
 'StandardErrorPath':os.path.expanduser('~/Library/Logs/portomatic-imessage-sync.log')}
with open(os.environ['CRM_SYNC_AGENT'],'wb') as f:plistlib.dump(value,f)
os.chmod(os.environ['CRM_SYNC_AGENT'],0o600)
PY
plutil -lint "$CRM_SYNC_PLIST"
if launchctl print "gui/$(id -u)/$CRM_SYNC_LABEL" >/dev/null 2>&1; then
 launchctl bootout "gui/$(id -u)/$CRM_SYNC_LABEL"
fi
launchctl bootstrap "gui/$(id -u)" "$CRM_SYNC_PLIST"

#!/bin/bash
# Run as root on the dedicated CRM VM. Never print the OAuth credential payload.
set -euo pipefail
[ "$(hostname)" = portomatic-crm ] || { echo 'Wrong host' >&2; exit 1; }
CRM_YC_VERSION=${CRM_YC_VERSION:-0.0.18}
case "$(uname -m)" in
  x86_64) CRM_YC_PLATFORM=linux-x64 ;;
  aarch64|arm64) CRM_YC_PLATFORM=linux-arm64 ;;
  *) echo 'Unsupported YC CLI architecture' >&2; exit 1 ;;
esac
CRM_YC_DOWNLOAD=$(mktemp -d)
trap 'rm -rf "$CRM_YC_DOWNLOAD"' EXIT
curl -fsSL "https://bookface-public.s3.us-west-2.amazonaws.com/cli/$CRM_YC_VERSION/yc-$CRM_YC_PLATFORM" -o "$CRM_YC_DOWNLOAD/yc"
curl -fsSL "https://bookface-public.s3.us-west-2.amazonaws.com/cli/$CRM_YC_VERSION/yc-$CRM_YC_PLATFORM.sha256" -o "$CRM_YC_DOWNLOAD/checksum"
CRM_YC_EXPECTED=$(awk '{print $1}' "$CRM_YC_DOWNLOAD/checksum")
CRM_YC_ACTUAL=$(sha256sum "$CRM_YC_DOWNLOAD/yc" | awk '{print $1}')
[ "$CRM_YC_EXPECTED" = "$CRM_YC_ACTUAL" ] || { echo 'YC CLI checksum mismatch' >&2; exit 1; }
install -o root -g root -m 755 "$CRM_YC_DOWNLOAD/yc" /usr/local/bin/yc

cat > /usr/local/sbin/crm-load-yc-secret <<'SCRIPT'
#!/bin/bash
set -euo pipefail
umask 077
CRM_YC_DIR=/var/lib/portomatic-crm/.yc
install -d -o crm -g crm -m 700 "$CRM_YC_DIR"
# Preserve credentials refreshed by YC. Use --replace after explicitly adding a
# newer login to Secret Manager, rather than restoring an old token on restart.
if [ -s "$CRM_YC_DIR/credentials.json" ] && [ "${1:-}" != --replace ]; then exit 0; fi
CRM_YC_TEMP=$(mktemp "$CRM_YC_DIR/credentials.XXXXXX")
trap 'rm -f "$CRM_YC_TEMP"' EXIT
install -d -m 700 /run/portomatic-crm-loader
CLOUDSDK_CONFIG=/run/portomatic-crm-loader gcloud secrets versions access latest --secret=crm-yc-credentials --project=affable-heading-498721-f4 --out-file="$CRM_YC_TEMP" --quiet
/usr/local/bin/node --input-type=module - "$CRM_YC_TEMP" <<'JS'
import fs from 'node:fs';
try {
  const credential=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(typeof credential.access_token!=='string'||!credential.access_token||typeof credential.refresh_token!=='string'||!credential.refresh_token)throw Error();
} catch {process.stderr.write('Invalid YC credential payload\n');process.exit(1);}
JS
chown crm:crm "$CRM_YC_TEMP"
chmod 600 "$CRM_YC_TEMP"
mv -f "$CRM_YC_TEMP" "$CRM_YC_DIR/credentials.json"
SCRIPT
chmod 700 /usr/local/sbin/crm-load-yc-secret
/usr/local/sbin/crm-load-yc-secret
/usr/local/bin/yc --version

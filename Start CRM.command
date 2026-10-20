#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! curl -fsS -o /dev/null --max-time 5 http://crm.localhost/api/health; then
  bash apps/crm/ops/install.sh
fi
open http://crm.localhost

#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
mkdir -p bin
scripts/go.sh build -trimpath -buildvcs=false -o bin/routeweaver-control-plane ./cmd/control-plane
scripts/go.sh build -trimpath -buildvcs=false -o bin/routeweaver-node-agent ./cmd/node-agent
scripts/go.sh build -trimpath -buildvcs=false -o bin/routeweaver-notification-migrate ./cmd/notification-migrate
scripts/go.sh -C runtimes/xray build -trimpath -buildvcs=false -o ../../bin/routeweaver-xray ./cmd/routeweaver-xray
npm --prefix web run build
printf '\nBuilt control-plane, node-agent, managed Xray, offline notification maintenance tool and web/dist. No publication or deployment was performed.\n'

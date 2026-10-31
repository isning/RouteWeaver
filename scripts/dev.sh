#!/usr/bin/env bash
# Starts only loopback demo processes. Real operations/credentials are separate.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
mkdir -p bin
scripts/go.sh build -o bin/routeweaver-control-plane ./cmd/control-plane
bin/routeweaver-control-plane --demo --listen 127.0.0.1:8080 &
BACKEND=$!
cleanup() { kill "$BACKEND" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
sleep 0.3
kill -0 "$BACKEND" 2>/dev/null || { wait "$BACKEND"; exit 1; }
npm --prefix web run dev -- --host 127.0.0.1 --port 5173

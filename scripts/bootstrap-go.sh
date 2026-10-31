#!/usr/bin/env bash
# Download only the exact official Go version declared by this repository.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(awk '$1 == "go" {print $2; exit}' "$ROOT/go.mod")
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo 'Use an official Go installation on this operating system.' >&2; exit 2 ;; esac
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo 'Unsupported bootstrap architecture; install Go from go.dev.' >&2; exit 2 ;; esac
DEST="$ROOT/bin/toolchain"
mkdir -p "$DEST"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 'https://go.dev/dl/?mode=json&include=all' -o "$TMP/releases.json"
FILE="go$VERSION.$OS-$ARCH.tar.gz"
SHA=$(python3 - "$TMP/releases.json" "$FILE" <<'PY'
import json,sys
items=[f for r in json.load(open(sys.argv[1])) for f in r['files'] if f['filename']==sys.argv[2]]
if len(items)!=1: raise SystemExit('Exact official archive was not found; refusing to guess a version or URL.')
print(items[0]['sha256'])
PY
)
curl --fail --location --proto '=https' --tlsv1.2 "https://go.dev/dl/$FILE" -o "$TMP/$FILE"
python3 - "$TMP/$FILE" "$SHA" <<'PY'
import hashlib,sys
with open(sys.argv[1],'rb') as file: actual=hashlib.file_digest(file,'sha256').hexdigest()
if actual!=sys.argv[2]: raise SystemExit('Checksum mismatch; refusing to extract or run the archive.')
print('Official Go archive checksum verified:',actual)
PY
if [[ -e "$DEST/go" ]]; then echo "Refusing to overlay existing $DEST/go. Use ROUTEWEAVER_GO or remove the old installation yourself." >&2; exit 2; fi
tar -xzf "$TMP/$FILE" -C "$DEST"
# Keep Go's deliberately non-buildable compiler test corpus out of this
# application module's ./... traversal. This is an installation boundary,
# not an exclusion of repository tests.
printf 'module routeweaver.local/toolchain\n' > "$DEST/go.mod"
"$DEST/go/bin/go" version

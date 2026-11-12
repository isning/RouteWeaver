#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
GOFMT="$(scripts/go.sh env GOROOT)/bin/gofmt"
mapfile -d '' FILES < <(find cmd internal runtimes scripts/check-architecture -type f -name '*.go' -print0)
if [[ "${1:---check}" == --write ]]; then
  "$GOFMT" -w "${FILES[@]}"
elif [[ "${1:---check}" == --check ]]; then
  UNFORMATTED=$("$GOFMT" -l "${FILES[@]}")
  if [[ -n "$UNFORMATTED" ]]; then
    printf 'Go formatting required (run scripts/format.sh --write):\n%s\n' "$UNFORMATTED" >&2
    # Keep the original inventory; -d emits diffs only for files needing repair.
    "$GOFMT" -d "${FILES[@]}" >&2
    exit 1
  fi
else
  echo 'Usage: scripts/format.sh [--check|--write]' >&2
  exit 2
fi

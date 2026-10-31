#!/usr/bin/env python3
"""Reject tracked operator state/artifacts; not a general secret-content scanner."""
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
result = subprocess.run(["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True)
paths = [path for path in result.stdout.decode().split("\0") if path]
blocked = []
for raw in paths:
    path = pathlib.PurePosixPath(raw)
    name = path.name
    if any(part in {"node_modules", ".local", "bin"} for part in path.parts):
        blocked.append(raw)
    elif name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        blocked.append(raw)
    elif name.endswith((".db", ".db-wal", ".db-shm", ".age", ".token")):
        blocked.append(raw)
if blocked:
    print("Operator state or private artifacts must not be tracked:", file=sys.stderr)
    print("\n".join(blocked), file=sys.stderr)
    sys.exit(1)
print(f"Tracked private-file guard: {len(paths)} files inspected. This is not secret-content analysis.")

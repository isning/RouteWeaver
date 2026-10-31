#!/usr/bin/env python3
"""Materialize exact official release assets for isolated local/CI native tests."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
    raise SystemExit("Native bootstrap is pinned for Linux amd64 only; do not substitute unverified platform assets.")
destination = Path(os.environ.get("ROUTEWEAVER_CORE_BIN_DIR", ROOT / "bin/cores")).resolve()
destination.mkdir(parents=True, exist_ok=True)
lock = json.loads((ROOT / "scripts/core-lock.json").read_text())
for core in lock["cores"]:
    path = destination / core["id"]
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise SystemExit(f"Unsafe native executable path: {path}")
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != core["executableSHA256"]:
            raise SystemExit(f"Existing {path} does not match the lock; refusing to overwrite it.")
        print(f"Already verified: {core['id']} {core['version']}")
    cached_archive = destination / (core["id"] + ".download")
    if cached_archive.is_symlink() or (cached_archive.exists() and not cached_archive.is_file()):
        raise SystemExit(f"Unsafe archive cache path: {cached_archive}")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "archive"
        if cached_archive.exists():
            data = cached_archive.read_bytes()
        else:
            subprocess.run(["curl", "--disable", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--max-time", "180", "--max-filesize", "134217728", core["url"], "-o", str(archive)], check=True)
            data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != core["archiveSHA256"]:
            raise SystemExit(f"Archive checksum mismatch for {core['id']}; refusing to run.")
        if not cached_archive.exists():
            # Exclusive creation never replaces a concurrent/unexpected file.
            try:
                with cached_archive.open("xb") as output:
                    output.write(data)
            except FileExistsError:
                if cached_archive.is_symlink() or hashlib.sha256(cached_archive.read_bytes()).hexdigest() != core["archiveSHA256"]:
                    raise SystemExit(f"Archive cache changed: {cached_archive}")
        if path.exists():
            continue
        # Extract only the named executable, never arbitrary archive paths.
        if core["id"] == "mihomo":
            executable = gzip.decompress(data)
        elif core["id"] == "sing-box":
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                stream = tar.extractfile(f"sing-box-{core['version']}-linux-amd64/sing-box")
                if stream is None:
                    raise SystemExit("Expected sing-box executable is missing from the archive.")
                executable = stream.read()
        elif core["id"] == "xray":
            with zipfile.ZipFile(io.BytesIO(data)) as archive_file:
                executable = archive_file.read("xray")
        else:
            raise SystemExit("Unknown core packaging; refusing to guess an extraction command.")
        if hashlib.sha256(executable).hexdigest() != core["executableSHA256"]:
            raise SystemExit(f"Executable checksum mismatch for {core['id']}.")
        try:
            with path.open("xb") as output:
                output.write(executable)
            path.chmod(0o755)
        except FileExistsError:
            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != core["executableSHA256"]:
                raise SystemExit(f"Native executable changed: {path}")
        print(f"Verified official release bytes: {core['id']} {core['version']}")
print("Native test binaries ready. No core service has been installed or started.")

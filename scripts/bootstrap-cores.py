#!/usr/bin/env python3
"""Verify isolated compatibility and version-addressed stock core test assets."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def compatibility_entries(lock):
    entries = []
    for pin in lock["cores"]:
        core = dict(pin)
        if core["id"] == "mihomo":
            core.update(archiveFormat="gzip", executablePath="")
        elif core["id"] == "sing-box":
            core.update(archiveFormat="tar.gz", executablePath=f"sing-box-{core['version']}-linux-amd64/sing-box")
        elif core["id"] == "xray":
            core.update(archiveFormat="zip", executablePath="xray")
        else:
            raise SystemExit("Unknown compatibility core packaging; refusing to guess.")
        entries.append(core)
    return entries


def materialize(core, destination):
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", core["id"]):
        raise SystemExit("Unsafe core cache identity")
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
            # Retry only transient server failures/timeouts at the same pinned URL.
            # Every attempt starts fresh; integrity failures below are never retried.
            for attempt in range(4):
                archive.unlink(missing_ok=True)
                result = subprocess.run(["curl", "--disable", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--max-time", "180", "--max-filesize", "134217728", core["url"], "-o", str(archive), "--write-out", "%{http_code}"],
                                        stdout=subprocess.PIPE, text=True, check=False)
                if result.returncode == 0:
                    break
                transient = result.returncode == 28 or (
                    result.returncode == 22 and result.stdout.strip() in {"500", "502", "503", "504"})
                if not transient or attempt == 3:
                    result.check_returncode()
                delay = 2 ** (attempt + 1)
                print(f"Transient native download failure; retry {attempt + 1}/3 in {delay}s.", flush=True)
                time.sleep(delay)
            data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != core["archiveSHA256"]:
            raise SystemExit(f"Archive checksum mismatch for {core['id']}; refusing to extract.")
        if not cached_archive.exists():
            try:
                with cached_archive.open("xb") as output:
                    output.write(data)
            except FileExistsError:
                if cached_archive.is_symlink() or hashlib.sha256(cached_archive.read_bytes()).hexdigest() != core["archiveSHA256"]:
                    raise SystemExit(f"Archive cache changed: {cached_archive}")
        if path.exists():
            return
        # Read one pinned member into memory; never extract arbitrary archive paths.
        if core["archiveFormat"] == "gzip":
            executable = gzip.decompress(data)
        elif core["archiveFormat"] == "tar.gz":
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                member = tar.getmember(core["executablePath"])
                if not member.isfile():
                    raise SystemExit("Expected executable must be a regular archive member.")
                stream = tar.extractfile(member)
                if stream is None:
                    raise SystemExit("Expected executable is missing from the archive.")
                executable = stream.read()
        elif core["archiveFormat"] == "zip":
            with zipfile.ZipFile(io.BytesIO(data)) as archive_file:
                member = archive_file.getinfo(core["executablePath"])
                mode = member.external_attr >> 16
                if member.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                    raise SystemExit("Expected executable must be a regular archive member.")
                executable = archive_file.read(member)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=["all", "compatibility", "stock"], default="all")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise SystemExit("Native bootstrap is pinned for Linux amd64 only; do not substitute unverified platform assets.")
    groups = []
    if args.kind in {"all", "compatibility"}:
        lock = json.loads((ROOT / "scripts/core-lock.json").read_text())
        groups.append((Path(os.environ.get("ROUTEWEAVER_CORE_BIN_DIR", ROOT / "bin/cores")).resolve(), compatibility_entries(lock)))
    if args.kind in {"all", "stock"}:
        lock = json.loads((ROOT / "scripts/stock-core-lock.json").read_text())
        if any(core["platform"] != "linux-amd64" for core in lock["releases"]):
            raise SystemExit("Stock lock has an unverified platform")
        unavailable = set(lock.get("unavailableFixtureReleaseIDs", []))
        if unavailable - {core["id"] for core in lock["releases"]}:
            raise SystemExit("Unavailable fixture policy references unknown release")
        for core in lock["releases"]:
            if core["id"] in unavailable:
                print(f"Withdrawn upstream fixture is not downloaded: {core['id']} (receipt metadata retained)")
        groups.append((Path(os.environ.get("ROUTEWEAVER_STOCK_CORE_BIN_DIR", ROOT / "bin/stock-cores")).resolve(),
                       [core for core in lock["releases"] if core["id"] not in unavailable]))
    for destination, cores in groups:
        destination.mkdir(parents=True, exist_ok=True)
        if len({core["id"] for core in cores}) != len(cores):
            raise SystemExit("Duplicate core cache identity")
        for core in cores:
            materialize(core, destination)
    print("Native test binaries ready. No core service has been installed or started.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Install only the checksum-pinned official Linux amd64 Gitleaks release."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request


def main():
    root = Path(__file__).resolve().parents[2]
    lock = json.loads(Path(__file__).with_name("gitleaks.lock.json").read_text())
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        raise SystemExit("Pinned scanner bootstrap currently supports Linux amd64 only.")
    destination = root / "bin/tools/gitleaks"
    if destination.exists():
        if hashlib.sha256(destination.read_bytes()).hexdigest() != lock["executableSHA256"]:
            raise SystemExit("Existing scanner differs from its pin; refusing to replace it automatically.")
        print("Pinned Gitleaks executable already verified.")
        return
    with urllib.request.urlopen(lock["archiveURL"], timeout=60) as response:
        archive = response.read(20 * 1024 * 1024 + 1)
    if hashlib.sha256(archive).hexdigest() != lock["archiveSHA256"]:
        raise SystemExit("Gitleaks archive checksum mismatch; nothing installed.")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as release:
        entry = release.getmember("gitleaks")
        if not entry.isfile() or entry.size > 30 * 1024 * 1024:
            raise SystemExit("Unexpected scanner archive entry.")
        executable = release.extractfile(entry).read()
    if hashlib.sha256(executable).hexdigest() != lock["executableSHA256"]:
        raise SystemExit("Gitleaks executable checksum mismatch; nothing installed.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        temporary.write(executable)
        temporary_path = Path(temporary.name)
    try:
        temporary_path.chmod(0o755)
        os.replace(temporary_path, destination)
    finally:
        temporary_path.unlink(missing_ok=True)
    print(f"Verified and installed Gitleaks {lock['version']} (Linux amd64).")


if __name__ == "__main__":
    main()

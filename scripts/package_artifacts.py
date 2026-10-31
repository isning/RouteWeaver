#!/usr/bin/env python3
"""Exact-source manifests and deterministic local packages; not a signing service."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

GENERATED = {".git", "node_modules", "bin", ".local", "__pycache__", "coverage", "playwright-report", "test-results"}


def sha256_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.DEVNULL)


def source_manifest(root):
    root = Path(root).resolve()
    try:
        is_repository = Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel")).strip()).resolve() == root
    except (subprocess.CalledProcessError, FileNotFoundError):
        is_repository = False
    # Walk independently of .gitignore: ignored Go/TS source can still enter a
    # build. Only known generated/dependency locations are excluded.
    paths = []
    for base, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = sorted(d for d in directories if d not in GENERATED and not (Path(base) == root / "web" and d == "dist"))
        for name in directories:
            if (Path(base) / name).is_symlink():
                raise ValueError("Source contains a directory symlink")
        # Linked worktrees store their Git metadata pointer in a root .git file,
        # rather than a directory. Neither representation is build source.
        paths.extend(str((Path(base) / name).relative_to(root)) for name in filenames
                     if not name.endswith((".pyc", ".tsbuildinfo"))
                     and not (is_repository and Path(base) == root and name == ".git"))
    paths.sort()
    if is_repository:
        tracked = {os.fsdecode(p) for p in git(root, "ls-files", "--cached", "-z").split(b"\0") if p}
        commit = os.fsdecode(git(root, "rev-parse", "HEAD")).strip()
        dirty = bool(git(root, "status", "--porcelain", "--untracked-files=all")) or bool(set(paths) - tracked)
    else:
        commit, dirty = None, None
    files = []
    for relative in paths:
        path = root / relative
        name = path.name
        if (name == ".env" or (name.startswith(".env.") and name != ".env.example")
                or name.endswith((".db", ".db-wal", ".db-shm", ".age", ".token"))):
            raise ValueError(f"Operator state must be kept outside source: {relative}")
        if path.is_symlink():
            raise ValueError(f"Source symlink is not supported: {relative}")
        if not path.is_file():
            raise ValueError(f"Source file missing or not regular: {relative}")
        files.append({"path": relative, "sha256": sha256_file(path), "executable": bool(path.stat().st_mode & 0o111)})
    if not files:
        raise ValueError("Source manifest cannot be empty")
    return {"schemaVersion": 1, "kind": "git-worktree" if is_repository else "source-directory", "commit": commit,
            "dirty": dirty, "sha256": hashlib.sha256(canonical(files)).hexdigest(), "files": files}


def deterministic_archive(stage, output, epoch=0):
    stage, output = Path(stage).resolve(), Path(output).resolve()
    if output.is_relative_to(stage):
        raise ValueError("Archive destination must be outside staged package")
    if epoch < 0 or epoch > 0xFFFFFFFF:
        raise ValueError("SOURCE_DATE_EPOCH must fit an unsigned 32-bit timestamp")
    paths = [stage, *sorted(stage.rglob("*"))]
    for path in paths:
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f"Package contains a symlink or non-regular file: {path.name}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with temporary.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for path in paths:
                    info = archive.gettarinfo(str(path), arcname=str(path.relative_to(stage.parent)))
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = epoch
                    info.mode = 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644
                    info.pax_headers = {}
                    if path.is_file():
                        with path.open("rb") as stream:
                            archive.addfile(info, stream)
                    else:
                        archive.addfile(info)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def verify_archive(archive):
    archive = Path(archive)
    provenance = json.loads(Path(str(archive) + ".provenance.json").read_text())
    expected = provenance.get("archive", {})
    if (provenance.get("schemaVersion") != 1 or expected.get("name") != archive.name
            or expected.get("sha256") != sha256_file(archive) or expected.get("bytes") != archive.stat().st_size):
        raise ValueError("Package does not match its provenance receipt")
    return provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    manifest = commands.add_parser("manifest")
    manifest.add_argument("output", type=Path)
    manifest.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    manifest.add_argument("--require-clean", action="store_true")
    check = commands.add_parser("check-source")
    check.add_argument("manifest", type=Path)
    check.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    archive = commands.add_parser("archive")
    archive.add_argument("stage", type=Path)
    archive.add_argument("output", type=Path)
    archive.add_argument("--target", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("archive", type=Path)
    args = parser.parse_args()
    if args.command == "manifest":
        value = source_manifest(args.root)
        if args.require_clean and (value["kind"] != "git-worktree" or value["dirty"]):
            raise ValueError("A clean exact Git source is required for this package")
        args.output.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    elif args.command == "check-source":
        if json.loads(args.manifest.read_text()) != source_manifest(args.root):
            raise ValueError("Source changed during package build; refusing mixed-source provenance")
    elif args.command == "archive":
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
        manifest = json.loads((args.stage / "SOURCE-MANIFEST.json").read_text())
        deterministic_archive(args.stage, args.output, epoch)
        # A rebuilt archive is a new candidate until its own smoke runs.
        Path(str(args.output) + ".smoke.json").unlink(missing_ok=True)
        digest = sha256_file(args.output)
        receipt = {"schemaVersion": 1, "archive": {"name": args.output.name, "sha256": digest, "bytes": args.output.stat().st_size},
                   "target": args.target, "source": {key: value for key, value in manifest.items() if key != "files"},
                   "sourceDateEpoch": epoch, "githubRunId": os.environ.get("GITHUB_RUN_ID"),
                   "githubSha": os.environ.get("GITHUB_SHA"), "smoke": "not-run", "signed": False,
                   "scope": "Locally built package and content manifest; not an attestation, deployment or production acceptance."}
        Path(str(args.output) + ".provenance.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        Path(str(args.output) + ".sha256").write_text(f"{digest}  {args.output.name}\n")
        print(f"Packaged {args.output} (sha256 {digest}). Smoke testing has not run.")
    else:
        verify_archive(args.archive)
        print("PASS: archive bytes match provenance receipt; this is not a cryptographic signature.")


if __name__ == "__main__":
    main()

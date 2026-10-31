#!/usr/bin/env python3
"""Pinned Gitleaks over current source, the index and reachable commit blobs.

No Git diff parsing: binary attributes and merge-only commits cannot hide a blob.
Findings expose only paths, rules and line numbers, never matched secret values.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SECURITY = ROOT / "scripts/security"


class ScanError(Exception):
    pass


def git(root, *arguments):
    result = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True)
    if result.returncode:
        # Git's diagnostics can echo contents/paths. Keep failure output bounded.
        raise ScanError(f"Git operation failed: {arguments[0]}")
    return result.stdout


def safe_relative(raw):
    path = PurePosixPath(os.fsdecode(raw))
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ScanError("Unsafe source path; scan incomplete.")
    return str(path)


def hardened_config(upstream):
    """Retain upstream detector rules, but remove every path-based exemption."""
    sections = re.split(r"(?=^\[)", upstream, flags=re.M)
    output = []
    for section in sections:
        if section.startswith("[allowlist]\n"):
            section = re.sub(r"^paths = \[.*?^\]\n", "", section, flags=re.M | re.S)
        elif section.startswith("[[rules.allowlists]]\n") and re.search(r"^paths =", section, re.M):
            # Remove the complete allowlist; removing only an AND path condition
            # would broaden its exemption to every path.
            continue
        output.append(section)
    result = "".join(output)
    parsed = tomllib.loads(result)
    if parsed.get("allowlist", {}).get("paths"):
        raise ScanError("Upstream global path exemptions were not removed.")
    if any(a.get("paths") for rule in parsed["rules"] for a in rule.get("allowlists", [])):
        raise ScanError("Upstream rule path exemptions were not removed.")
    return result


def source_entries(root, scope):
    is_git = (root / ".git").exists()
    if scope == "all" and not is_git:
        raise ScanError("Full secret scan requires a Git repository; use --scope tree only for an explicitly source-only scan.")
    if is_git:
        if Path(os.fsdecode(git(root, "rev-parse", "--show-toplevel")).strip()).resolve() != root:
            raise ScanError("Scan root must be the Git repository root.")
        paths = {safe_relative(p) for p in git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0") if p}
    else:
        paths = set()
        for base, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in {".git", "bin", "node_modules", ".local", "__pycache__"}
                             and not (Path(base) / d).is_symlink())
            for name in files:
                relative = (Path(base) / name).relative_to(root).as_posix()
                if not relative.startswith(("web/dist/", "web/test-results/", "web/playwright-report/")):
                    paths.add(relative)
    for path in sorted(paths):
        source = root / path
        if not source.parent.resolve().is_relative_to(root):
            raise ScanError("Source path resolves outside the repository; scan incomplete.")
        try:
            mode = source.lstat().st_mode
        except FileNotFoundError:
            continue  # An unstaged deletion is still inspected in the index.
        if stat.S_ISLNK(mode):
            data = os.fsencode(os.readlink(source))
        elif stat.S_ISREG(mode):
            data = source.read_bytes()
        else:
            raise ScanError("Unsupported source entry (including submodules); scan incomplete.")
        yield "worktree", path, data
    if scope == "tree":
        return
    if git(root, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise ScanError("Reachable history is incomplete in a shallow clone; fetch-depth: 0 is required.")
    git(root, "rev-parse", "--verify", "HEAD")
    for entry in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, oid, stage = metadata.split()
        if stage != b"0" or mode == b"160000":
            raise ScanError("Unmerged index or submodule requires explicit review; scan incomplete.")
        yield "index", safe_relative(raw_path), git(root, "cat-file", "blob", oid.decode())
    seen = set()
    for commit in git(root, "rev-list", "--all", "HEAD").splitlines():
        for entry in git(root, "ls-tree", "-r", "-z", commit.decode()).split(b"\0"):
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            mode, kind, oid = metadata.split()
            if kind != b"blob":
                raise ScanError("Historical submodule requires explicit review; scan incomplete.")
            path = safe_relative(raw_path)
            key = (oid, path)
            if key not in seen:
                seen.add(key)
                yield f"history:{commit.decode()}", path, git(root, "cat-file", "blob", oid.decode())


def scan(root, scope, binary):
    lock = json.loads((SECURITY / "gitleaks.lock.json").read_text())
    upstream = (SECURITY / "gitleaks.upstream.toml").read_bytes()
    if hashlib.sha256(upstream).hexdigest() != lock["upstreamConfigSHA256"]:
        raise ScanError("Vendored Gitleaks rules differ from their reviewed pin.")
    if not binary.is_file() or hashlib.sha256(binary.read_bytes()).hexdigest() != lock["executableSHA256"]:
        raise ScanError("Pinned Gitleaks executable missing or modified. Run python3 scripts/security/bootstrap.py.")
    reviewed = json.loads((SECURITY / "false-positives.json").read_text())
    exceptions = set()
    for item in reviewed:
        if (set(item) != {"path", "rule", "lineSHA256", "reason"} or not item["reason"].strip()
                or not re.fullmatch(r"[a-f0-9]{64}", item["lineSHA256"])):
            raise ScanError("Invalid exact-line false-positive review entry.")
        exceptions.add((safe_relative(os.fsencode(item["path"])), item["rule"], item["lineSHA256"]))
    with tempfile.TemporaryDirectory(prefix="routeweaver-secret-scan-") as directory:
        temporary = Path(directory)
        config = temporary / "rules.toml"
        config.write_text(hardened_config(upstream.decode()))
        materialized = temporary / "files"
        materialized.mkdir()
        sources, seen = {}, set()
        count = 0
        for label, relative, data in source_entries(root, scope):
            count += 1
            digest = hashlib.sha256(data).hexdigest()
            key = (relative, digest)
            if key in seen:
                continue
            seen.add(key)
            target = materialized / str(len(sources)) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            # Gitleaks skips binary-typed files. Scan all plaintext embedded in
            # them too, preserving newlines and path-specific detectors. This
            # does not claim to decrypt or unpack arbitrary binary containers.
            encoding = "utf-8"
            if data.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
                encoding = "utf-32"
            elif data.startswith((b"\xff\xfe", b"\xfe\xff")):
                encoding = "utf-16"
            text = data.decode(encoding, errors="replace")
            text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", text)
            target.write_text(text)
            sources[str(target)] = (label, relative, text.splitlines())
        if not sources:
            raise ScanError("No source files found; an empty scan is not a pass.")
        report = temporary / "report.json"
        result = subprocess.run([str(binary), "dir", str(materialized), "--config", str(config),
                                 "--no-banner", "--no-color", "--redact=100", "--log-level", "error",
                                 "--max-target-megabytes", "0",
                                 "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(temporary / "absent-ignore"),
                                 "--report-format", "json", "--report-path", str(report)],
                                capture_output=True, cwd=temporary,
                                env={k: v for k, v in os.environ.items() if not k.startswith("GITLEAKS_")})
        if result.returncode not in {0, 1} or not report.is_file():
            raise ScanError("Pinned Gitleaks execution failed; no scan pass. Raw scanner diagnostics withheld to avoid exposing secrets.")
        findings = json.loads(report.read_text())
        if not isinstance(findings, list) or (result.returncode == 1 and not findings):
            raise ScanError("Invalid scanner report; scan incomplete.")
        rejected = 0
        accepted = 0
        for finding in findings:
            source = sources.get(str(Path(finding["File"]).resolve()))
            if source is None:
                raise ScanError("Scanner report has an unknown source path.")
            label, relative, lines = source
            start, end = finding["StartLine"], finding["EndLine"]
            if not (isinstance(start, int) and isinstance(end, int) and 0 <= start <= end <= len(lines)):
                raise ScanError("Scanner report has invalid line boundaries.")
            # Empty/path-only findings (line 0) can never receive a content exception.
            line_hash = hashlib.sha256("\n".join(lines[start - 1:end]).encode()).hexdigest()
            if start > 0 and (relative, finding["RuleID"], line_hash) in exceptions:
                accepted += 1
                continue
            rejected += 1
            print(f"SECRET FINDING {finding['RuleID']} {label} {json.dumps(relative)}:{finding['StartLine']}", file=sys.stderr)
        if rejected:
            print(f"FAIL: {rejected} potential secrets. No matched values were emitted.", file=sys.stderr)
            return 1
        print(f"PASS: pinned Gitleaks {lock['version']}; {len(sources)} distinct path/content pairs ({count} source entries); scope={scope}.")
        print(f"Reviewed exact path/rule/line false positives: {accepted}. No path-wide exemptions.")
        print("Scope: source plaintext patterns; not credential validity, encrypted/archive content, unreachable history or a security certification.")
        return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--scope", choices=["all", "tree"], default="all")
    parser.add_argument("--binary", type=Path, default=ROOT / "bin/tools/gitleaks")
    args = parser.parse_args()
    try:
        return scan(args.root.resolve(), args.scope, args.binary.resolve())
    except (ScanError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Secret scan incomplete: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

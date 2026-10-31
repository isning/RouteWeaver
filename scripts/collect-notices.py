#!/usr/bin/env python3
"""Offline, best-effort distribution notices. Not a compliance certification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

NOTICE = re.compile(r"^(?:(?:third[._-]party[._-])?(?:licen[cs]es?|notices?)|copying|copyright|authors|patents)([._-].*|$)", re.I)
SKIP = {"node_modules", ".git", ".hg", ".svn"}
README = re.compile(r"^readme([._-].*|$)", re.I)
LICENSE_HEADING = re.compile(r"^#{1,6}\s+licen[cs]e(?:\s|$)", re.I | re.M)


def notice_files(source):
    """Keep nested/vendored notices, but never traverse another npm installation."""
    for base, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (Path(base) / d).is_symlink())
        for name in sorted(files):
            path = Path(base) / name
            relative = path.relative_to(source)
            in_license_dir = any(p.lower() in {"licenses", "licences"} for p in relative.parts[:-1])
            if not path.is_file() or path.is_symlink():
                continue
            # Some upstream packages (e.g. is-mobile) put the full notice only here.
            # Retain the entire original README, never reconstruct license text.
            readme_license = README.match(name) and LICENSE_HEADING.search(path.read_text(errors="replace"))
            if NOTICE.match(name) or in_license_dir or readme_license:
                yield path


def collect(source, destination, identity):
    entry = dict(identity, texts=[])
    for path in notice_files(source):
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        entry["texts"].append({"path": str(relative), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    entry["status"] = "texts-retained" if entry["texts"] else "MISSING-LICENSE-TEXT"
    return entry


def go_dependencies(build_info):
    result = set()
    for line in build_info.splitlines():
        fields = line.split()
        if fields and fields[0] == "=>":
            raise ValueError("Replaced Go module requires explicit notice-source mapping")
        if fields and fields[0] == "dep":
            result.add((fields[1], fields[2]))
    return sorted(result)


def go_escape(value):
    return "".join("!" + char.lower() if char.isupper() else char for char in value)


def production_packages(web):
    lock = json.loads((web / "package-lock.json").read_text())
    if lock.get("lockfileVersion") != 3:
        raise ValueError("Expected npm lockfile version 3")
    for relative, metadata in sorted(lock["packages"].items()):
        if not relative or metadata.get("dev"):
            continue
        source = web / relative
        if not source.resolve().is_relative_to(web.resolve() / "node_modules") or metadata.get("link"):
            raise ValueError(f"Unsupported npm package location: {relative}")
        if not source.exists() and metadata.get("optional"):
            continue  # Not installed, hence not part of this build.
        installed = json.loads((source / "package.json").read_text())
        if installed.get("version") != metadata.get("version"):
            raise ValueError(f"Installed npm version differs from lock: {relative}")
        yield source, {"ecosystem": "npm", "name": installed["name"], "version": installed["version"],
                       "installation": relative, "declared_license": installed.get("license", metadata.get("license"))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="Fresh directory for collected notices and inventory")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--binary", action="append", help="Built Go binary to inventory (repeatable; defaults to control-plane and node-agent)")
    args = parser.parse_args()
    root, output = args.root.resolve(), args.destination
    if output.exists():
        raise ValueError("Destination must not exist (avoid stale notices)")
    output.mkdir(parents=True)
    env = dict(os.environ, GOPROXY="off", GOSUMDB="off")
    def go(*arguments):
        return subprocess.check_output([str(root / "scripts/go.sh"), *arguments], cwd=root, env=env, text=True).strip()
    binaries = args.binary or ["bin/routeweaver-control-plane", "bin/routeweaver-node-agent"]
    info = go("version", "-m", *binaries)
    (output / "go-build-info.txt").write_text(info + "\n")
    cache = Path(go("env", "GOMODCACHE"))
    entries = []
    for name, version in go_dependencies(info):
        source = cache / (go_escape(name) + "@" + go_escape(version))
        if not source.is_dir():
            raise ValueError(f"Go module source absent from local cache: {name}@{version}")
        relative = Path("go") / (name + "@" + version)
        entry = collect(source, output / relative, {"ecosystem": "go", "name": name, "version": version})
        entry["directory"] = str(relative)
        entries.append(entry)
    # The Go standard library is linked too; retain the compiler distribution license.
    goroot = Path(go("env", "GOROOT"))
    toolchain = output / "go-toolchain"
    toolchain.mkdir()
    shutil.copyfile(goroot / "LICENSE", toolchain / "LICENSE")
    for source, identity in production_packages(root / "web"):
        relative = Path("npm") / identity["installation"]
        entry = collect(source, output / relative, identity)
        entry["directory"] = str(relative)
        entries.append(entry)
    missing = [f'{e["ecosystem"]}:{e["name"]}@{e["version"]}' for e in entries if e["status"] != "texts-retained"]
    inventory = {"scope": "Linked root Go binary modules and installed npm lockfile production dependency superset; not an exact bundler inclusion map.",
                 "limitations": "Filename-based collection only. Retained texts do not certify compliance; embedded notices, source-offer obligations and nonstandard filenames require review. Managed Xray, when included, has separately packaged notices.",
                 "missing_license_texts": missing, "dependencies": entries}
    (output / "inventory.json").write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n")
    (output / "README.txt").write_text(inventory["scope"] + "\n" + inventory["limitations"] + "\n\n" +
        "Missing license text candidates (review before distribution):\n" + ("\n".join(missing) if missing else "None detected by filename scan; this is not a completeness claim.") + "\n")
    print(f"Retained notices for {len(entries)} dependencies; {len(missing)} missing text candidates. See {output}/inventory.json")
    for item in missing:
        print(f"WARNING: MISSING-LICENSE-TEXT {item}")


if __name__ == "__main__":
    main()

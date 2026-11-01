#!/usr/bin/env python3
"""Exhaustive root-module package shards; never filter individual tests."""
import argparse
import subprocess
import sys

HEAVY = {name: f"routeweaver/internal/{name}" for name in ("backup", "httpapi", "store")}
SHARDS = ("core", *HEAVY)


def partition(packages):
    if not packages or len(packages) != len(set(packages)):
        raise ValueError("Root package inventory must be nonempty and unique")
    if any((p != "routeweaver" and not p.startswith("routeweaver/")) or any(c.isspace() for c in p) for p in packages):
        raise ValueError("Unexpected root-module package path")
    missing = set(HEAVY.values()) - set(packages)
    if missing:
        raise ValueError("Missing required heavy packages: " + ", ".join(sorted(missing)))
    result = {name: [] for name in SHARDS}
    names = {package: name for name, package in HEAVY.items()}
    for package in packages:
        result[names.get(package, "core")].append(package)
    if not result["core"]:
        raise ValueError("Core package shard must not be empty")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shard", choices=SHARDS)
    args = parser.parse_args()
    try:
        inventory = subprocess.run(["scripts/go.sh", "list", "./..."], check=True,
                                   capture_output=True, text=True)
        print("\n".join(partition(inventory.stdout.splitlines())[args.shard]))
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"FAIL: backend package inventory: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

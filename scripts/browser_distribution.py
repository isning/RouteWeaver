#!/usr/bin/env python3
"""Balance complete Chromium files without changing Playwright's discovery rules.

The pinned, observed durations are scheduling estimates, never test selection or
budgets. New discovered files get a positive fallback. Removed/ignored measured
files require an explicit metadata update. Each shard re-lists its exact literal
file selectors and verifies every selected test identity before execution.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def parse_shard(value):
    match = re.fullmatch(r"([1-9][0-9]{0,2})/([1-9][0-9]{0,2})", value)
    if not match or int(match[1]) > int(match[2]):
        raise ValueError("Browser shard must be a one-based index/total (index <= total, each <= 999)")
    return int(match[1]), int(match[2])


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def positive_seconds(value):
    return type(value) is int and value > 0


def file_name(value):
    if not isinstance(value, str) or not value or "\\" in value or any(ord(c) < 32 for c in value):
        raise ValueError("Invalid browser inventory path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise ValueError(f"Browser path must be a normalized relative path: {value}")
    return value


def load_weights(path):
    data = json.loads(path.read_text(), object_pairs_hook=unique_object)
    if not isinstance(data, dict) or type(data.get("version")) is not int or data.get("version") != 1 or not positive_seconds(data.get("fallback_seconds")):
        raise ValueError("Invalid browser duration metadata version/fallback_seconds")
    sources, files = data.get("sources"), data.get("files")
    if not isinstance(sources, dict) or not isinstance(files, dict):
        raise ValueError("Browser duration metadata requires sources and files")
    for source in sources.values():
        if not isinstance(source, dict) or not re.fullmatch(r"[0-9a-f]{40}", str(source.get("commit", ""))):
            raise ValueError("Browser duration source requires an exact commit")
        parse_shard(source.get("shard", ""))
        datetime.fromisoformat(source.get("started_at", ""))
    weights = {}
    for name, value in files.items():
        file_name(name)
        if not isinstance(value, dict) or not positive_seconds(value.get("seconds")) or value.get("source") not in sources:
            raise ValueError(f"Invalid browser duration or provenance: {name}")
        weights[name] = value["seconds"]
    return weights, data["fallback_seconds"]


def inventory(data, test_root):
    if not isinstance(data, dict) or data.get("errors") != []:
        raise ValueError("Playwright discovery reported errors or an invalid report")
    if data.get("config", {}).get("rootDir") != str(test_root):
        raise ValueError("Playwright discovery root differs from web/tests; review distribution paths")
    result, seen = {}, set()

    def visit(suites):
        if not isinstance(suites, list):
            raise ValueError("Invalid Playwright suite inventory")
        for suite in suites:
            if not isinstance(suite, dict) or not isinstance(suite.get("specs", []), list):
                raise ValueError("Invalid Playwright suite")
            for spec in suite.get("specs", []):
                name = file_name(spec.get("file"))
                path = test_root / name
                if not path.is_file() or not path.resolve().is_relative_to(test_root.resolve()):
                    raise ValueError(f"Discovered browser file is absent or outside test root: {name}")
                identifier, tests = spec.get("id"), spec.get("tests")
                if not isinstance(identifier, str) or not identifier or identifier in seen:
                    raise ValueError("Missing or duplicate Playwright test identity")
                if not isinstance(tests, list) or not tests or any(t.get("projectName") != "chromium" for t in tests):
                    raise ValueError("Browser inventory must contain only Chromium project tests")
                seen.add(identifier)
                result.setdefault(name, set()).update((identifier, index) for index in range(len(tests)))
            visit(suite.get("suites", []))

    visit(data.get("suites"))
    if not result:
        raise ValueError("Chromium test inventory is empty")
    return result


def partition(names, weights, total, fallback):
    names = list(names)
    if not names or len(names) != len(set(names)) or type(total) is not int or not 1 <= total <= min(999, len(names)):
        raise ValueError("Browser file inventory must be unique and provide a nonempty shard for every job")
    if not positive_seconds(fallback) or any(not positive_seconds(value) for value in weights.values()):
        raise ValueError("Browser duration estimates must be positive integer seconds")
    stale = set(weights) - set(names)
    if stale:
        raise ValueError("Stale browser duration entries absent from Playwright discovery: " + ", ".join(sorted(stale)))
    groups, loads = [[] for _ in range(total)], [0] * total
    for name in sorted(names, key=lambda name: (-weights.get(name, fallback), name)):
        index = min(range(total), key=lambda index: (loads[index], index))
        groups[index].append(name)
        loads[index] += weights.get(name, fallback)
    return [sorted(group) for group in groups]


def exact_selector(path):
    # Playwright CLI operands are JavaScript RegExp strings, not literal paths.
    return "^" + re.sub(r"([\\^$.*+?()\[\]{}|])", r"\\\1", str(path)) + "$"


def discover(selectors=()):
    command = ["npm", "--silent", "--prefix", "web", "run", "test:browser", "--",
               "--list", "--reporter=json", *selectors]
    completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if completed.returncode:
        raise ValueError(f"Playwright discovery failed ({completed.returncode}):\n{completed.stdout}\n{completed.stderr}")
    return inventory(json.loads(completed.stdout, object_pairs_hook=unique_object), ROOT / "web/tests")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shard")
    args = parser.parse_args()
    try:
        index, total = parse_shard(args.shard)
        weights, fallback = load_weights(ROOT / "scripts/browser-durations.json")
        files = discover()
        selected = partition(files, weights, total, fallback)[index - 1]
        selectors = [exact_selector(ROOT / "web/tests" / name) for name in selected]
        expected = {name: files[name] for name in selected}
        if discover(selectors) != expected:
            raise ValueError("Literal file selection changed the discovered test inventory")
        count = sum(len(ids) for ids in expected.values())
        seconds = sum(weights.get(name, fallback) for name in selected)
        print(f"Browser shard {args.shard}: {len(selected)} complete files, {count} tests; "
              f"estimated test time {seconds}s (not a timeout or passing result).", file=sys.stderr)
        print("\n".join(selectors))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"FAIL: browser distribution: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

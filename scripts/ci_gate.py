#!/usr/bin/env python3
"""Fail-closed aggregate for the complete configured GitHub Actions job set."""
import json
import os
import sys

REQUIRED_JOBS = {"static", "secrets", "backend", "web", "api", "browser", "browser_native", "native", "package"}


BACKEND_JOBS = {"backend_core", "backend_backup", "backend_httpapi", "backend_store", "backend_managed"}


def verify_results(results, required=REQUIRED_JOBS):
    if not isinstance(results, dict) or set(results) != required:
        raise ValueError("CI result set differs from the required gates")
    failed = [name for name, value in sorted(results.items()) if not isinstance(value, dict) or value.get("result") != "success"]
    if failed:
        raise ValueError("Required CI gates did not succeed: " + ", ".join(failed))


def main():
    try:
        if sys.argv[1:] not in ([], ["backend"]):
            raise ValueError("Unknown CI aggregate")
        required = BACKEND_JOBS if sys.argv[1:] else REQUIRED_JOBS
        verify_results(json.loads(os.environ["ROUTEWEAVER_CI_RESULTS"]), required)
    except (KeyError, ValueError, TypeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: all configured " + ("backend shards" if sys.argv[1:] else "repository gates") + " succeeded. Not deployed acceptance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

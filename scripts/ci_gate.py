#!/usr/bin/env python3
"""Fail-closed aggregate for the complete configured GitHub Actions job set."""
import json
import os
import sys

REQUIRED_JOBS = {"static", "secrets", "backend", "web", "api", "browser", "native", "package"}


def verify_results(results):
    if not isinstance(results, dict) or set(results) != REQUIRED_JOBS:
        raise ValueError("CI result set differs from the required gates")
    failed = [name for name, value in sorted(results.items()) if not isinstance(value, dict) or value.get("result") != "success"]
    if failed:
        raise ValueError("Required CI gates did not succeed: " + ", ".join(failed))


def main():
    try:
        verify_results(json.loads(os.environ["ROUTEWEAVER_CI_RESULTS"]))
    except (KeyError, ValueError, TypeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print("PASS: all configured source, secret, backend, web, API, browser, native and package gates succeeded. Not deployed acceptance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

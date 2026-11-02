#!/usr/bin/env python3
"""Require the named same-instance browser/native case, with no skips/retries."""
import json
import sys

REQUIRED = "same browser publication is observed by the owned native instance and stopped"

def verify(report):
    specs = []
    def walk(suite):
        specs.extend(suite.get("specs", []))
        for nested in suite.get("suites", []):
            walk(nested)
    for suite in report.get("suites", []):
        walk(suite)
    if report.get("errors") or len(specs) != 1 or specs[0].get("title") != REQUIRED:
        raise ValueError("required native browser case absent, duplicated or errored")
    tests = specs[0].get("tests", [])
    if len(tests) != 1 or tests[0].get("status") != "expected":
        raise ValueError("required native browser case did not pass")
    results = tests[0].get("results", [])
    if len(results) != 1 or results[0].get("status") != "passed":
        raise ValueError("native browser case skipped, failed, interrupted or retried")

if __name__ == "__main__":
    try:
        verify(json.load(open(sys.argv[1])))
    except (ValueError, KeyError, IndexError, OSError) as error:
        sys.exit(f"FAIL: {error}")
    print("PASS: named same-instance browser/native gate; not target deployment acceptance.")

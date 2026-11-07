"""Exercise the shared CLI and actual-discovery contract without browsers/servers."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from test_browser_distribution import report

ROOT = Path(__file__).resolve().parents[1]
DISCOVER = ["--silent", "--prefix", "web", "run", "test:browser", "--", "--list", "--reporter=json"]
RUN = ["--prefix", "web", "run", "test:browser"]


class BrowserShardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="browser [literal]+ ")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.root = self.directory / "repo"
        (self.root / "scripts").mkdir(parents=True)
        self.tests = self.root / "web/tests"
        self.tests.mkdir(parents=True)
        for name in ("verify.sh", "browser_distribution.py"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts" / name)
        self.names = ["slow.ui.spec.ts", "a [copy]+.ui.spec.ts", "nested/b.ui.spec.ts", "new.ui.spec.ts", "c.ui.spec.ts"]
        for name in [*self.names, "ignored.ui.spec.ts", "separate.native.spec.ts", "api.api.spec.ts"]:
            path = self.tests / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.metadata = self.root / "scripts/browser-durations.json"
        self.metadata.write_text(json.dumps({"version": 1, "fallback_seconds": 30,
            "sources": {"measured": {"commit": "a" * 40, "shard": "1/4", "started_at": "2026-11-07T00:00:00Z"}},
            "files": {"slow.ui.spec.ts": {"seconds": 100, "source": "measured"}}}))
        npm = self.directory / "npm"
        npm.write_text('''#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
with open(os.environ['TEST_NPM_ARGS'], 'a') as out: out.write(json.dumps(args) + '\\n')
if '--list' not in args: sys.exit(int(os.environ['TEST_NPM_EXIT']))
if os.environ.get('TEST_LIST_EXIT'): sys.exit(int(os.environ['TEST_LIST_EXIT']))
if os.environ.get('TEST_LIST_INVALID'): print('not a JSON report'); sys.exit(0)
data = json.loads(os.environ['TEST_INVENTORY'])
selectors = args[args.index('--reporter=json') + 1:]
if selectors:
    data['suites'] = [suite for suite in data['suites'] if any(re.search(pattern, data['config']['rootDir'] + '/' + suite['specs'][0]['file']) for pattern in selectors)]
    if os.environ.get('TEST_SELECTION_DROP'): data['suites'] = []
    if os.environ.get('TEST_SELECTION_EXTRA'): data = json.loads(os.environ['TEST_INVENTORY'])
print(json.dumps(data))
''')
        npm.chmod(0o755)
        self.args = self.directory / "args"

    def run_gate(self, shard=None, mode="browser", npm_exit=0, **extra):
        self.args.unlink(missing_ok=True)
        env = {key: value for key, value in os.environ.items() if key != "ROUTEWEAVER_BROWSER_SHARD"}
        env.update(PATH=f"{self.directory}:{env['PATH']}", TEST_NPM_ARGS=str(self.args),
                   TEST_NPM_EXIT=str(npm_exit), TEST_INVENTORY=json.dumps(report(self.tests, self.names)), **extra)
        if shard is not None:
            env["ROUTEWEAVER_BROWSER_SHARD"] = shard
        return subprocess.run(["bash", str(self.root / "scripts/verify.sh"), mode], env=env, text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.args.read_text().splitlines()] if self.args.exists() else []

    def test_default_runs_unsharded_browser_gate(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls(), [RUN])
        self.assertIn("PASS: browser verification", result.stdout)

    def test_ci_shards_run_every_discovered_file_exactly_once_without_native_sharding(self):
        selected = []
        for index in range(1, 5):
            shard = f"{index}/4"
            with self.subTest(shard=shard):
                result = self.run_gate(shard)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = self.calls()
                self.assertEqual(len(calls), 3)
                self.assertEqual(calls[0], DISCOVER)
                self.assertEqual(calls[2][:5], [*RUN, "--"])
                patterns = calls[2][5:]
                self.assertTrue(patterns)
                self.assertEqual(calls[1], [*DISCOVER, *patterns])
                matches = [name for name in self.names if any(re.search(pattern, str(self.tests / name)) for pattern in patterns)]
                self.assertEqual(len(matches), len(patterns))
                selected.extend(matches)
                self.assertNotIn("--shard", json.dumps(calls))
                self.assertIn(f"PASS: browser shard {shard} only", result.stdout)
                self.assertNotIn("PASS: browser verification", result.stdout)
                for name in ("ignored.ui.spec.ts", "separate.native.spec.ts", "api.api.spec.ts"):
                    self.assertFalse(any(re.search(pattern, str(self.tests / name)) for pattern in patterns))
        self.assertCountEqual(selected, self.names)

    def test_invalid_shards_fail_before_discovery_or_execution(self):
        for shard in ("0/4", "5/4", "1/0", "1/04", "all", "1/4 --grep smoke", "1000/1000"):
            with self.subTest(shard=shard):
                result = self.run_gate(shard)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.args.exists())
                self.assertNotIn("PASS:", result.stdout)

    def test_full_verification_rejects_partial_shards(self):
        result = self.run_gate("1/4", mode="full")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Full verification cannot select a partial browser shard", result.stderr)
        self.assertFalse(self.args.exists())

    def test_inventory_failure_or_selector_mismatch_cannot_execute_or_pass(self):
        for extra in ({"TEST_LIST_EXIT": "9"}, {"TEST_LIST_INVALID": "1"},
                      {"TEST_SELECTION_DROP": "1"}, {"TEST_SELECTION_EXTRA": "1"}):
            with self.subTest(extra=extra):
                result = self.run_gate("2/4", **extra)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(all("--list" in call for call in self.calls()))
                self.assertNotIn("PASS:", result.stdout)
                self.assertIn("FAIL: browser distribution:", result.stderr)

    def test_stale_metadata_cannot_silently_drop_or_add_a_suite(self):
        data = json.loads(self.metadata.read_text())
        data["files"]["ignored.ui.spec.ts"] = {"seconds": 1, "source": "measured"}
        self.metadata.write_text(json.dumps(data))
        result = self.run_gate("1/4")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Stale browser duration entries", result.stderr)
        self.assertTrue(all("--list" in call for call in self.calls()))
        self.assertNotIn("PASS:", result.stdout)

    def test_browser_failure_still_fails_the_shard(self):
        result = self.run_gate("2/4", npm_exit=23)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertNotIn("PASS:", result.stdout)


if __name__ == "__main__":
    unittest.main()

"""No dropped tests: exhaustive package partition and shared-gate dry fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from backend_packages import HEAVY, SHARDS, partition

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ["routeweaver", "routeweaver/cmd/routeweaver", *HEAVY.values(), "routeweaver/internal/new_package"]


class BackendPackagesTests(unittest.TestCase):
    def test_partition_is_disjoint_exhaustive_and_new_packages_default_core(self):
        shards = partition(PACKAGES)
        flattened = [p for packages in shards.values() for p in packages]
        self.assertCountEqual(flattened, PACKAGES)
        self.assertEqual(len(set(flattened)), len(flattened))
        self.assertIn(PACKAGES[-1], shards["core"])
        for name, package in HEAVY.items():
            self.assertEqual(shards[name], [package])

    def test_invalid_inventories_fail_closed(self):
        for invalid in ([], PACKAGES + [PACKAGES[0]], list(HEAVY.values()),
                        PACKAGES + ["other/pkg"], PACKAGES + ["routeweaver/a b"]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                partition(invalid)
        for package in HEAVY.values():
            with self.assertRaises(ValueError):
                partition([p for p in PACKAGES if p != package])

    def fixture(self, directory):
        scripts = directory / "scripts"
        scripts.mkdir()
        for name in ("verify.sh", "backend_packages.py"):
            shutil.copy(ROOT / "scripts" / name, scripts / name)
        (scripts / "format.sh").write_text("#!/bin/sh\necho '[\"format\", \"--check\"]' >> \"$CALL_LOG\"\n")
        (scripts / "format.sh").chmod(0o755)
        (scripts / "go.sh").write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
if args == ['list', './...']:
    if os.environ.get('FAIL_LIST'): sys.exit(7)
    print(os.environ['INVENTORY'])
if os.environ.get('FAIL_TEST') and args[0] == 'test': sys.exit(8)
''')
        (scripts / "go.sh").chmod(0o755)
        return {**os.environ, "CALL_LOG": str(directory / "calls.jsonl"), "INVENTORY": "\n".join(PACKAGES)}

    def run_gate(self, directory, mode, env):
        return subprocess.run(["bash", "scripts/verify.sh", mode], cwd=directory,
                              env=env, capture_output=True, text=True, timeout=10)

    def test_backend_and_ci_stages_execute_identical_complete_commands(self):
        recordings = []
        for modes in (["backend"], [f"backend_{s}" for s in (*SHARDS, "managed")]):
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                env = self.fixture(directory)
                for mode in modes:
                    result = self.run_gate(directory, mode, env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in Path(env["CALL_LOG"]).read_text().splitlines()]
                recordings.append(calls)
        self.assertEqual(*recordings)
        tests = [c for c in recordings[0] if c[0] == "test"]
        self.assertEqual(len(tests), 4)
        for call in tests:
            self.assertEqual(call[:5], ["test", "-race", "-p=1", "-count=1", "-timeout=20m"])
        self.assertCountEqual([p for c in tests for p in c[5:]], PACKAGES)
        for call in (["format", "--check"], ["vet", "./..."], ["build", "./..."],
                     ["-C", "runtimes/xray", "vet", "./..."],
                     ["-C", "runtimes/xray", "test", "-race", "-p=1", "-count=1", "-timeout=10m", "./..."],
                     ["-C", "runtimes/xray", "build", "./..."]):
            self.assertIn(call, recordings[0])
        verify = (ROOT / "scripts/verify.sh").read_text()
        self.assertIn("static_gate; secrets_gate; backend_gate; web_gate", verify)

    def test_inventory_and_test_failures_cannot_pass_gate(self):
        for extra in ({"FAIL_LIST": "1"}, {"INVENTORY": "routeweaver/only"}, {"FAIL_TEST": "1"}):
            with tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                env = {**self.fixture(directory), **extra}
                result = self.run_gate(directory, "backend_backup", env)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("PASS:", result.stdout)
                if "FAIL_TEST" not in extra:
                    calls = Path(env["CALL_LOG"]).read_text()
                    self.assertNotIn('"test"', calls)


if __name__ == "__main__":
    unittest.main()

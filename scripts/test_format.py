"""Offline shell plumbing only: fake formatter output is not Go-format evidence."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FILES = ["cmd/tool/main.go", "internal/bad name.go", "runtimes/example/runtime.go",
         "scripts/check-architecture/main.go"]
REPAIR = "diff internal/bad name.go.orig internal/bad name.go\n--- before\n+++ after\n@@ -1 +1 @@\n-before\n+after\n"


class FormatShellContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="format shell contract ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        for name in ("format.sh", "go.sh"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts" / name)
        for name in [*FILES, "bin/ignored.go", "docs/ignored.go"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture, not Go source\n")
        toolchain = self.root / "fixture toolchain"
        (toolchain / "bin").mkdir(parents=True)
        compiler = toolchain / "bin/go"
        compiler.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
with open(os.environ['GO_CALLS'], 'a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:] != ['env', 'GOROOT']:
    sys.exit(79)
print(os.environ['FIXTURE_GOROOT'])
''')
        compiler.chmod(0o755)
        formatter = toolchain / "bin/gofmt"
        formatter.write_text(f"#!{sys.executable}\n" + '''import json, os, sys
args = sys.argv[1:]
with open(os.environ['FORMAT_CALLS'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
mode = os.environ['FORMAT_MODE']
if args[0] == '-l':
    if mode == 'list-failure':
        print('synthetic list failure', file=sys.stderr)
        sys.exit(21)
    if mode != 'clean':
        print('internal/bad name.go')
        print('cmd/tool/main.go')
elif args[0] == '-d':
    if mode == 'diff-failure':
        print('synthetic diff failure', file=sys.stderr)
        sys.exit(23)
    print(os.environ['REPAIR_TEXT'], end='')
elif args[0] != '-w':
    sys.exit(80)
''')
        formatter.chmod(0o755)
        self.env = {**os.environ, "ROUTEWEAVER_GO": str(compiler),
                    "FIXTURE_GOROOT": str(toolchain), "FORMAT_MODE": "dirty",
                    "GO_CALLS": str(self.root / "go-calls.jsonl"),
                    "FORMAT_CALLS": str(self.root / "format-calls.jsonl"),
                    "REPAIR_TEXT": REPAIR,
                    "GOCACHE": str(self.root / "cache/go"),
                    "GOMODCACHE": str(self.root / "cache/mod"),
                    "GOPATH": str(self.root / "cache/path")}

    def run_format(self, *args):
        return subprocess.run(["bash", "scripts/format.sh", *args], cwd=self.root,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def calls(self, name="FORMAT_CALLS"):
        path = Path(self.env[name])
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_inventory(self, calls, flags):
        self.assertEqual([call[0] for call in calls], flags)
        for call in calls:
            self.assertCountEqual(call[1:], FILES)
        self.assertEqual(self.calls("GO_CALLS"), [["env", "GOROOT"]])

    def test_dirty_check_prints_repair_diff_and_fails_without_writing(self):
        before = {name: (self.root / name).read_bytes() for name in FILES}
        result = self.run_format("--check")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("Go formatting required", result.stderr)
        self.assertIn("internal/bad name.go\ncmd/tool/main.go", result.stderr)
        self.assertIn(REPAIR, result.stderr)
        self.assert_inventory(self.calls(), ["-l", "-d"])
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in FILES})

    def test_default_mode_has_the_same_dirty_check_contract(self):
        result = self.run_format()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(REPAIR, result.stderr)
        self.assert_inventory(self.calls(), ["-l", "-d"])

    def test_clean_check_is_silent_and_does_not_request_a_diff(self):
        self.env["FORMAT_MODE"] = "clean"
        result = self.run_format("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")
        self.assert_inventory(self.calls(), ["-l"])

    def test_write_preserves_the_direct_whole_inventory_command(self):
        result = self.run_format("--write")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")
        self.assert_inventory(self.calls(), ["-w"])

    def test_missing_toolchain_fails_before_any_formatter_command(self):
        self.env["ROUTEWEAVER_GO"] = str(self.root / "missing-compiler")
        result = self.run_format("--check")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("No Go compiler found", result.stderr)
        self.assertNotIn("Go formatting required", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.calls("GO_CALLS"), [])

    def test_listing_failure_remains_a_failure_without_requesting_a_diff(self):
        self.env["FORMAT_MODE"] = "list-failure"
        result = self.run_format("--check")
        self.assertEqual(result.returncode, 21, result.stderr)
        self.assertIn("synthetic list failure", result.stderr)
        self.assertNotIn("Go formatting required", result.stderr)
        self.assert_inventory(self.calls(), ["-l"])

    def test_diff_failure_does_not_turn_a_dirty_check_into_success(self):
        self.env["FORMAT_MODE"] = "diff-failure"
        result = self.run_format("--check")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertIn("synthetic diff failure", result.stderr)
        self.assertIn("Go formatting required", result.stderr)
        self.assert_inventory(self.calls(), ["-l", "-d"])

    def test_invalid_mode_keeps_usage_exit_without_formatting(self):
        result = self.run_format("--invalid")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("Usage: scripts/format.sh", result.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()

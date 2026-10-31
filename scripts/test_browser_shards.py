"""Exercise the public verification CLI without starting a browser or server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BrowserShardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        npm = self.directory / "npm"
        npm.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_NPM_ARGS"\nexit "${TEST_NPM_EXIT:-0}"\n')
        npm.chmod(0o755)
        self.args = self.directory / "args"

    def run_gate(self, shard=None, mode="browser", npm_exit=0):
        env = {key: value for key, value in os.environ.items() if key != "ROUTEWEAVER_BROWSER_SHARD"}
        env.update(PATH=f"{self.directory}:{env['PATH']}", TEST_NPM_ARGS=str(self.args), TEST_NPM_EXIT=str(npm_exit))
        if shard is not None:
            env["ROUTEWEAVER_BROWSER_SHARD"] = shard
        return subprocess.run(["bash", str(ROOT / "scripts/verify.sh"), mode], env=env, text=True, capture_output=True)

    def test_default_runs_unsharded_browser_gate(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.args.read_text().splitlines(), ["--prefix", "web", "run", "test:browser"])
        self.assertIn("PASS: browser verification", result.stdout)

    def test_each_ci_shard_is_explicit_and_never_claims_the_whole_gate(self):
        for index in range(1, 5):
            shard = f"{index}/4"
            with self.subTest(shard=shard):
                result = self.run_gate(shard)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.args.read_text().splitlines(), ["--prefix", "web", "run", "test:browser", "--", f"--shard={shard}"])
                self.assertIn(f"PASS: browser shard {shard} only", result.stdout)
                self.assertNotIn("PASS: browser verification", result.stdout)

    def test_invalid_shards_fail_before_starting_a_browser(self):
        for shard in ("0/4", "5/4", "1/0", "1/04", "all", "1/4 --grep smoke", "1000/1000"):
            with self.subTest(shard=shard):
                self.args.unlink(missing_ok=True)
                result = self.run_gate(shard)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(self.args.exists())
                self.assertNotIn("PASS:", result.stdout)

    def test_full_verification_rejects_partial_shards(self):
        result = self.run_gate("1/4", mode="full")
        self.assertEqual(result.returncode, 2)
        self.assertIn("Full verification cannot select a partial browser shard", result.stderr)
        self.assertFalse(self.args.exists())

    def test_browser_failure_still_fails_the_shard(self):
        result = self.run_gate("2/4", npm_exit=23)
        self.assertEqual(result.returncode, 23)
        self.assertNotIn("PASS:", result.stdout)


if __name__ == "__main__":
    unittest.main()

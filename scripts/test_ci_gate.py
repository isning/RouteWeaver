"""Required status checks must not turn a cancelled, skipped or absent gate green."""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest

spec = importlib.util.spec_from_file_location("ci_gate", Path(__file__).with_name("ci_gate.py"))
ci_gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci_gate)


class CIGateTests(unittest.TestCase):
    def successful(self):
        return {name: {"result": "success"} for name in ci_gate.REQUIRED_JOBS}

    def test_exact_successful_job_set_passes(self):
        ci_gate.verify_results(self.successful())

    def test_failed_cancelled_skipped_and_missing_results_fail(self):
        for state in ("failure", "cancelled", "skipped", "neutral", None):
            with self.subTest(state=state):
                results = self.successful()
                results["browser"]["result"] = state
                with self.assertRaises(ValueError):
                    ci_gate.verify_results(results)
        for results in ({}, None, [], {**self.successful(), "unknown": {"result": "success"}}):
            with self.assertRaises(ValueError):
                ci_gate.verify_results(results)
        for name in ci_gate.REQUIRED_JOBS:
            results = self.successful()
            del results[name]
            with self.assertRaises(ValueError):
                ci_gate.verify_results(results)

    def test_cli_without_results_fails(self):
        env = {key: value for key, value in os.environ.items() if key != "ROUTEWEAVER_CI_RESULTS"}
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("ci_gate.py"))], env=env, capture_output=True)
        self.assertEqual(result.returncode, 1)

    def test_workflow_declares_and_aggregates_every_required_gate(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/ci.yml").read_text()
        jobs = set(re.findall(r"^  ([a-z]+):$", workflow, re.M)) - {"push", "pull_request", "workflow_dispatch", "verify"}
        self.assertEqual(jobs, ci_gate.REQUIRED_JOBS)
        needs = re.search(r"^    needs: \[([^\]]+)\]$", workflow, re.M)
        self.assertIsNotNone(needs)
        self.assertEqual({name.strip() for name in needs.group(1).split(",")}, ci_gate.REQUIRED_JOBS)
        aggregate = workflow.split("\n  verify:\n", 1)[1]
        self.assertIn("if: ${{ always() }}", aggregate)
        self.assertIn("python3 scripts/ci_gate.py", aggregate)
        self.assertNotIn("continue-on-error", workflow)
        for reference in re.findall(r"uses: ([^\s]+)", workflow):
            if not reference.startswith("./"):
                self.assertRegex(reference, r"^[^@]+@[0-9a-f]{40}$")

    def test_browser_ci_uses_installed_chrome_without_weakening_sandbox(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        browser = workflow.split("\n  browser:\n", 1)[1].split("\n  native:\n", 1)[0]
        self.assertIn("ROUTEWEAVER_CHROMIUM: /opt/google/chrome/chrome", browser)
        self.assertIn("dpkg-query -S", browser)
        self.assertIn("dpkg-query --control-show google-chrome-stable md5sums", browser)
        self.assertIn("md5sum --check --strict", browser)
        self.assertIn("browser-environment.json", browser)
        self.assertIn("chromiumSandbox: true", browser)
        self.assertIn("fail-fast: false", browser)
        self.assertIn("shard: [1, 2, 3, 4]", browser)
        self.assertIn("ROUTEWEAVER_BROWSER_SHARD: ${{ matrix.shard }}/4", browser)
        self.assertIn("name: browser-diagnostics-${{ matrix.shard }}-of-4", browser)
        self.assertIn("playwrightShard: process.env.ROUTEWEAVER_BROWSER_SHARD", browser)
        self.assertNotIn("playwright install --with-deps chromium", browser)
        for forbidden in ("--no-sandbox", "chromiumSandbox: false", "sysctl", "apparmor_parser", "continue-on-error"):
            self.assertNotIn(forbidden, browser)
        config = (root / "web/playwright.config.ts").read_text()
        self.assertIn("chromiumSandbox: true", config)
        self.assertIn("executablePath: process.env.ROUTEWEAVER_CHROMIUM", config)
        native = (root / "web/tests/native-browser.ts").read_text()
        self.assertIn("globalThis.process.env.ROUTEWEAVER_CHROMIUM", native)
        self.assertNotIn("--no-sandbox", native)

    def test_native_ci_keeps_compatibility_and_stock_caches_separate(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        native = workflow.split("\n  native:\n", 1)[1].split("\n  package:\n", 1)[0]
        self.assertIn("ROUTEWEAVER_CORE_BIN_DIR: ${{ github.workspace }}/bin/cores", native)
        self.assertIn("ROUTEWEAVER_STOCK_CORE_BIN_DIR: ${{ github.workspace }}/bin/stock-cores", native)
        self.assertIn("python3 scripts/bootstrap-cores.py 2>&1 | tee bin/verification/native-bootstrap.log", native)
        self.assertIn("set -o pipefail", native)
        self.assertIn("- run: scripts/verify.sh native", native)
        self.assertIn("- run: scripts/verify.sh runtime", native)

    def test_native_bootstrap_diagnostics_preserve_real_exit_status(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/ci.yml").read_text()
        native = workflow.split("\n  native:\n", 1)[1].split("\n  package:\n", 1)[0]
        body = re.search(r"      - name: Verify pinned native assets and retain bootstrap diagnostics\n        run: \|\n((?:          .*\n)+)", native)
        self.assertIsNotNone(body, "native bootstrap must execute and retain diagnostics")
        command = textwrap.dedent(body.group(1))
        for status in (0, 7):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                work = Path(tmp)
                (work / "scripts").mkdir()
                (work / "scripts/bootstrap-cores.py").write_text(
                    f'import sys; print("bootstrap fixture evidence"); sys.exit({status})\n')
                result = subprocess.run(["bash", "-e", "-c", command], cwd=work,
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn("bootstrap fixture evidence", (work / "bin/verification/native-bootstrap.log").read_text())


if __name__ == "__main__":
    unittest.main()

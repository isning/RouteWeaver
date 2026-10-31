"""Required status checks must not turn a cancelled, skipped or absent gate green."""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()

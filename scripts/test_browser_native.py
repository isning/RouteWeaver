import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("browser_native_result", ROOT / "scripts/check-browser-native-result.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BrowserNativeGateTests(unittest.TestCase):
    def good(self):
        return {"suites": [{"specs": [{"title": module.REQUIRED, "tests": [{"status": "expected", "results": [{"status": "passed"}]}]}]}]}
    def test_exact_named_pass(self):
        module.verify(self.good())
    def test_missing_skipped_flaky_and_duplicate_fail(self):
        for state in ["skipped", "failed", "timedOut", "interrupted"]:
            report = self.good()
            report["suites"][0]["specs"][0]["tests"][0]["results"][0]["status"] = state
            with self.assertRaises(ValueError): module.verify(report)
        for kind in ("missing", "wrong-name", "duplicate", "retry", "error", "flaky"):
            report = self.good()
            s = report["suites"][0]["specs"]
            if kind == "missing": s.clear()
            if kind == "wrong-name": s[0]["title"] = "other"
            if kind == "duplicate": s.append(copy.deepcopy(s[0]))
            if kind == "retry": s[0]["tests"][0]["results"].append({"status": "passed"})
            if kind == "error": report["errors"] = [{"message": "failure"}]
            if kind == "flaky": s[0]["tests"][0]["status"] = "flaky"
            with self.assertRaises(ValueError): module.verify(report)
    def test_explicit_separate_job_and_gate(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        block = workflow.split("\n  browser_native:\n", 1)[1].split("\n  native:\n", 1)[0]
        self.assertIn("timeout-minutes: 20", block)
        self.assertIn("scripts/verify.sh browser_native", block)
        self.assertIn("dpkg-query --control-show google-chrome-stable md5sums", block)
        self.assertIn("chromiumSandbox: true", block)
        self.assertNotIn("continue-on-error", block)
        gate = (ROOT / "scripts/verify.sh").read_text()
        self.assertIn("api_gate; browser_gate; browser_native_gate", gate)
        helper = (ROOT / "internal/httpapi/browser_native_bridge_test.go").read_text()
        self.assertTrue(helper.startswith("//go:build browser_native_acceptance"))
        self.assertNotIn("t.Skip", helper)
        self.assertIn('"explicit browser-native bridge opt-in required"', helper)
        config = (ROOT / "web/playwright.native.config.ts").read_text()
        self.assertIn("*.native.spec.ts", config)
        self.assertNotIn("test.skip", config)
        self.assertIn("/web/test-results-native/", (ROOT / ".gitignore").read_text())
        script = (ROOT / "scripts/browser-native.sh").read_text()
        self.assertEqual(script.count("git status --porcelain --untracked-files=all"), 2)
        self.assertIn("Source changed during browser/native verification", script)

if __name__ == "__main__": unittest.main()

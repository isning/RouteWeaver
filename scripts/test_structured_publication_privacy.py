"""Probe-driver contracts only: these tests do not claim browser acceptance."""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("privacy_probe", ROOT / "scripts/probe_structured_publication_privacy.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ArtifactScanTests(unittest.TestCase):
    def test_compressed_html_report_and_aria_snapshot_are_scanned(self):
        secret = b"synthetic-test-only-bearer"
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as out:
            out.writestr("report.json", json.dumps({"value": secret.decode()}))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_bytes(b'<template id="playwrightReportBase64">data:application/zip;base64,' + base64.b64encode(archive.getvalue()) + b"</template>")
            result = probe.scan_artifacts(root, secret)
            self.assertTrue(result["bearerFound"])
            self.assertFalse(result["automaticAriaBearerFound"])
            self.assertEqual(result["embeddedReportEntries"], 1)
            (root / "error-context.md").write_bytes(b"textbox: " + secret)
            self.assertTrue(probe.scan_artifacts(root, secret)["automaticAriaBearerFound"])

    def test_clean_diagnostics_and_untrusted_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stdout.log").write_text("Expected assertion failure and useful stack")
            self.assertFalse(probe.scan_artifacts(root, b"test-bearer")["bearerFound"])
            (root / "outside").symlink_to(__file__)
            with self.assertRaises(ValueError):
                probe.scan_artifacts(root, b"test-bearer")
            (root / "outside").unlink()
            (root / "broken.zip").write_bytes(b"PK\x03\x04invalid")
            with self.assertRaises(zipfile.BadZipFile):
                probe.scan_artifacts(root, b"test-bearer")


class ExpectedFailureTests(unittest.TestCase):
    def report(self, timed_out=False):
        error = {"message": "Test timeout of 12000ms exceeded." if timed_out else probe.MARKER,
                 "stack": "Error\n  at disposable.privacy-probe.ts:350:7"}
        # Playwright 1.64.1 JSONReporter keeps the raw error separately. Its
        # formatted errors entries contain message/location, never a stack key.
        formatted = {"message": error["message"] + "\n" + error["stack"],
                     "location": {"file": "disposable.privacy-probe.ts", "line": 350, "column": 7}}
        return {"errors": [], "stats": {"expected": 0, "unexpected": 1, "skipped": 0, "flaky": 0},
                "suites": [{"specs": [{"title": "structured editor at 1440", "tests": [{
                    "expectedStatus": "passed", "status": "unexpected", "results": [{
                        "status": "timedOut" if timed_out else "failed", "retry": 0,
                        "error": error, "errors": [formatted]}]}]}]}]}

    def test_only_one_deliberate_failure_with_useful_diagnostics_qualifies(self):
        for timed_out in (False, True):
            proof = probe.expected_failure(self.report(timed_out), timed_out)
            self.assertTrue(proof["expectedErrorIdentified"])
            self.assertTrue(proof["errorStackPreserved"])
        for kind in ("wrong-error", "wrong-primary-error", "missing-stack", "retry", "skip", "pass", "duplicate", "cleanup-error", "runner-error"):
            data = self.report()
            test = data["suites"][0]["specs"][0]["tests"][0]
            result = test["results"][0]
            if kind == "wrong-error": result["errors"][0]["message"] = "unrelated failure"
            if kind == "wrong-primary-error": result["error"]["message"] = "unrelated failure"
            if kind == "missing-stack": result["error"]["stack"] = ""
            if kind == "retry": result["retry"] = 1
            if kind == "skip": result["status"] = "skipped"
            if kind == "pass": result["status"] = "passed"
            if kind == "duplicate": test["results"].append(copy.deepcopy(result))
            if kind == "cleanup-error": result["errors"].append({"message": "teardown timed out"})
            if kind == "runner-error": data["errors"].append({"message": "worker exited"})
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                probe.expected_failure(data, False)

    def test_disposable_copies_keep_the_real_recovery_and_original_untouched(self):
        original = probe.JOURNEY.read_text()
        fixed = probe.probe_source(original, "fixed-assertion")
        control = probe.probe_source(original, "control-assertion")
        timeout = probe.probe_source(original, "fixed-timeout")
        self.assertEqual(original, probe.JOURNEY.read_text())
        self.assertIn("finally { await page.close(); }", fixed)
        self.assertIn("finally { await page.close(); }", timeout)
        self.assertNotIn("finally { await page.close(); }", control)
        for text in (fixed, control, timeout):
            self.assertIn("for (const width of [1440])", text)
            self.assertLess(text.index('await capture("access-recovered", access)'), text.index("privacyProbeCheckpoint"))
            self.assertIn('await route.abort("failed")', text)
            self.assertIn('"The real access read succeeded before its response is dropped"', text)
            self.assertNotIn("test.fail(", text)
            self.assertNotIn("test.skip(", text)
        self.assertIn("Date.now() - privacyProbeStartedAt + 1000", timeout)
        with self.assertRaises(ValueError):
            probe.probe_source(original.replace('await capture("access-recovered", access);', ""), "fixed-assertion")

    def test_receipt_requires_sensitive_checkpoint_control_and_clean_fixed_artifacts(self):
        checkpoint = {"url": "http://127.0.0.1:12345/feed/" + "S" * 43,
                      "maskedPixels": True, "recovered": True,
                      "accessReadAttempts": 2, "interruptedAccessStatus": 200}
        scan = {"bearerFound": False, "automaticAriaBearerFound": False,
                "filesScanned": 5, "embeddedReportEntries": 2}
        self.assertTrue(probe.case_receipt("fixed-assertion", self.report(), checkpoint, scan, 1)["passed"])
        control = {**scan, "bearerFound": True, "automaticAriaBearerFound": True}
        self.assertTrue(probe.case_receipt("control-assertion", self.report(), checkpoint, control, 1)["passed"])
        for kind in ("missing-recovery", "mask-failed", "wrong-read", "non-loopback", "wrong-exit", "fixed-leak", "no-html-scan", "insensitive-control"):
            cp, artifact, code, case = copy.deepcopy(checkpoint), copy.deepcopy(scan), 1, "fixed-assertion"
            if kind == "missing-recovery": cp["recovered"] = False
            if kind == "mask-failed": cp["maskedPixels"] = False
            if kind == "wrong-read": cp["interruptedAccessStatus"] = 503
            if kind == "non-loopback": cp["url"] = cp["url"].replace("127.0.0.1", "example.com")
            if kind == "wrong-exit": code = 0
            if kind == "fixed-leak": artifact["bearerFound"] = True
            if kind == "no-html-scan": artifact["embeddedReportEntries"] = 0
            if kind == "insensitive-control": case = "control-assertion"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                probe.case_receipt(case, self.report(), cp, artifact, code)

    def test_config_is_bounded_and_uses_supported_runner_settings(self):
        config = probe.probe_config("example.privacy-probe.ts", Path("/tmp/private-probe/raw"))
        self.assertIn('import base from "./playwright.config"', config)
        self.assertIn('testMatch: "example.privacy-probe.ts"', config)
        self.assertIn('webServer: undefined', config)
        self.assertIn('outputDir: "/tmp/private-probe/raw/results"', config)
        self.assertIn('outputFolder: "/tmp/private-probe/raw/html"', config)
        self.assertIn('retries: 0', config)
        self.assertNotIn("PLAYWRIGHT_NO_COPY_PROMPT", config)

    def test_public_driver_preflight_failure_publishes_only_sanitized_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            driver = root / "scripts/probe_structured_publication_privacy.py"
            shutil.copy(ROOT / "scripts" / driver.name, driver)
            secret = "synthetic-comparison-value-must-not-be-echoed"
            result = subprocess.run([sys.executable, str(driver)], capture_output=True, text=True,
                                    env={**os.environ, "PLAYWRIGHT_NO_COPY_PROMPT": secret})
            self.assertEqual(result.returncode, 1)
            receipt_text = (root / "bin/verification/structured-publication-privacy.json").read_text()
            self.assertNotIn(secret, result.stdout + result.stderr + receipt_text)
            self.assertNotIn("Traceback", result.stdout + result.stderr)
            receipt = json.loads(receipt_text)
            self.assertFalse(receipt["passed"])
            self.assertFalse(receipt["runnerAttempted"])
            self.assertTrue(receipt["privateFilesRemoved"])
            self.assertEqual(receipt["failedStage"], "preflight")

    def test_failure_details_are_allowlisted_scalars_never_raw_diagnostics(self):
        secret = "synthetic-bearer-must-not-escape"
        details = {"step": "checkpoint-validate", "check": "checkpoint-mask", "runnerExitCode": 1,
                   "checkpointPresent": True, "reportPresent": True, "checkpointMasked": False,
                   "checkpointRecovered": True, "cleanupCompleted": True,
                   "rawError": secret, "url": secret, "path": secret, "message": secret}
        safe = probe.safe_failure_details(details)
        self.assertEqual(safe["check"], "checkpoint-mask")
        self.assertFalse(safe["checkpointMasked"])
        self.assertNotIn(secret, json.dumps(safe))
        for key in tuple(safe):
            unsafe = {**details, key: secret}
            self.assertNotIn(secret, json.dumps(probe.safe_failure_details(unsafe)))
        with self.assertRaises(probe.ProbeContractError) as failure:
            probe.require(False, secret)
        self.assertEqual(failure.exception.check, "contract")
        self.assertNotIn(secret, str(failure.exception))

    def test_real_reporter_failures_identify_subcheck_without_error_text(self):
        for kind, expected in (("stack", "failure-stack"), ("identity", "failure-identity")):
            data = self.report()
            raw = data["suites"][0]["specs"][0]["tests"][0]["results"][0]["error"]
            raw[kind if kind == "stack" else "message"] = "" if kind == "stack" else "sensitive-error-value"
            with self.assertRaises(probe.ProbeContractError) as failure:
                probe.expected_failure(data, False)
            self.assertEqual(failure.exception.check, expected)
            self.assertNotIn("sensitive-error-value", str(failure.exception))


class ProcessCleanupTests(unittest.TestCase):
    def test_group_is_drained_when_leader_exited_or_exits_on_term(self):
        # Real OS subprocess boundary, not a simulated browser/runtime result.
        for leader_exits in (True, False):
            with self.subTest(leader_exits=leader_exits), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory) / "child.pid"
                program = '''import os, signal, sys, time
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    open(sys.argv[1], 'w').write(str(os.getpid()))
    time.sleep(60)
else:
    if sys.argv[2] == 'exit': sys.exit(0)
    time.sleep(60)
'''
                leader = subprocess.Popen([sys.executable, "-c", program, str(marker), "exit" if leader_exits else "stay"],
                                          start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    deadline = time.monotonic() + 3
                    while not marker.exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue(marker.exists())
                    if leader_exits:
                        self.assertEqual(leader.wait(timeout=3), 0)
                    probe.drain_process_group(leader, grace=0.1, kill_grace=2)
                    self.assertFalse(probe.process_group_running(leader.pid))
                    self.assertIsNotNone(leader.poll())
                finally:
                    try: os.killpg(leader.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    leader.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()

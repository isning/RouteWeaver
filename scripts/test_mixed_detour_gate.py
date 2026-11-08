"""Synthetic event-gate tests, not native traffic or accounting evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "routeweaver/runtimes/xray"
CUTOFF = "TestNativeTwoDetoursPreserveSingleAdmissionAccountingAndCutoff"
DENIAL = "TestNativeTwoDetoursDoNotBypassDestinationOrAdmissionDenial"
REQUIRED = {
    "TestManagedAcceptsOnlyScopedAcyclicOutboundDetours",
    "TestManagedRejectsAmbiguousOrUnsupportedDetourGraphs",
    "TestManagedDetourSocketOptionsFailClosed",
    "TestNativeTwoDetoursRevokeInterruptsRateQueuedPayload",
    CUTOFF, DENIAL,
    *(CUTOFF + "/" + name for name in ("revoke", "lease_expiry", "byte_budget")),
    *(DENIAL + "/" + name for name in ("private_IP", "private_DNS", "packet_destination", "admission")),
}


class MixedDetourGateTests(unittest.TestCase):
    def check(self, missing=None, skipped=False, package=PACKAGE):
        workflow = (ROOT / ".github/workflows/mixed-path-focus.yml").read_text()
        body = workflow.split("python3 - <<'PY'\n", 1)[1]
        checker = textwrap.dedent(body.rsplit("          PY", 1)[0])
        self.assertIn("test -json -race -p=1 -count=1", workflow)
        events = [{"Package": package, "Test": name, "Action": "pass"}
                  for name in REQUIRED if name != missing]
        if skipped:
            events.append({"Package": PACKAGE, "Test": "unexpected-child", "Action": "skip"})
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "bin/verification/managed-detour-focused.jsonl"
            report.parent.mkdir(parents=True)
            report.write_text("\n".join(map(json.dumps, events)) + "\n")
            return subprocess.run([sys.executable, "-c", checker], cwd=tmp,
                                  env=dict(os.environ), capture_output=True, text=True, timeout=3)

    def test_all_exact_required_events_pass(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("all eight sustained-flow/denial scenarios", result.stdout)

    def test_each_missing_required_parent_or_scenario_fails(self):
        for name in REQUIRED:
            with self.subTest(name=name):
                result = self.check(missing=name)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed detour gate incomplete", result.stderr)

    def test_successful_parents_do_not_hide_a_skipped_child(self):
        result = self.check(skipped=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected-child", result.stderr)

    def test_other_package_cannot_supply_required_results(self):
        result = self.check(package="routeweaver/internal/render")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Managed detour gate incomplete", result.stderr)


if __name__ == "__main__":
    unittest.main()

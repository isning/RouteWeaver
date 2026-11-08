"""Offline shell-gate contract; synthetic events are not native runtime evidence."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = {
    "agent": "TestManagedNativeBrokerEOFStopsActivePayloadAndPersistsFinalJournal",
    "integration": "TestManagedSharedVLESSIngressKeepsPrincipalPathsSeparate",
    "httpapi": "TestNativePublishedManagedPrincipalEndToEnd",
}
CONTINUOUS = "TestNativeContinuousManagedServicePreservesPayloadAndRevocation"
DELAYED_HEARTBEAT = "TestNativeDelayedHeartbeatAcknowledgementPreservesExistingFlow"
RATE = "TestManagedNativeEntryRateSharesDuplexAcrossConnectionsAndIsolatesEntries"
PROVIDER = "TestNativeManagedProviderSuspensionAndRecovery"
MIXED = "TestManagedMixedConnectorChainLoopback"


class ManagedGateTests(unittest.TestCase):
    def run_gate(self, action="pass", omit=False, fail_go=False, provider_action="pass", provider_omit=False, rate_action="pass", rate_omit=False, heartbeat_action="pass", heartbeat_omit=False, mixed_action="pass", mixed_omit=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/managed-runtime.sh", root / "scripts/managed-runtime.sh")
            events = [{"Package": "routeweaver/internal/" + pkg, "Test": name, "Action": "pass"}
                      for pkg, name in REQUIRED.items()]
            if not omit:
                events.append({"Package": "routeweaver/internal/httpapi", "Test": CONTINUOUS, "Action": action})
            if not heartbeat_omit:
                events.append({"Package": "routeweaver/internal/httpapi", "Test": DELAYED_HEARTBEAT, "Action": heartbeat_action})
            if not provider_omit:
                events.append({"Package": "routeweaver/internal/httpapi", "Test": PROVIDER, "Action": provider_action})
            if not mixed_omit:
                events.append({"Package": "routeweaver/internal/integration", "Test": MIXED, "Action": mixed_action})
            if not rate_omit:
                events.append({"Package": "routeweaver/internal/agent", "Test": RATE, "Action": rate_action})
            (root / "events").write_text("\n".join(map(json.dumps, events)) + "\n")
            go = root / "scripts/go.sh"
            go.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args=sys.argv[1:]
with open("calls", "a") as out:
    out.write(json.dumps({"args": args, "targets": os.environ["ROUTEWEAVER_NATIVE_PROCESS_TESTS"], "managed": os.environ["ROUTEWEAVER_MANAGED_XRAY_BIN"], "stock": os.environ["ROUTEWEAVER_STOCK_CORE_BIN_DIR"]}) + "\\n")
if "test" in args:
    print(Path("events").read_text(), end="")
    sys.exit(int(os.environ.get("FAKE_GO_FAILURE", "0")))
''')
            go.chmod(0o755)
            env = dict(os.environ, ROUTEWEAVER_STOCK_CORE_BIN_DIR="", ROUTEWEAVER_NATIVE_PROCESS_TESTS="xray,sing-box", FAKE_GO_FAILURE="1" if fail_go else "0")
            result = subprocess.run(["bash", "scripts/managed-runtime.sh"], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=5)
            calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
            self.assertEqual(len(calls), 2)
            self.assertIn("build", calls[0]["args"])
            args = calls[1]["args"]
            self.assertIn("-race", args)
            self.assertIn(CONTINUOUS, args[args.index("-run") + 1])
            self.assertIn(DELAYED_HEARTBEAT, args[args.index("-run") + 1])
            self.assertIn(PROVIDER, args[args.index("-run") + 1])
            self.assertIn(RATE, args[args.index("-run") + 1])
            self.assertIn(MIXED, args[args.index("-run") + 1])
            self.assertIn("./internal/httpapi", args)
            self.assertEqual(calls[1]["targets"], "xray")
            self.assertEqual(calls[1]["managed"], str(root / "bin/routeweaver-xray"))
            self.assertEqual(calls[1]["stock"], str(root / "bin/stock-cores"))
            return result

    def test_all_required_positive_results_pass(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_continuous_missing_skipped_or_failed_never_passes(self):
        for action, omit in (("pass", True), ("skip", False), ("fail", False)):
            with self.subTest(action=action, omit=omit):
                result = self.run_gate(action, omit)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed native gate incomplete", result.stderr)

    def test_go_failure_not_hidden_by_tee_or_positive_events(self):
        self.assertNotEqual(self.run_gate(fail_go=True).returncode, 0)

    def test_delayed_heartbeat_missing_skipped_or_failed_never_passes(self):
        for action, omit in (("pass", True), ("skip", False), ("fail", False)):
            with self.subTest(action=action, omit=omit):
                result = self.run_gate(heartbeat_action=action, heartbeat_omit=omit)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed native gate incomplete", result.stderr)

    def test_provider_missing_skipped_or_failed_never_passes(self):
        for action, omit in (("pass", True), ("skip", False), ("fail", False)):
            with self.subTest(action=action, omit=omit):
                result = self.run_gate(provider_action=action, provider_omit=omit)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed native gate incomplete", result.stderr)

    def test_entry_rate_missing_skipped_or_failed_never_passes(self):
        for action, omit in (("pass", True), ("skip", False), ("fail", False)):
            with self.subTest(action=action, omit=omit):
                result = self.run_gate(rate_action=action, rate_omit=omit)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed native gate incomplete", result.stderr)

    def test_mixed_chain_missing_skipped_or_failed_never_passes(self):
        for action, omit in (("pass", True), ("skip", False), ("fail", False)):
            with self.subTest(action=action, omit=omit):
                result = self.run_gate(mixed_action=action, mixed_omit=omit)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Managed native gate incomplete", result.stderr)

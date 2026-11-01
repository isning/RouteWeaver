"""Offline event-checker tests; no native process is launched or claimed."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLIENT = "TestNativeInvitedUserDownloadedClientTraffic"
DNS_CLIENT = "TestNativeDownloadedClientConfiguredDNS"
SERVER = [
    "TestNativeSupervisorLifecycleAndRestart/xray",
    "TestNativeSupervisorLifecycleAndRestart/sing-box",
    "TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease",
    "TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease/failed-new=false",
    "TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease/failed-new=true",
    "TestNativeStockSingBoxUpgradeKeepsExactRuntimeAndLease",
    "TestNativeStockSingBoxUpgradeKeepsExactRuntimeAndLease/failed-new=false",
    "TestNativeStockSingBoxUpgradeKeepsExactRuntimeAndLease/failed-new=true",
    "TestNativeXrayTwoHopLoopbackRoundtrip",
]
INTEGRATION = [
    "TestNativeStockXraySecurityDefaults", "TestNativeEndpointProtocolsLoopback",
    "TestRenderedTwoHopRouteHasNoDirectFallback",
    "TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate",
]


class ClientNativeGateTests(unittest.TestCase):
    def check(self, client_action="pass", omit=False, selected="mihomo,sing-box", dns_action="pass", omit_dns=False):
        shell = (ROOT / "scripts/native-cores.sh").read_text()
        checker = shell.split('python3 - "$REPORT" <<\'PY\'\n', 1)[1].split('\nPY\n', 1)[0]
        events = []
        for pkg, names in [("agent", SERVER), ("integration", INTEGRATION),
                           ("httpapi", ["TestNativeFleetConfigureStopStartAndRollback"])]:
            events.extend({"Package": "routeweaver/internal/" + pkg, "Test": name,
                           "Action": "pass"} for name in names)
        events.append({"Package": "routeweaver/internal/httpapi", "Test": CLIENT + "/mihomo", "Action": "pass"})
        if not omit:
            events.append({"Package": "routeweaver/internal/httpapi", "Test": CLIENT + "/sing-box", "Action": client_action})
        events.append({"Package": "routeweaver/internal/httpapi", "Test": DNS_CLIENT + "/mihomo", "Action": "pass"})
        if not omit_dns:
            events.append({"Package": "routeweaver/internal/httpapi", "Test": DNS_CLIENT + "/sing-box", "Action": dns_action if "sing-box" in selected.split(",") else "skip"})
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "events.jsonl"
            report.write_text("\n".join(map(json.dumps, events)))
            return subprocess.run(["python3", "-c", checker, str(report)],
                env=dict(os.environ, ROUTEWEAVER_NATIVE_STAGE="runtime",
                         ROUTEWEAVER_NATIVE_PROCESS_TESTS="xray,sing-box",
                         ROUTEWEAVER_CLIENT_PROCESS_TESTS=selected),
                capture_output=True, text=True, timeout=3)

    def test_both_clients_required(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        for action, omit in [("skip", False), ("fail", False), ("pass", True)]:
            with self.subTest(action=action, omit=omit):
                self.assertNotEqual(self.check(action, omit).returncode, 0)

    def test_selected_dns_cases_missing_skipped_or_failed_reject(self):
        for action, omit in [("skip", False), ("fail", False), ("pass", True)]:
            with self.subTest(action=action, omit=omit):
                self.assertNotEqual(self.check(dns_action=action, omit_dns=omit).returncode, 0)

    def test_invalid_selection_rejected(self):
        self.assertNotEqual(self.check(selected="unknown").returncode, 0)

    def test_explicit_partial_selection_does_not_claim_other_client(self):
        result = self.check(client_action="skip", selected="mihomo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Client process selection passed: mihomo. Not requested: sing-box.", result.stdout)


if __name__ == "__main__":
    unittest.main()

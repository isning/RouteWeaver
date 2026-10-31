"""Offline public bootstrap/harness contracts; never execute native core bytes."""
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def zip_bytes(data, name="xray"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(name, data)
    return output.getvalue()


class CoreBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        for name in ("bootstrap-cores.py", "native-cores.sh"):
            shutil.copyfile(ROOT / "scripts" / name, self.root / "scripts" / name)
        self.stock = self.root / "bin/stock-cores"
        self.compatibility = self.root / "bin/cores"
        self.stock.mkdir(parents=True)
        self.compatibility.mkdir(parents=True)
        self.payload = b"synthetic native fixture; never execute\n"
        self.archive = zip_bytes(self.payload)
        self.release = {"id": "xray-26.10.29-linux-amd64", "version": "26.10.29",
                        "platform": "linux-amd64", "url": "https://invalid.example/never-fetch",
                        "archiveFormat": "zip", "executablePath": "xray",
                        "archiveSHA256": digest(self.archive), "executableSHA256": digest(self.payload)}
        self.write_stock([self.release])
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("ROUTEWEAVER_")}
        self.env.update(ROUTEWEAVER_CORE_BIN_DIR=str(self.compatibility),
                        ROUTEWEAVER_STOCK_CORE_BIN_DIR=str(self.stock))
        # Any unexpected network invocation fails locally, without contacting a service.
        fakebin = self.root / "fakebin"
        fakebin.mkdir()
        curl = fakebin / "curl"
        curl.write_text("#!/bin/sh\necho 'unexpected download' >&2\nexit 91\n")
        curl.chmod(0o755)
        self.env["PATH"] = str(fakebin) + os.pathsep + self.env["PATH"]

    def write_stock(self, releases):
        (self.root / "scripts/stock-core-lock.json").write_text(json.dumps({"releases": releases}))

    def cached_archive(self, release=None, data=None):
        release = release or self.release
        path = self.stock / (release["id"] + ".download")
        path.write_bytes(self.archive if data is None else data)
        return path

    def bootstrap(self, kind="stock"):
        args = [] if kind is None else ["--kind", kind]
        return subprocess.run([sys.executable, str(self.root / "scripts/bootstrap-cores.py"), *args],
                              env=self.env, capture_output=True, text=True, timeout=5)

    def good_compatibility(self):
        entries = []
        for name in ("mihomo", "sing-box", "xray"):
            path = self.compatibility / name
            path.write_bytes(self.payload)
            path.chmod(0o755)
            entries.append({"id": name, "version": "fixture", "executableSHA256": digest(self.payload)})
        (self.root / "scripts/core-lock.json").write_text(json.dumps({"cores": entries}))
        go = self.root / "scripts/go.sh"
        go.write_text("#!/bin/sh\necho GO_MUST_NOT_RUN >&2\nexit 93\n")
        go.chmod(0o755)

    def test_harness_missing_requested_stock_fails_before_go(self):
        self.good_compatibility()
        result = subprocess.run(["bash", str(self.root / "scripts/native-cores.sh"), "parsers"],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Required stock executable", result.stderr)
        self.assertNotIn("GO_MUST_NOT_RUN", result.stderr)

    def test_harness_checks_stock_executable_and_archive_before_go(self):
        self.good_compatibility()
        executable = self.stock / self.release["id"]
        archive = self.stock / (self.release["id"] + ".download")
        for state in ("missing-archive", "corrupt-archive", "corrupt-executable", "symlink-executable"):
            with self.subTest(state=state):
                executable.write_bytes(self.payload)
                executable.chmod(0o755)
                archive.write_bytes(self.archive)
                if state == "missing-archive":
                    archive.unlink()
                elif state == "corrupt-archive":
                    archive.write_bytes(b"changed archive")
                elif state == "corrupt-executable":
                    executable.write_bytes(b"changed executable")
                else:
                    executable.unlink()
                    executable.symlink_to(self.compatibility / "xray")
                result = subprocess.run(["bash", str(self.root / "scripts/native-cores.sh"), "parsers"],
                                        env=self.env, capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("stock", result.stderr.lower())
                self.assertNotIn("GO_MUST_NOT_RUN", result.stderr)
                executable.unlink()
                archive.unlink(missing_ok=True)

    def test_harness_requires_positive_stock_parser_and_recovery_results(self):
        self.good_compatibility()
        path = self.stock / self.release["id"]
        path.write_bytes(self.payload)
        path.chmod(0o755)
        self.cached_archive()
        # The pre-existing parser gate passes, but new stock coverage is absent.
        previous = {
            "render": ["TestNativeTrojanConfigurationMatrix", "TestNativeVMessConfigurationMatrix",
                       "TestNativeClientNodesOnlyConsumption", "TestNativeClientFixtures",
                       "TestNativeMultiPrincipalVLESSFixtures", "TestNativeVLESSClientFixtures", "TestNativeServerFixtures"],
            "agent": ["TestNativeCoreInstallerPreparesImmutableOfficialExecutables", "TestNativeInstallDesiredPreservesActiveRuntimeAndLease",
                      "TestNativeInstallDoesNotEraseAcceptedRevocation", "TestNativeInstallDownloadCannotDelayActiveLeaseExpiry",
                      "TestNativePinnedBinariesWhenExplicitlyAvailable"],
            "httpapi": ["TestNativeOwnedRuleFileBundles", "TestNativeTemplateFollowedProfileUpdate", "TestNativeOverridePublishedArtifactsPassPinnedNativeParsers"],
            "integration": ["TestImportedProcessedVLESSPassesBothNativeClients"],
        }
        events = [json.dumps({"Package": "routeweaver/internal/" + package, "Test": test, "Action": "pass"})
                  for package, names in previous.items() for test in names]
        (self.root / "scripts/go.sh").write_text("#!/bin/sh\ncat <<'EVENTS'\n" + "\n".join(events) + "\nEVENTS\n")
        result = subprocess.run(["bash", str(self.root / "scripts/native-cores.sh"), "parsers"],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TestNativeVLESSStockTransportMatrix", result.stderr)
        self.assertIn("TestNativeStockRetiredReceiptsRecoverWithoutDownload", result.stderr)

    def test_xray_runtime_requires_positive_stock_upgrade_result(self):
        self.good_compatibility()
        path = self.stock / self.release["id"]
        path.write_bytes(self.payload)
        path.chmod(0o755)
        self.cached_archive()
        self.env["ROUTEWEAVER_NATIVE_PROCESS_TESTS"] = "xray"
        previous = {
            "agent": ["TestNativeSupervisorLifecycleAndRestart/xray", "TestNativeXrayTwoHopLoopbackRoundtrip"],
            "integration": ["TestNativeEndpointProtocolsLoopback", "TestRenderedTwoHopRouteHasNoDirectFallback",
                            "TestNativeSharedVLESSIngressKeepsPrincipalPathsSeparate"],
            "httpapi": ["TestNativeFleetConfigureStopStartAndRollback"],
        }
        events = [json.dumps({"Package": "routeweaver/internal/" + package, "Test": test, "Action": "pass"})
                  for package, names in previous.items() for test in names]
        (self.root / "scripts/go.sh").write_text("#!/bin/sh\ncat <<'EVENTS'\n" + "\n".join(events) + "\nEVENTS\n")
        result = subprocess.run(["bash", str(self.root / "scripts/native-cores.sh"), "runtime"],
                                env=self.env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TestNativeStockXrayUpgradeKeepsExactRuntimeAndLease", result.stderr)
        self.assertIn("TestNativeStockXraySecurityDefaults", result.stderr)

    def test_default_bootstrap_materializes_all_groups_without_overwriting_compatibility(self):
        compat = []
        for name in ("mihomo", "sing-box", "xray"):
            if name == "mihomo":
                archive = gzip.compress(self.payload)
            elif name == "sing-box":
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w:gz") as tar:
                    member = tarfile.TarInfo("sing-box-fixture-linux-amd64/sing-box")
                    member.size = len(self.payload)
                    tar.addfile(member, io.BytesIO(self.payload))
                archive = output.getvalue()
            else:
                archive = self.archive
            compat.append({"id": name, "version": "fixture", "url": "https://invalid.example/never-fetch",
                           "archiveSHA256": digest(archive), "executableSHA256": digest(self.payload)})
            (self.compatibility / (name + ".download")).write_bytes(archive)
        (self.root / "scripts/core-lock.json").write_text(json.dumps({"cores": compat}))
        stock = [{**self.release, "id": name} for name in
                 ("xray-old-linux-amd64", "xray-current-linux-amd64", "sing-box-old-linux-amd64", "sing-box-current-linux-amd64")]
        self.write_stock(stock)
        for release in stock:
            self.cached_archive(release)
        first = self.bootstrap(kind=None)
        self.assertEqual(first.returncode, 0, first.stderr)
        all_paths = [self.compatibility / x["id"] for x in compat] + [self.stock / x["id"] for x in stock]
        before = {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in all_paths}
        self.assertEqual(len(before), 7)
        second = self.bootstrap(kind=None)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in all_paths})
        self.assertNotIn("unexpected download", first.stderr + second.stderr)

    def test_withdrawn_fixture_metadata_never_downloaded(self):
        current = {**self.release, "id": "xray-26.10.31-linux-amd64", "version": "26.10.31"}
        self.cached_archive(current)
        (self.root / "scripts/stock-core-lock.json").write_text(json.dumps({
            "releases": [self.release, current], "unavailableFixtureReleaseIDs": [self.release["id"]]}))
        result = self.bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Withdrawn upstream fixture", result.stdout)
        self.assertFalse((self.stock / self.release["id"]).exists())
        self.assertTrue((self.stock / current["id"]).exists())
        self.assertNotIn("unexpected download", result.stderr)

    def test_verified_versions_have_distinct_cache_identities_and_reuse_bytes(self):
        older = {**self.release, "id": "xray-26.3.27-linux-amd64", "version": "26.3.27"}
        self.write_stock([older, self.release])
        for release in (older, self.release):
            self.cached_archive(release)
        first = self.bootstrap()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = {}
        for release in (older, self.release):
            path = self.stock / release["id"]
            self.assertEqual(path.read_bytes(), self.payload)
            self.assertTrue(os.access(path, os.X_OK))
            before[path] = (path.stat().st_ino, path.stat().st_mtime_ns)
        second = self.bootstrap()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(before, {p: (p.stat().st_ino, p.stat().st_mtime_ns) for p in before})
        self.assertNotIn("unexpected download", first.stderr + second.stderr)

    def test_archive_digest_is_checked_before_any_extraction(self):
        archive = self.cached_archive(data=b"not even a valid ZIP")
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Archive checksum mismatch", result.stderr)
        self.assertNotIn("BadZipFile", result.stderr)
        self.assertEqual(archive.read_bytes(), b"not even a valid ZIP")
        self.assertFalse((self.stock / self.release["id"]).exists())

    def test_executable_digest_mismatch_never_publishes(self):
        self.write_stock([{**self.release, "executableSHA256": "0" * 64}])
        self.cached_archive()
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Executable checksum mismatch", result.stderr)
        self.assertFalse((self.stock / self.release["id"]).exists())

    def test_existing_corruption_is_not_overwritten(self):
        self.cached_archive()
        executable = self.stock / self.release["id"]
        executable.write_bytes(b"corrupted existing bytes")
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing to overwrite", result.stderr)
        self.assertEqual(executable.read_bytes(), b"corrupted existing bytes")

    def test_symlink_and_nonregular_cache_entries_fail_without_following(self):
        for suffix in ("", ".download"):
            for kind in ("symlink", "directory", "fifo"):
                with self.subTest(suffix=suffix, kind=kind):
                    path = self.stock / (self.release["id"] + suffix)
                    target = self.root / "outside"
                    target.write_bytes(self.payload if not suffix else self.archive)
                    if kind == "symlink":
                        path.symlink_to(target)
                    elif kind == "directory":
                        path.mkdir()
                    else:
                        os.mkfifo(path)
                    try:
                        result = self.bootstrap()
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("Unsafe", result.stderr)
                        self.assertNotIn("unexpected download", result.stderr)
                        self.assertEqual(target.read_bytes(), self.payload if not suffix else self.archive)
                    finally:
                        if kind == "directory":
                            path.rmdir()
                        else:
                            path.unlink()

    def test_tar_symlink_member_is_rejected_even_with_matching_target_digest(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as tar:
            regular = tarfile.TarInfo("real-core")
            regular.size = len(self.payload)
            tar.addfile(regular, io.BytesIO(self.payload))
            member = tarfile.TarInfo("sing-box/sing-box")
            member.type = tarfile.SYMTYPE
            member.linkname = "real-core"
            tar.addfile(member)
        archive = data.getvalue()
        self.write_stock([{**self.release, "archiveFormat": "tar.gz", "executablePath": "sing-box/sing-box", "archiveSHA256": digest(archive)}])
        self.cached_archive(data=archive)
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular archive member", result.stderr)
        self.assertFalse((self.stock / self.release["id"]).exists())

    def test_zip_symlink_member_is_not_published_as_executable(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            member = zipfile.ZipInfo("xray")
            member.create_system = 3
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(member, self.payload)
        archive = data.getvalue()
        self.write_stock([{**self.release, "archiveSHA256": digest(archive)}])
        self.cached_archive(data=archive)
        result = self.bootstrap()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("regular archive member", result.stderr)
        self.assertFalse((self.stock / self.release["id"]).exists())


if __name__ == "__main__":
    unittest.main()

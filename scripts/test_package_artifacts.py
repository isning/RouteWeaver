"""Distribution seams: exact source identity, deterministic bytes, tamper rejection."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_artifacts", Path(__file__).with_name("package_artifacts.py"))
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class PackageArtifactTests(unittest.TestCase):
    def test_manifest_changes_with_source_not_generated_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "main.go").write_text("package main\n")
            first = artifacts.source_manifest(root)
            (root / "bin").mkdir()
            (root / "bin/generated").write_text("irrelevant")
            self.assertEqual(artifacts.source_manifest(root), first)
            (root / "main.go").write_text("package changed\n")
            self.assertNotEqual(artifacts.source_manifest(root)["sha256"], first["sha256"])
            self.assertIsNone(first["commit"])
            self.assertIsNone(first["dirty"])

    def git(self, root, *arguments):
        return subprocess.check_output(["git", "-C", str(root), *arguments], stderr=subprocess.DEVNULL)

    def repository(self, root):
        self.git(root, "init", "--quiet")
        self.git(root, "config", "user.name", "Package fixture")
        self.git(root, "config", "user.email", "fixture@example.invalid")
        (root / "main.go").write_text("package main\n")
        (root / ".gitignore").write_text("bin/\ninternal/extra.go\n")
        self.git(root, "add", ".")
        self.git(root, "commit", "--quiet", "-m", "Synthetic source")

    def test_clean_git_identity_and_ignored_build_affecting_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.repository(root)
            first = artifacts.source_manifest(root)
            self.assertFalse(first["dirty"])
            self.assertEqual(first["commit"], self.git(root, "rev-parse", "HEAD").decode().strip())
            (root / "internal").mkdir()
            (root / "internal/extra.go").write_text("package internal\n")
            changed = artifacts.source_manifest(root)
            self.assertNotEqual(changed["sha256"], first["sha256"])
            self.assertTrue(changed["dirty"])
            self.assertIn("internal/extra.go", {item["path"] for item in changed["files"]})

    def test_linked_git_worktree_metadata_is_not_package_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repository"
            root.mkdir()
            self.repository(root)
            linked = Path(temporary) / "linked"
            self.git(root, "worktree", "add", "--quiet", "--detach", str(linked), "HEAD")
            self.assertTrue((linked / ".git").is_file())
            original = artifacts.source_manifest(root)
            manifest = artifacts.source_manifest(linked)
            self.assertFalse(manifest["dirty"])
            self.assertEqual(manifest["kind"], "git-worktree")
            self.assertEqual(manifest["commit"], original["commit"])
            self.assertEqual(manifest["sha256"], original["sha256"])
            self.assertNotIn(".git", {item["path"] for item in manifest["files"]})

    def test_source_change_fence_rejects_concurrent_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            root.mkdir()
            (root / "main.go").write_text("package main\n")
            manifest = Path(temporary) / "manifest.json"
            manifest.write_text(json.dumps(artifacts.source_manifest(root)))
            (root / "main.go").write_text("changed during build\n")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("package_artifacts.py")),
                                     "check-source", str(manifest), "--root", str(root)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"Source changed", result.stderr)

    def test_private_operator_state_is_not_manifested(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "main.go").write_text("package main\n")
            (root / ".env").write_text("synthetic operator state")
            with self.assertRaisesRegex(ValueError, "Operator state"):
                artifacts.source_manifest(root)

    def test_symlink_source_is_not_silently_read_outside_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "source"
            root.mkdir()
            outside = Path(temporary) / "outside"
            outside.write_text("not source")
            (root / "linked").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "symlink"):
                artifacts.source_manifest(root)

    def test_archive_is_reproducible_despite_mtime_and_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / "routeweaver-linux-amd64"
            stage.mkdir()
            binary = stage / "executable"
            binary.write_bytes(b"synthetic executable")
            binary.chmod(0o755)
            (stage / "README.md").write_text("package docs")
            first, second = root / "first.tar.gz", root / "second.tar.gz"
            artifacts.deterministic_archive(stage, first)
            os.utime(binary, (5000, 9000))
            binary.chmod(0o700)
            (stage / "README.md").chmod(0o600)
            artifacts.deterministic_archive(stage, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_archive_rejects_symlinks_and_outside_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / "app"
            stage.mkdir()
            (stage / "link").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "symlink"):
                artifacts.deterministic_archive(stage, root / "app.tar.gz")
            (stage / "link").unlink()
            with self.assertRaisesRegex(ValueError, "outside"):
                artifacts.deterministic_archive(stage, stage / "app.tar.gz")

    def test_verify_rejects_archive_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "package.tar.gz"
            archive.write_bytes(b"test fixture")
            provenance = {"schemaVersion": 1, "archive": {"name": archive.name, "sha256": artifacts.sha256_file(archive), "bytes": archive.stat().st_size}}
            Path(str(archive) + ".provenance.json").write_text(json.dumps(provenance))
            self.assertEqual(artifacts.verify_archive(archive), provenance)
            archive.write_bytes(b"different fixture")
            with self.assertRaisesRegex(ValueError, "does not match"):
                artifacts.verify_archive(archive)


if __name__ == "__main__":
    unittest.main()

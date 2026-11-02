"""Exercise the actual pinned scanner at its command-line boundary."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMMAND = ["python3", str(ROOT / "scripts/check-secrets.py")]
# Synthetic, non-issued token assembled so this test source is not a finding.
TOKEN = "gh" + "p_" + "6At8Nz2Lc4Qr9Vw3Yx5Bk7Dm1Hs0Ju8Pe6Cf"


class SecretScannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "user.name", "Scanner fixture")
        self.git("config", "user.email", "scanner@example.invalid")
        self.write("README.md", "Synthetic scanner fixture.\n")
        self.commit()

    def git(self, *arguments):
        return subprocess.run(["git", "-C", str(self.root), *arguments],
                              check=True, capture_output=True, text=True).stdout

    def write(self, path, contents):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents if isinstance(contents, bytes) else contents.encode())

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "Synthetic fixture")

    def scan(self, expected=0, *arguments):
        result = subprocess.run([*COMMAND, "--root", str(self.root), *arguments],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_clean_repository_passes(self):
        self.assertIn("PASS", self.scan())

    def test_untracked_secret_is_rejected_without_staging(self):
        self.write("new-file.txt", TOKEN)
        self.assertIn("github-pat", self.scan(1))
        self.assertIn("?? new-file.txt", self.git("status", "--short"))

    def test_index_secret_is_rejected_even_after_worktree_overwrites_it(self):
        self.write("config.txt", TOKEN)
        self.git("add", "config.txt")
        self.write("config.txt", "clean worktree\n")
        self.assertIn("index", self.scan(1))

    def test_deleted_history_secret_is_rejected(self):
        self.write("config.txt", TOKEN)
        self.commit()
        self.git("rm", "config.txt")
        self.commit()
        self.assertIn("history:", self.scan(1))

    def test_binary_attributes_cannot_hide_deleted_history(self):
        self.write(".gitattributes", "*.dat binary\n")
        self.write("sensitive.dat", TOKEN)
        self.commit()
        self.git("rm", "sensitive.dat")
        self.commit()
        self.assertIn("history:", self.scan(1))

    def test_secret_created_only_in_merge_commit_is_rejected_after_deletion(self):
        self.git("checkout", "--quiet", "-b", "topic")
        self.write("topic.txt", "topic\n")
        self.commit()
        self.git("checkout", "--quiet", "main")
        self.write("main.txt", "main\n")
        self.commit()
        self.git("merge", "--no-ff", "--no-commit", "topic")
        self.write("merge-only.txt", TOKEN)
        self.commit()
        self.git("rm", "merge-only.txt")
        self.commit()
        self.assertIn("history:", self.scan(1))

    def test_tracked_ignored_file_remains_scanned(self):
        self.write(".gitignore", "config.txt\n")
        self.write("config.txt", TOKEN)
        self.git("add", "--force", "config.txt")
        self.assertIn("github-pat", self.scan(1))

    def test_plaintext_inside_binary_file_is_not_skipped(self):
        self.write("payload.bin", b"\x00\xff\x01" + TOKEN.encode() + b"\x00")
        self.assertIn("github-pat", self.scan(1))

    def test_large_source_is_not_silently_skipped(self):
        self.write("large.txt", ("ordinary source line\n" * 60000) + TOKEN + "\n")
        self.assertIn("github-pat", self.scan(1))

    def test_bom_marked_utf16_and_utf32_secrets_are_rejected(self):
        for encoding in ["utf-16", "utf-32"]:
            with self.subTest(encoding=encoding):
                self.write("encoded.txt", TOKEN.encode(encoding))
                self.assertIn("github-pat", self.scan(1))

    def test_history_on_a_non_head_ref_is_scanned(self):
        self.git("checkout", "--quiet", "-b", "other-ref")
        self.write("other-ref.txt", TOKEN)
        self.commit()
        self.git("checkout", "--quiet", "main")
        self.assertIn("history:", self.scan(1))

    def test_environment_config_override_cannot_disable_the_gate(self):
        self.write("config.txt", TOKEN)
        variable = "GITLEAKS_CONFIG_TOML"
        before = os.environ.get(variable)
        try:
            os.environ[variable] = 'title = "empty override"\n'
            self.assertIn("github-pat", self.scan(1))
        finally:
            if before is None:
                os.environ.pop(variable, None)
            else:
                os.environ[variable] = before

    def test_upstream_broad_path_exemptions_are_not_honored(self):
        for name in ["config.png", "go.sum", "package-lock.json", ".gitleaks.toml",
                     "vendor/github.com/acme/test.go", "@octokit/auth-token/README.md"]:
            with self.subTest(path=name):
                self.write(name, TOKEN)
                self.assertIn("github-pat", self.scan(1))
                (self.root / name).unlink()

    def test_inline_allow_comment_cannot_suppress_a_finding(self):
        self.write("config.txt", TOKEN + " # gitleaks:allow\n")
        self.assertIn("github-pat", self.scan(1))

    def test_user_ignore_file_cannot_suppress_a_finding(self):
        self.write("config.txt", TOKEN)
        self.write(".gitleaksignore", "config.txt:github-pat:1\n")
        self.assertIn("github-pat", self.scan(1))

    def test_tree_scope_explicitly_does_not_claim_history(self):
        self.write("old.txt", TOKEN)
        self.commit()
        self.git("rm", "old.txt")
        self.commit()
        self.assertIn("scope=tree", self.scan(0, "--scope", "tree"))

    def test_missing_or_modified_scanner_is_failure_not_skip(self):
        missing = self.root / "missing-scanner"
        self.assertIn("incomplete", self.scan(2, "--binary", str(missing)))
        self.write("modified-scanner", "#!/bin/sh\nexit 0\n")
        self.assertIn("modified", self.scan(2, "--binary", str(self.root / "modified-scanner")))

    def test_shallow_history_is_failure_not_partial_success(self):
        (self.root / ".git/shallow").write_text(self.git("rev-parse", "HEAD"))
        self.assertIn("shallow", self.scan(2))

    def test_path_only_pkcs12_detector_is_retained(self):
        self.write("credentials.p12", "opaque binary placeholder\n")
        self.assertIn("pkcs12-file", self.scan(1))

    def test_reviewed_exact_line_is_allowed_but_new_secret_in_same_file_is_not(self):
        path = "web/src/server-tls-editor.dom.test.tsx"
        self.write(path, (ROOT / path).read_bytes())
        self.scan()
        self.write(path, (ROOT / path).read_bytes() + b"\n" + TOKEN.encode())
        self.assertIn("github-pat", self.scan(1))

    def test_reviewed_module_checksum_is_exact_line_and_path_only(self):
        path = "runtimes/xray/go.sum"
        line = next(line for line in (ROOT / path).read_text().splitlines()
                    if line.startswith("golang.org/x/oauth2 v0.36.0 "))
        self.write(path, line + "\n")
        self.assertIn("PASS", self.scan())
        # Even a harmless change cannot inherit the content exception.
        self.write(path, line + " changed\n")
        self.assertIn("generic-api-key", self.scan(1))
        (self.root / path).unlink()
        self.write("other/go.sum", line + "\n")
        self.assertIn("generic-api-key", self.scan(1))

    def test_reviewed_source_manifest_is_exact_line_and_path_only(self):
        path = "docs/verification/evidence/UPDATED-MANAGED-SOURCE-MANIFEST-2026-11-01.json"
        content = (ROOT / path).read_bytes()
        self.write(path, content)
        self.assertIn("PASS", self.scan())
        self.write(path, content.rstrip(b"\n") + b" \n")
        modified = self.scan(1)
        self.assertIn("generic-api-key", modified)
        self.assertIn("jfrog-identity-token", modified)
        (self.root / path).unlink()
        self.write("other/source-manifest.json", content)
        elsewhere = self.scan(1)
        self.assertIn("generic-api-key", elsewhere)
        self.assertIn("jfrog-identity-token", elsewhere)

    def test_operational_drill_hash_exceptions_are_exact_lines_and_path(self):
        path = "docs/verification/evidence/OPERATIONS-DRILLS-2026-11-01.json"
        lines = (ROOT / path).read_text().splitlines()
        for number in [93, 94]:
            with self.subTest(receipt_line=number):
                line = lines[number - 1]
                self.write(path, line + "\n")
                self.assertIn("PASS", self.scan())
                self.write(path, line + " changed\n")
                self.assertIn("jfrog-identity-token", self.scan(1))
                (self.root / path).unlink()
                self.write("other/drill-receipt.json", line + "\n")
                self.assertIn("jfrog-identity-token", self.scan(1))
                (self.root / "other/drill-receipt.json").unlink()

    def test_final_soak_binary_hash_exceptions_are_exact_lines_and_path(self):
        path = "docs/verification/evidence/FINAL-MANAGED-REFERENCE-2026-11-01.json"
        # Exact reviewed metadata bytes, not tokens. Numeric fixtures avoid
        # introducing duplicate scanner matches at an unrelated source path.
        fixtures = [('jfrog-identity-token',
          [32, 32, 32, 32, 32, 32, 32, 32, 34, 98, 105, 110, 47, 102, 105, 110, 97, 108, 45, 114, 101, 102,
           101, 114, 101, 110, 99, 101, 45, 109, 97, 110, 97, 103, 101, 100, 45, 120, 114, 97, 121, 34, 58,
           32, 34, 51, 49, 102, 54, 97, 97, 48, 99, 100, 56, 51, 57, 50, 55, 54, 51, 97, 53, 50, 55, 50, 53,
           55, 99, 100, 51, 98, 55, 102, 55, 102, 57, 53, 101, 99, 56, 99, 56, 101, 99, 100, 50, 48, 101,
           52, 98, 97, 102, 99, 98, 100, 98, 54, 98, 56, 57, 54, 54, 51, 101, 97, 100, 98, 101, 34, 44]),
         ('generic-api-key',
          [32, 32, 32, 32, 32, 32, 32, 32, 34, 98, 105, 110, 47, 102, 105, 110, 97, 108, 45, 114, 101, 102,
           101, 114, 101, 110, 99, 101, 45, 104, 116, 116, 112, 97, 112, 105, 46, 116, 101, 115, 116, 34,
           58, 32, 34, 56, 50, 49, 101, 53, 48, 51, 53, 49, 100, 53, 52, 99, 51, 48, 54, 55, 102, 51, 53,
           102, 49, 49, 49, 48, 100, 98, 49, 49, 56, 49, 99, 102, 101, 50, 102, 50, 97, 56, 97, 99, 54, 54,
           51, 57, 53, 50, 56, 54, 50, 97, 98, 98, 98, 102, 53, 102, 49, 54, 50, 52, 56, 54, 50, 34])]
        for rule, encoded in fixtures:
            with self.subTest(rule=rule):
                line = bytes(encoded)
                self.write(path, line + b"\n")
                self.assertIn("PASS", self.scan())
                self.write(path, line + b" changed\n")
                self.assertIn(rule, self.scan(1))
                (self.root / path).unlink()
                self.write("other/final-soak.json", line + b"\n")
                self.assertIn(rule, self.scan(1))
                (self.root / "other/final-soak.json").unlink()

    def test_secret_file_outside_repository_is_not_followed(self):
        with tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "outside.txt"
            target.write_text(TOKEN)
            (self.root / "link").symlink_to(target)
            self.scan()

    def test_symlinked_parent_cannot_read_outside_repository(self):
        self.write("directory/config.txt", "clean\n")
        self.commit()
        (self.root / "directory/config.txt").unlink()
        (self.root / "directory").rmdir()
        with tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "config.txt").write_text(TOKEN)
            (self.root / "directory").symlink_to(outside, target_is_directory=True)
            self.assertIn("outside", self.scan(2))


if __name__ == "__main__":
    unittest.main()

"""Deterministic offline fixtures for the distribution notice inventory."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collect-notices.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class NoticeTests(unittest.TestCase):
    def test_nested_text_is_unchanged_and_other_installations_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            (source / "vendor").mkdir(parents=True)
            original = b"Copyright upstream\r\n\xff\n"
            (source / "vendor/NOTICE.txt").write_bytes(original)
            (source / "node_modules/unrelated").mkdir(parents=True)
            (source / "node_modules/unrelated/LICENSE").write_text("not this dependency")
            (source / "LICENSE-link").symlink_to(source / "vendor/NOTICE.txt")
            entry = collector.collect(source, root / "out", {"name": "fixture"})
            self.assertEqual([x["path"] for x in entry["texts"]], ["vendor/NOTICE.txt"])
            self.assertEqual((root / "out/vendor/NOTICE.txt").read_bytes(), original)

    def test_readme_license_section_is_retained_whole_and_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            original = b"# Package\r\nUsage instructions\r\n## License\r\nUpstream copyright and terms\r\n"
            (source / "README.md").write_bytes(original)
            (source / "README-other.md").write_text("Usage only, no license section")
            entry = collector.collect(source, root / "out", {"name": "fixture"})
            self.assertEqual([x["path"] for x in entry["texts"]], ["README.md"])
            self.assertEqual((root / "out/README.md").read_bytes(), original)

    def test_third_party_license_and_notice_files_are_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            names = ["THIRD-PARTY-LICENSE", "THIRD_PARTY_NOTICES.md", "third-party-licenses.txt"]
            for name in names:
                (source / name).write_text("Exact upstream third-party terms\n")
            entry = collector.collect(source, root / "out", {"name": "fixture"})
            self.assertEqual({item["path"] for item in entry["texts"]}, set(names))
            for name in names:
                self.assertEqual((root / "out" / name).read_bytes(), (source / name).read_bytes())

    def test_missing_text_is_explicit_not_inferred_from_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            entry = collector.collect(Path(temporary), Path(temporary) / "out", {"declared_license": "MIT"})
            self.assertEqual(entry["status"], "MISSING-LICENSE-TEXT")
            self.assertEqual(entry["texts"], [])

    def test_linked_go_modules_deduplicate_and_replacements_fail_closed(self):
        info = "\tdep\texample.com/Upper\tv1.2.3\th1:abc\n" * 2
        self.assertEqual(collector.go_dependencies(info), [("example.com/Upper", "v1.2.3")])
        self.assertEqual(collector.go_escape("example.com/Upper"), "example.com/!upper")
        with self.assertRaisesRegex(ValueError, "Replaced Go module"):
            collector.go_dependencies(info + "\t=>\t../local\t(devel)\n")

    def test_production_graph_excludes_dev_and_absent_optional_and_checks_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            web = Path(temporary)
            production = web / "node_modules/runtime"
            production.mkdir(parents=True)
            (production / "package.json").write_text(json.dumps({"name": "runtime", "version": "1.0.0"}))
            lock = {"lockfileVersion": 3, "packages": {"": {},
                "node_modules/runtime": {"version": "1.0.0"},
                "node_modules/test-runner": {"version": "1.0.0", "dev": True},
                "node_modules/platform-addon": {"version": "1.0.0", "optional": True}}}
            (web / "package-lock.json").write_text(json.dumps(lock))
            self.assertEqual([entry[1]["name"] for entry in collector.production_packages(web)], ["runtime"])
            (production / "package.json").write_text(json.dumps({"name": "runtime", "version": "2.0.0"}))
            with self.assertRaisesRegex(ValueError, "differs from lock"):
                list(collector.production_packages(web))


if __name__ == "__main__":
    unittest.main()

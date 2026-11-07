"""Whole-file scheduling must preserve Playwright's discovered test identities."""
import copy
import json
import random
import re
from pathlib import Path
import tempfile
import unittest

from browser_distribution import (exact_selector, inventory, load_weights, partition, parse_shard)


def report(root, names):
    return {"config": {"rootDir": str(root)}, "errors": [], "suites": [
        {"specs": [{"file": name, "id": f"{name}:{index}",
                     "tests": [{"projectName": "chromium"}]} for index in range(2)], "suites": []}
        for name in names]}


class BrowserDistributionTests(unittest.TestCase):
    def test_weighted_partition_is_complete_unique_and_order_independent(self):
        names = ["a.ui.spec.ts", "b.ui.spec.ts", "c.ui.spec.ts", "d.ui.spec.ts", "new.ui.spec.ts"]
        weights = {names[0]: 100, names[1]: 90, names[2]: 20, names[3]: 10}
        expected = [[names[0]], [names[1]], [names[4]], [names[2], names[3]]]
        self.assertEqual(partition(names, weights, 4, 30), expected)
        for seed in range(20):
            shuffled = names.copy()
            random.Random(seed).shuffle(shuffled)
            groups = partition(shuffled, weights, 4, 30)
            self.assertEqual(groups, expected)
            self.assertCountEqual([name for group in groups for name in group], names)
        self.assertEqual(partition(["a", "b", "c", "d", "e"], {}, 4, 30),
                         [["a", "e"], ["b"], ["c"], ["d"]])

    def test_invalid_or_stale_partition_inputs_fail(self):
        for names, weights, total, fallback in [([], {}, 4, 30), (["a", "a"], {}, 1, 30),
                (["a"], {"old": 1}, 1, 30), (["a"], {}, 2, 30), (["a"], {}, 0, 30),
                (["a"], {}, 1, 0), (["a"], {"a": -1}, 1, 30), (["a"], {"a": True}, 1, 30)]:
            with self.subTest(names=names, weights=weights, total=total, fallback=fallback), self.assertRaises(ValueError):
                partition(names, weights, total, fallback)
        for value in ["0/4", "5/4", "1/04", "1/0", "1000/1000", "1/4 --grep smoke", "1/4\n"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_shard(value)
        self.assertEqual(parse_shard("2/4"), (2, 4))

    def test_discovery_uses_only_actual_project_tests_including_nested_suites(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            names = ["journey.ui.spec.ts", "nested/a [1]+.ui.spec.ts"]
            for name in [*names, "ignored.ui.spec.ts", "native.native.spec.ts", "api.api.spec.ts"]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            data = report(root, names)
            data["suites"][1] = {"suites": [data["suites"][1]], "specs": []}
            files = inventory(data, root)
            self.assertEqual(files, {name: {(f"{name}:0", 0), (f"{name}:1", 0)} for name in names})
            self.assertNotIn("ignored.ui.spec.ts", files)
            for change in [lambda d: d.update(errors=[{"message": "collection failed"}]),
                           lambda d: d.update(suites=[]),
                           lambda d: d["suites"][0]["specs"][0].update(file="../outside.ui.spec.ts"),
                           lambda d: d["suites"][0]["specs"][0].update(tests=[{"projectName": "api"}]),
                           lambda d: d["suites"][0]["specs"].append(copy.deepcopy(d["suites"][0]["specs"][0]))]:
                invalid = copy.deepcopy(data)
                change(invalid)
                with self.assertRaises(ValueError):
                    inventory(invalid, root)

    def test_exact_paths_remain_literal_regex(self):
        paths = ["/tmp/repo [test]+(copy)/web/tests/a.b.ui.spec.ts",
                 "/tmp/repo [test]+(copy)/web/tests/nested/a$^{}|?.ui.spec.ts"]
        patterns = [exact_selector(Path(path)) for path in paths]
        candidates = [*paths, paths[0] + ".bak", paths[0].replace("a.b", "axb")]
        self.assertEqual([[bool(re.search(pattern, path)) for path in candidates] for pattern in patterns],
                         [[True, False, False, False], [False, True, False, False]])

    def test_weight_metadata_rejects_bad_or_missing_provenance(self):
        data = {"version": 1, "fallback_seconds": 30,
                "sources": {"run": {"commit": "a" * 40, "shard": "1/4", "started_at": "2026-11-07T18:32:11Z"}},
                "files": {"journey.ui.spec.ts": {"seconds": 42, "source": "run"}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "weights.json"
            path.write_text(json.dumps(data))
            self.assertEqual(load_weights(path), ({"journey.ui.spec.ts": 42}, 30))
            for change in [lambda d: d.update(version=2), lambda d: d.update(fallback_seconds=0),
                           lambda d: d["files"]["journey.ui.spec.ts"].update(seconds="42"),
                           lambda d: d["files"]["journey.ui.spec.ts"].update(seconds=float("nan")),
                           lambda d: d["files"]["journey.ui.spec.ts"].update(source="missing"),
                           lambda d: d["sources"]["run"].update(commit="guess")]:
                invalid = copy.deepcopy(data)
                change(invalid)
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    load_weights(path)
            path.write_text('{"version": 1, "version": 1}')
            with self.assertRaises(ValueError):
                load_weights(path)


if __name__ == "__main__":
    unittest.main()

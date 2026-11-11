"""Public web verification CLI must preserve complete gates and fail closed."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WebShardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        shutil.copy(ROOT / 'scripts/verify.sh', self.root / 'scripts/verify.sh')
        self.log = self.root / 'calls'
        npm = self.root / 'npm'
        npm.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAIL_STAGE') in sys.argv[1:]: sys.exit(23)
''')
        npm.chmod(0o755)

    def run_gate(self, shard=None, mode='web', failure=''):
        self.log.unlink(missing_ok=True)
        env = {k: v for k, v in os.environ.items() if k not in ('ROUTEWEAVER_WEB_SHARD', 'ROUTEWEAVER_WEB_TEST_WORKERS')}
        env.update(PATH=f"{self.root}:{env['PATH']}", CALLS=str(self.log), FAIL_STAGE=failure)
        if shard is not None:
            env['ROUTEWEAVER_WEB_SHARD'] = shard
        result = subprocess.run(['bash', str(self.root / 'scripts/verify.sh'), mode], env=env, text=True, capture_output=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_each_shard_preserves_types_isolation_worker_limit_and_build(self):
        for shard in ('1/2', '2/2'):
            result, calls = self.run_gate(shard)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(calls, [
                ['--prefix', 'web', 'run', 'typecheck'],
                ['--prefix', 'web', 'run', 'test', '--', '--maxWorkers=1', f'--shard={shard}'],
                ['--prefix', 'web', 'run', 'build'],
            ])
            self.assertIn(f'PASS: web shard {shard} only', result.stdout)
            self.assertNotIn('PASS: web verification', result.stdout)

    def test_default_is_complete_unsharded_gate(self):
        result, calls = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1], ['--prefix', 'web', 'run', 'test', '--', '--maxWorkers=1'])
        self.assertEqual(calls[-1][-1], 'build')
        self.assertIn('PASS: web verification', result.stdout)

    def test_invalid_shards_fail_before_any_gate(self):
        for shard in ('0/2', '3/2', '1/0', '1/02', 'all', '1/2 --passWithNoTests', '1000/1000'):
            with self.subTest(shard=shard):
                result, calls = self.run_gate(shard)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(calls, [])
                self.assertNotIn('PASS:', result.stdout)

    def test_full_and_quick_reject_partial_web_before_any_gate(self):
        for mode in ('full', 'quick'):
            result, calls = self.run_gate('1/2', mode)
            self.assertEqual(result.returncode, 2)
            self.assertIn('cannot select a partial web shard', result.stderr)
            self.assertEqual(calls, [])

    def test_failures_stop_without_success_or_later_gates(self):
        for stage, expected_calls in (('typecheck', 1), ('test', 2), ('build', 3)):
            result, calls = self.run_gate('2/2', failure=stage)
            self.assertEqual(result.returncode, 23)
            self.assertEqual(len(calls), expected_calls)
            self.assertNotIn('PASS:', result.stdout)

    def test_workflow_preserves_complete_required_matrix(self):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        web = workflow.split('\n  web:\n', 1)[1].split('\n  api:\n', 1)[0]
        for contract in ('timeout-minutes: 20', 'fail-fast: false', 'shard: [1, 2]',
                         'ROUTEWEAVER_WEB_SHARD: ${{ matrix.shard }}/2',
                         'node scripts/check-web-shards.mjs', 'scripts/verify.sh web'):
            self.assertIn(contract, web)
        self.assertIn('ROUTEWEAVER_WEB_TEST_WORKERS: "1"', workflow)
        config = (ROOT / 'web/vitest.config.ts').read_text()
        self.assertNotIn('isolate: false', config)
        self.assertNotIn('continue-on-error', web)


if __name__ == '__main__':
    unittest.main()

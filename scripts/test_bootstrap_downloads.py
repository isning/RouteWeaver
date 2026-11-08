"""Offline bootstrap download behavior at the materialize/main seams."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cores = load('core_bootstrap', 'scripts/bootstrap-cores.py')
scanner = load('scanner_bootstrap', 'scripts/security/bootstrap.py')


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.payload = b'synthetic fixture, never executed'
        self.archive = gzip.compress(self.payload)
        self.url = 'https://invalid.example/pinned-release'
        self.core = dict(id='fixture', version='fixture', url=self.url,
                         archiveFormat='gzip', executablePath='',
                         archiveSHA256=hashlib.sha256(self.archive).hexdigest(),
                         executableSHA256=hashlib.sha256(self.payload).hexdigest())

    def scanner_run(self, responses):
        security = self.root / 'scripts/security'
        security.mkdir(parents=True, exist_ok=True)
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as release:
            member = tarfile.TarInfo('gitleaks')
            member.size = len(self.payload)
            release.addfile(member, io.BytesIO(self.payload))
        data = archive.getvalue()
        lock = dict(archiveURL=self.url, archiveSHA256=hashlib.sha256(data).hexdigest(),
                    executableSHA256=hashlib.sha256(self.payload).hexdigest(), version='fixture')
        (security / 'gitleaks.lock.json').write_text(json.dumps(lock))
        values = [io.BytesIO(data) if value == 'good' else value for value in responses]
        with patch.object(scanner, '__file__', str(security / 'bootstrap.py')), \
             patch.object(scanner.platform, 'system', return_value='Linux'), \
             patch.object(scanner.platform, 'machine', return_value='x86_64'), \
             patch.object(scanner.urllib.request, 'urlopen', side_effect=values) as request, \
             patch('time.sleep') as sleep:
            try:
                scanner.main()
            finally:
                self.requests = request.call_args_list
                self.sleeps = sleep.call_args_list

    def test_scanner_retries_504_then_installs_verified_bytes(self):
        error = urllib.error.HTTPError(self.url, 504, 'gateway timeout', {}, None)
        self.scanner_run([error, 'good'])
        self.assertEqual((self.root / 'bin/tools/gitleaks').read_bytes(), self.payload)
        self.assertEqual(len(self.requests), 2)
        self.assertTrue(all(call.args == (self.url,) and call.kwargs == dict(timeout=60)
                            for call in self.requests))
        self.assertEqual([call.args for call in self.sleeps], [(2,)])

    def test_scanner_permanent_errors_fail_once_without_installing(self):
        for error in [urllib.error.HTTPError(self.url, code, 'permanent', {}, None)
                      for code in (403, 404, 429, 501)] + [
                          urllib.error.URLError(ssl.SSLCertVerificationError('bad certificate')),
                          urllib.error.URLError('name resolution failed')]:
            with self.subTest(error=error):
                with self.assertRaises(type(error)):
                    self.scanner_run([error])
                self.assertEqual(len(self.requests), 1)
                self.assertEqual(self.sleeps, [])
                self.assertFalse((self.root / 'bin/tools/gitleaks').exists())

    def test_scanner_transient_errors_exhaust_four_attempts(self):
        for error in [TimeoutError('timeout'), urllib.error.URLError(TimeoutError('timeout'))] + [
                urllib.error.HTTPError(self.url, code, 'transient', {}, None)
                for code in (500, 502, 503, 504)]:
            with self.subTest(error=error):
                with self.assertRaises(type(error)):
                    self.scanner_run([error] * 4)
                self.assertEqual(len(self.requests), 4)
                self.assertEqual([call.args for call in self.sleeps], [(2,), (4,), (8,)])
                self.assertFalse((self.root / 'bin/tools/gitleaks').exists())

    def test_scanner_bad_archive_is_not_retried(self):
        with self.assertRaisesRegex(SystemExit, 'archive checksum mismatch'):
            self.scanner_run([io.BytesIO(b'corrupt archive')])
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.sleeps, [])
        self.assertFalse((self.root / 'bin/tools/gitleaks').exists())

    def test_core_failure_classification_and_exhaustion(self):
        for code, status, attempts in [(28, '000', 4), (22, '500', 4),
                                      (22, '502', 4), (22, '503', 4), (22, '504', 4),
                                      (22, '403', 1), (22, '404', 1), (22, '429', 1),
                                      (22, '501', 1), (60, '000', 1),
                                      (63, '200', 1), (6, '000', 1), (91, '', 1)]:
            with self.subTest(code=code, status=status):
                calls = []
                def curl(args, **kwargs):
                    target = Path(args[args.index('-o') + 1])
                    self.assertFalse(target.exists(), 'partial bytes must be removed before retry')
                    target.write_bytes(b'partial')
                    calls.append(args)
                    return subprocess.CompletedProcess(args, code, stdout=status)
                with patch.object(cores.subprocess, 'run', side_effect=curl), patch('time.sleep') as sleep:
                    with self.assertRaises(subprocess.CalledProcessError):
                        cores.materialize(self.core, self.root)
                self.assertEqual(len(calls), attempts)
                self.assertEqual(sleep.call_count, attempts - 1)
                self.assertFalse((self.root / 'fixture').exists())
                self.assertFalse((self.root / 'fixture.download').exists())
                self.assertTrue(all(args == calls[0] for args in calls))
                args = calls[0]
                for flag, value in [('--proto', '=https'), ('--proto-redir', '=https'),
                                    ('--max-time', '180'), ('--max-filesize', '134217728')]:
                    self.assertEqual(args[args.index(flag) + 1], value)
                self.assertIn('--tlsv1.2', args)
                self.assertIn(self.url, args)
                self.assertNotIn('--insecure', args)

    def test_core_bad_download_is_not_retried_or_cached(self):
        def curl(args, **kwargs):
            Path(args[args.index('-o') + 1]).write_bytes(b'corrupt')
            return subprocess.CompletedProcess(args, 0, stdout='200')
        with patch.object(cores.subprocess, 'run', side_effect=curl) as run, patch('time.sleep') as sleep:
            with self.assertRaisesRegex(SystemExit, 'Archive checksum mismatch'):
                cores.materialize(self.core, self.root)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()
        self.assertFalse((self.root / 'fixture').exists())
        self.assertFalse((self.root / 'fixture.download').exists())

    def test_core_retries_504_then_installs_verified_bytes(self):
        calls = []
        def curl(args, **kwargs):
            calls.append(args)
            Path(args[args.index('-o') + 1]).write_bytes(self.archive if len(calls) == 2 else b'partial')
            if len(calls) == 1 and kwargs.get('check'):
                raise subprocess.CalledProcessError(22, args)
            return subprocess.CompletedProcess(args, 22 if len(calls) == 1 else 0,
                                               stdout='504' if len(calls) == 1 else '200')
        with patch.object(cores.subprocess, 'run', side_effect=curl), patch('time.sleep') as sleep:
            cores.materialize(self.core, self.root)
        self.assertEqual((self.root / 'fixture').read_bytes(), self.payload)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        sleep.assert_called_once_with(2)


if __name__ == '__main__':
    unittest.main()

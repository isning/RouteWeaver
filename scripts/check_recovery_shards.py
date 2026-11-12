"""Prove actual Playwright recovery discovery coverage; never launch a browser."""
from collections import Counter
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def validate_coverage(whole, first, second, expected_files):
    for selected in (whole, first, second):
        identities = selected['identities']
        if not identities or len(identities) != len(set(identities)):
            raise ValueError('Empty or duplicate discovery identities')
    if whole['files'] != expected_files:
        raise ValueError('Discovery does not contain every configured recovery spec')
    if set(first['identities']) & set(second['identities']):
        raise ValueError('Recovery shards overlap')
    if Counter(first['identities'] + second['identities']) != Counter(whole['identities']):
        raise ValueError('Recovery shards do not cover complete discovery exactly once')
    return tuple(len(selected['identities']) for selected in (whole, first, second))


def discover(shard=None):
    args = ['node', 'node_modules/playwright/cli.js', 'test',
            '--config=playwright.ux-recovery.config.ts', '--workers=1',
            '--retries=0', '--list', '--reporter=json']
    if shard:
        args.append('--shard=' + shard)
    result = subprocess.run(args, cwd=ROOT / 'web', capture_output=True,
                            text=True, timeout=60, check=True)
    report = json.loads(result.stdout)
    if report['errors'] or report['config']['workers'] != 1:
        raise ValueError('Playwright discovery failed or changed worker isolation')
    identities, files = [], set()
    def visit(suites):
        for suite in suites:
            for spec in suite.get('specs', []):
                files.add(spec['file'])
                for test in spec['tests']:
                    if test['projectName'] != 'chromium':
                        raise ValueError('Unexpected project in recovery discovery')
                    identities.append((test['projectName'], spec['id']))
            visit(suite.get('suites', []))
    visit(report['suites'])
    return {'identities': identities, 'files': files}


def main():
    config = (ROOT / 'web/playwright.ux-recovery.config.ts').read_text()
    expected_files = {f'{name}.ui.spec.ts' for name in re.findall(r'"\*\*/([^"/]+)\.ui\.spec\.ts"', config)}
    if not expected_files:
        raise ValueError('No configured recovery specs')
    whole, first, second = discover(), discover('1/2'), discover('2/2')
    total, one, two = validate_coverage(whole, first, second, expected_files)
    print(f'Playwright exact-once discovery: {total} tests across {len(expected_files)} specs; '
          f'shards {one} + {two}; no browser execution.')


if __name__ == '__main__':
    main()

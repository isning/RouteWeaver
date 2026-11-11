"""The recovery lane is supplemental; browser safety and required gates stay intact."""
from pathlib import Path, PurePosixPath
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPECS = {
    'server-json-recovery', 'workspace-return', 'notification-channel-journey',
    'template-target-identity', 'admin-validation-recovery', 'admin-validation-order',
    'compact-choice-keyboard', 'multi-choice-reopening',
}
COMPACT_PHASES = (
    'protocol-cancel', 'protocol-settled-reopen', 'transport-cancel',
    'transport-disabled-skip', 'final-state',
)
MULTI_PHASES = (
    'initial-draft-preview',
    'first-tag-option', 'same-trigger-reopened', 'second-tag-created',
    'returned-to-tag-trigger', 'newer-region-owner', 'newer-protocol-owner',
    'protocol-selected', 'preview-draft', 'final-state', 'failure-original',
)
ARTIFACTS = {
    'web/playwright-report/', 'bin/verification/browser-environment.json',
    'web/test-results/*/route-json-*.png',
    'web/test-results/*/route-json-recovery-evidence.json',
    'web/test-results/*/subscription-return-restored.png',
    'web/test-results/*/direct-output-close-scoped-list.png',
    'web/test-results/*/subscription-linked-editor-return.png',
    'web/test-results/*/subscription-linked-editor-return.json',
    'web/test-results/*/notification-channel-journey-*.png',
    'web/test-results/*/notification-channel-journey-*.json',
    'web/test-results/*/notification-focus-*.png',
    'web/test-results/*/notification-focus-*.json',
    'web/test-results/template-target-identity*/client-profile-*.png',
    'web/test-results/template-target-identity*/client-profile-*-ledger.json',
    'web/test-results/template-target-identity*/processing-preset-*.png',
    'web/test-results/template-target-identity*/processing-preset-*-ledger.json',
    'web/test-results/*/template-target-identity-ledger.json',
    *{f'web/test-results/compact-choice-keyboard*/{phase}.{ext}'
      for phase in COMPACT_PHASES for ext in ('png', 'json')},
    'web/test-results/compact-choice-keyboard*/capture-failure.json',
    *{f'web/test-results/multi-choice-reopening*/{phase}.{ext}'
      for phase in MULTI_PHASES for ext in ('png', 'json')},
    'web/test-results/multi-choice-reopening*/request-ledger.json',
    *{f'web/test-results/admin-validation-recovery*/{name}.{ext}'
      for name in ('failed-*', 'pending-*', 'result-*', 'final-state', 'request-ledger')
      for ext in ('png', 'json') if name != 'request-ledger' or ext == 'json'},
    *{f'web/test-results/admin-validation-order*/{name}.{ext}'
      for name in ('*-latest-result', 'older-did-not-replace', 'final-state', 'request-ledger')
      for ext in ('png', 'json') if name != 'request-ledger' or ext == 'json'},
}


class UXRecoveryWorkflowTests(unittest.TestCase):
    def test_chrome_provenance_and_startup_match_required_ci(self):
        full = (ROOT / '.github/workflows/ci.yml').read_text()
        focused = (ROOT / '.github/workflows/ux-recovery-focus.yml').read_text()
        start = '      - name: Verify installed Chrome Stable and sandboxed startup\n'
        def block(text):
            return text.split(start, 1)[1].split('\n      - ', 1)[0]
        self.assertEqual(block(focused), block(full))

    def test_additive_lane_is_bounded_and_never_replaces_required_gates(self):
        workflow = (ROOT / '.github/workflows/ux-recovery-focus.yml').read_text()
        self.assertEqual(workflow.split('on:\n', 1)[1].split('\npermissions:', 1)[0].strip(),
                         "push:\n    branches:\n      - 'ux-task-journeys-*'")
        for value in ('group: ux-recovery-${{ github.ref }}', 'cancel-in-progress: false',
                      'contents: read', 'persist-credentials: false', 'runs-on: ubuntu-24.04',
                      'timeout-minutes: 15', 'timeout-minutes: 10',
                      'name: Eight recovery specs (supplemental evidence only)',
                      'name: Run eight recovery specs with unchanged fixtures',
                      'ROUTEWEAVER_CHROMIUM: /opt/google/chrome/chrome',
                      'npx --no-install playwright install-deps chromium',
                      '--config=playwright.ux-recovery.config.ts --workers=1 --retries=0'):
            self.assertIn(value, workflow)
        self.assertEqual(re.findall(r'^  ([a-z_]+):$', workflow.split('jobs:\n', 1)[1], re.M), ['recovery'])
        self.assertIn('uses: ./.github/actions/setup\n        with:\n          go: "true"\n          node: "true"', workflow)
        for forbidden in ('continue-on-error', '--no-sandbox', 'chromiumSandbox: false',
                          'sysctl', 'apparmor_parser', 'secrets.', 'pull_request_target:',
                          'scripts/ci_gate.py', 'scripts/verify.sh', '--pass-with-no-tests'):
            self.assertNotIn(forbidden, workflow)
        full = (ROOT / '.github/workflows/ci.yml').read_text()
        for reference in re.findall(r'uses: ([^\s]+)', workflow):
            if not reference.startswith('./'):
                self.assertRegex(reference, r'^[^@]+@[0-9a-f]{40}$')
                self.assertIn('uses: ' + reference, full)

    def test_named_synthetic_artifacts_have_cleanup_headroom(self):
        workflow = (ROOT / '.github/workflows/ux-recovery-focus.yml').read_text()
        upload = workflow.split('      - name: Supplemental recovery diagnostics for this commit\n', 1)[1]
        for expected in ('if: always()', 'name: ux-recovery-supplemental-${{ github.sha }}',
                         'retention-days: 7', 'if-no-files-found: warn'):
            self.assertIn(expected, upload)
        paths = upload.split('path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        self.assertEqual({line.strip() for line in paths.splitlines()}, ARTIFACTS)

    def test_artifact_globs_match_observed_output_names_without_private_files(self):
        workflow = (ROOT / '.github/workflows/ux-recovery-focus.yml').read_text()
        paths = workflow.split('          path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        patterns = [line.strip() for line in paths.splitlines()]
        def retained(path):
            return any(PurePosixPath(path).match(pattern) for pattern in patterns)
        # Real Chrome artifact directory names from /tmp/route-07-browser4.
        # Playwright retains/truncates the .ui suffix before the title hash.
        observed = {
            'template-target-identity.u-a4321--duplicate-draft-at-390x560-chromium': (
                'client-profile-390-selected.png', 'client-profile-390-selected-ledger.json'),
            'template-target-identity.u-31d27--duplicate-draft-at-390x560-chromium': (
                'processing-preset-390-selected.png', 'processing-preset-390-selected-ledger.json'),
            # Representative Admin output directories, not claimed observed runs.
            'admin-validation-recovery.ui-retry-state-at-390x560-chromium': (
                'failed-0.png', 'pending-1.json', 'result-0.png', 'request-ledger.json'),
            'admin-validation-order.ui-result-at-1440x560-chromium': (
                '0-latest-result.png', 'older-did-not-replace.json', 'final-state.png', 'request-ledger.json'),
        }
        # Representative compact-picker directories, not claimed browser runs.
        compact_outputs = tuple(f'{phase}.{ext}' for phase in COMPACT_PHASES
                                for ext in ('png', 'json')) + ('capture-failure.json',)
        for width in (1440, 390):
            observed[f'compact-choice-keyboard.ui-pickers-at-{width}x560-chromium'] = compact_outputs
        multi_outputs = tuple(f'{phase}.{ext}' for phase in MULTI_PHASES
                              for ext in ('png', 'json')) + ('request-ledger.json',)
        for width in (1440, 390):
            observed[f'multi-choice-reopening.ui-task-at-{width}x560-chromium'] = multi_outputs
        for directory, filenames in observed.items():
            for filename in filenames:
                path = f'web/test-results/{directory}/{filename}'
                with self.subTest(path=path):
                    self.assertTrue(retained(path), path)
            for filename in ('live.db', 'live.db-wal', 'trace.zip', 'video.webm',
                             'master.key', 'fixture-key.json', 'storage-state.json',
                             'error-context.md', 'client-profile-390-selected.key',
                             'request-ledger.db', 'final-state.zip', 'arbitrary.json',
                             'arbitrary.png', 'protocol-cancel-private.json',
                             'transport-cancel-private.png', 'protocol-cancel.key',
                             'protocol-cancel.png.zip', 'capture-failure.png',
                             'same-trigger-reopened-private.json', 'preview-draft.key',
                             'request-ledger.png'):
                path = f'web/test-results/{directory}/{filename}'
                with self.subTest(path=path):
                    self.assertFalse(retained(path), path)

        # A named compact capture is not an upload permission for another fixture.
        for filename in compact_outputs + multi_outputs:
            path = f'web/test-results/unrelated.ui-chromium/{filename}'
            with self.subTest(path=path):
                self.assertFalse(retained(path), path)

    def test_config_inherits_servers_and_sandbox_without_overriding_fixtures(self):
        config = (ROOT / 'web/playwright.ux-recovery.config.ts').read_text()
        for expected in ('import shared from "./playwright.config"', '...shared,', '...project,',
                         '.filter((project) => project.name === "chromium")', 'workers: 1', 'retries: 0'):
            self.assertIn(expected, config)
        for forbidden in ('webServer:', 'launchOptions:', 'use:', 'testIgnore:', 'grep:', 'grepInvert:', 'timeout:'):
            self.assertNotIn(forbidden, config)
        self.assertEqual(set(re.findall(r'"\*\*/([^"/]+)\.ui\.spec\.ts"', config)), SPECS)
        shared = (ROOT / 'web/playwright.config.ts').read_text()
        for expected in ('chromiumSandbox: true', 'trace: "off"', 'screenshot: "off"'):
            self.assertIn(expected, shared)
        for name in SPECS:
            self.assertTrue((ROOT / 'web/tests' / f'{name}.ui.spec.ts').is_file())


if __name__ == '__main__':
    unittest.main()

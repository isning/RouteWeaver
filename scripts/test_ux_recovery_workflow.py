"""The recovery lane is supplemental; browser safety and required gates stay intact."""
from pathlib import Path, PurePosixPath
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPECS = {
    'admin-policy-inventory-recovery',
    'announcement-list-recovery',
    'users-inventory-read-recovery',
    'initial-resource-read-recovery',
    'diagnostic-target-submit-focus',
    'usage-reset-ownership',
    'group-priority-draft-continuity',
    'server-json-recovery', 'workspace-return', 'notification-channel-journey',
    'template-target-identity', 'admin-validation-recovery', 'admin-validation-order',
    'compact-choice-keyboard', 'multi-choice-reopening', 'fleet-request-recovery', 'group-access-decision', 'route-inventory-recovery', 'admin-settings-isolation', 'entry-route-identity', 'route-account-identity', 'backup-tab-continuity', 'profile-read-recovery', 'resource-source-inventory-recovery',
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
INVENTORY_PHASES = (
    'resource-initial-unknown',
    'resource-cached-error',
    'resource-retry-keyboard',
    'resource-reconciled-empty',
    'source-cached-error',
    'source-detail-cached',
    'source-detail-retry-keyboard',
    'source-detail-reconciled',
    'final-original',
)
GROUP_PRIORITY_PHASES = (
    'raw-input',
    'discard-decision',
    'continued-draft',
    'blocked-preview',
    'final-original',
)
RESET_PHASES = ('reason-draft', 'reset-review', 'reset-canceled', 'discard-review', 'draft-continued', 'reopened-clean', 'navigation-review', 'navigation-stayed', 'navigation-left', 'forward-clean', 'pending-reset', 'navigation-after-reset', 'success-stayed', 'success-left', 'final-original')
TARGET_REGISTRATION_PHASES = ('invalid-name', 'invalid-url', 'invalid-methods', 'save-rejected', 'discard-review', 'continued-draft', 'reopened-clean', 'returned-opener', 'final-original')
USERS_PHASES = ('cached-error-open-menu', 'retry-keyboard', 'retry-pending', 'recovered-search-keyboard', 'recovered-entry-keyboard', 'correct-user-entry', 'final-original')
INITIAL_RESOURCE_PHASES = ('retry-keyboard', 'retry-pending', 'repeated-error', 'failure-next-tab', 'recovered', 'success-next-tab', 'newer-dialog-pending', 'dialog-owned', 'final-original')
ANNOUNCEMENT_PHASES = ('initial-unknown', 'refresh-pending', 'cached-error', 'retry-keyboard', 'retry-pending', 'recovered', 'fresh-edit', 'newer-create-pending', 'newer-create-owned', 'final-original')
POLICY_INVENTORY_PHASES = ('cached-error', 'retry-keyboard', 'retry-pending', 'recovered', 'guarded-editor', 'newer-draft-pending', 'newer-draft-owned', 'final-original')
ARTIFACTS = {
    *{f'web/test-results/admin-policy-inventory-rec-*/policy-inventory-{phase}.{ext}'
      for phase in POLICY_INVENTORY_PHASES for ext in ('png', 'json')},
    'web/test-results/admin-policy-inventory-rec-*/policy-inventory-request-ledger.json',
    *{f'web/test-results/announcement-list-recovery*/announcement-{phase}.{ext}'
      for phase in ANNOUNCEMENT_PHASES for ext in ('png', 'json')},
    'web/test-results/announcement-list-recovery*/announcement-request-ledger.json',
    *{f'web/test-results/initial-resource-read-recovery*/initial-resource-{phase}.{ext}'
      for phase in INITIAL_RESOURCE_PHASES for ext in ('png', 'json')},
    'web/test-results/initial-resource-read-recovery*/initial-resource-request-ledger.json',
    *{f'web/test-results/users-inventory-read-recovery*/users-inventory-{phase}.{ext}'
      for phase in USERS_PHASES for ext in ('png', 'json')},
    'web/test-results/users-inventory-read-recovery*/users-inventory-request-ledger.json',

    *{f'web/test-results/diagnostic-target-submit-focus*/{phase}.{ext}'
      for phase in TARGET_REGISTRATION_PHASES for ext in ('png', 'json')},
    'web/test-results/diagnostic-target-submit-focus*/request-ledger.json',
    *{f'web/test-results/usage-reset-ownership*/{phase}.{ext}'
      for phase in RESET_PHASES for ext in ('png', 'json')},
    'web/test-results/usage-reset-ownership*/request-ledger.json',
    'web/playwright-report/',
    *{f'web/test-results/group-priority-draft-continuity*/{phase}.{ext}'
      for phase in GROUP_PRIORITY_PHASES for ext in ('png', 'json')},
    'web/test-results/group-priority-draft-continuity*/request-ledger.json',
    *{f'web/test-results/resource-source-inventory-recovery*/{phase}.{ext}'
      for phase in INVENTORY_PHASES for ext in ('png', 'json')},
    'web/test-results/resource-source-inventory-recovery*/request-ledger.json',
    'web/test-results/group-access-decision*/group-access-*.png',
    'web/test-results/group-access-decision*/group-access-evidence-*.json', 'bin/verification/browser-environment.json',
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
                      'name: Twenty-four recovery specs (supplemental evidence only)',
                      'name: Run twenty-four recovery specs with unchanged fixtures',
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
        inventory_outputs = tuple(f'{phase}.{ext}' for phase in INVENTORY_PHASES
                                  for ext in ('png', 'json')) + ('request-ledger.json',)
        for width in (1440, 390):
            for scenario in ('resource', 'source-changed', 'source-removed'):
                observed[f'resource-source-inventory-recovery.ui-inventory-read-recovery-{scenario}-at-{width}px-chromium'] = inventory_outputs
        group_priority_outputs = tuple(f'{phase}.{ext}' for phase in GROUP_PRIORITY_PHASES
                                       for ext in ('png', 'json')) + ('request-ledger.json',)
        for width in (1440, 390):
            for scenario in ('minus', 'exponent'):
                observed[f'group-priority-draft-continuity.ui-{scenario}-at-{width}px-chromium'] = group_priority_outputs
        reset_outputs = tuple(f'{phase}.{ext}' for phase in RESET_PHASES
                              for ext in ('png', 'json')) + ('request-ledger.json',)
        for width in (1440, 390):
            observed[f'usage-reset-ownership.ui-reset-review-at-{width}px-chromium'] = reset_outputs
        target_outputs = tuple(f'{phase}.{ext}' for phase in TARGET_REGISTRATION_PHASES
                               for ext in ('png', 'json')) + ('request-ledger.json',)
        for width in (1440, 390):
            for mode in ('invalid', 'rejection'):
                observed[f'diagnostic-target-submit-focus.ui-{mode}-at-{width}px-chromium'] = target_outputs
        users_outputs = tuple(f'users-inventory-{phase}.{ext}' for phase in USERS_PHASES
                              for ext in ('png', 'json')) + ('users-inventory-request-ledger.json',)
        for width in (1440, 390):
            observed[f'users-inventory-read-recovery.ui-continuity-at-{width}px-chromium'] = users_outputs
        initial_resource_outputs = tuple(f'initial-resource-{phase}.{ext}' for phase in INITIAL_RESOURCE_PHASES
                                         for ext in ('png', 'json')) + ('initial-resource-request-ledger.json',)
        for scenario in ('retry', 'newer-dialog'):
            observed[f'initial-resource-read-recovery.ui-{scenario}-at-1440px-chromium'] = initial_resource_outputs
        announcement_outputs = tuple(f'announcement-{phase}.{ext}' for phase in ANNOUNCEMENT_PHASES
                                     for ext in ('png', 'json')) + ('announcement-request-ledger.json',)
        for width in (1440, 390):
            for scenario in ('retry', 'newer-create'):
                observed[f'announcement-list-recovery.ui-{scenario}-at-{width}px-chromium'] = announcement_outputs
        policy_outputs = tuple(f'policy-inventory-{phase}.{ext}' for phase in POLICY_INVENTORY_PHASES
                               for ext in ('png', 'json')) + ('policy-inventory-request-ledger.json',)
        # Actual directory names from 5b65a44 shard3, not invented full stems.
        for directory in (
            'admin-policy-inventory-rec-1c4a9-ory-service-retry-at-1440px-chromium',
            'admin-policy-inventory-rec-48a3e-vice-stale-editor-at-1440px-chromium',
            'admin-policy-inventory-rec-be5b3-ntory-group-retry-at-1440px-chromium',
            'admin-policy-inventory-rec-50ee3-roup-stale-editor-at-1440px-chromium',
            'admin-policy-inventory-rec-a5e91-tory-service-retry-at-390px-chromium',
            'admin-policy-inventory-rec-04790-rvice-stale-editor-at-390px-chromium',
            'admin-policy-inventory-rec-77311-entory-group-retry-at-390px-chromium',
            'admin-policy-inventory-rec-7aadc-group-stale-editor-at-390px-chromium',
        ):
            observed[directory] = policy_outputs
        for filename in ('request-ledger.json', 'policy-inventory-private.json',
                         'policy-inventory-request-ledger.png', 'policy-inventory-retry-pending-private.png',
                         'policy-inventory-retry-offline.png', 'policy-inventory-retry-offline.json'):
            self.assertFalse(retained(f'web/test-results/admin-policy-inventory-rec-1c4a9-ory-service-retry-at-1440px-chromium/{filename}'))
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

        # Generic ledgers and extra user-like names are not authorized captures.
        for filename in ('request-ledger.json', 'users-inventory-private.json', 'users-inventory-request-ledger.png'):
            self.assertFalse(retained(f'web/test-results/users-inventory-read-recovery.ui-chromium/{filename}'))

        for filename in ('request-ledger.json', 'initial-resource-private.json',
                         'initial-resource-request-ledger.png', 'initial-resource-retry-pending-private.png'):
            self.assertFalse(retained(f'web/test-results/initial-resource-read-recovery.ui-chromium/{filename}'))

        for filename in ('request-ledger.json', 'announcement-private.json',
                         'announcement-request-ledger.png', 'announcement-retry-pending-private.png'):
            self.assertFalse(retained(f'web/test-results/announcement-list-recovery.ui-chromium/{filename}'))

        # A named compact capture is not an upload permission for another fixture.
        for filename in compact_outputs + multi_outputs + inventory_outputs + group_priority_outputs + reset_outputs + target_outputs + users_outputs + initial_resource_outputs + announcement_outputs + policy_outputs:
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

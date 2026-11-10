"""Supplemental visual feedback must retain the authoritative Chrome safeguards."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class UXVisualWorkflowTests(unittest.TestCase):
    def test_chrome_provenance_and_sandbox_block_matches_required_ci_exactly(self):
        full = (ROOT / '.github/workflows/ci.yml').read_text()
        focused = (ROOT / '.github/workflows/ux-visual-focus.yml').read_text()
        start = '      - name: Verify installed Chrome Stable and sandboxed startup\n'
        def block(text):
            return text.split(start, 1)[1].split('\n      - ', 1)[0]
        self.assertEqual(block(focused), block(full))


    def test_workflow_is_bounded_branch_only_supplemental_feedback(self):
        workflow = (ROOT / '.github/workflows/ux-visual-focus.yml').read_text()
        self.assertEqual(workflow.split('on:\n', 1)[1].split('\npermissions:', 1)[0].strip(),
                         "push:\n    branches:\n      - 'ux-task-journeys-20261108'")
        self.assertIn('group: ux-visual-${{ github.ref }}', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(re.findall(r'^  ([a-z_]+):$', workflow.split('jobs:\n', 1)[1], re.M), ['visual'])
        for expected in ('contents: read', 'persist-credentials: false', 'runs-on: ubuntu-24.04',
                         'timeout-minutes: 12', 'timeout-minutes: 8',
                         'name: Three UX journeys (supplemental evidence only)',
                         'ROUTEWEAVER_CHROMIUM: /opt/google/chrome/chrome',
                         'npx --no-install playwright install-deps chromium',
                         '--config=playwright.ux-visual.config.ts --workers=1 --retries=0'):
            self.assertIn(expected, workflow)
        for forbidden in ('continue-on-error', '--no-sandbox', 'chromiumSandbox: false',
                          'sysctl', 'apparmor_parser', 'secrets.', 'workflow_dispatch:',
                          'pull_request_target:', 'strategy:', 'scripts/ci_gate.py',
                          'scripts/verify.sh', '--pass-with-no-tests'):
            self.assertNotIn(forbidden, workflow)
        required = (ROOT / '.github/workflows/ci.yml').read_text()
        for reference in re.findall(r'uses: ([^\s]+)', workflow):
            if not reference.startswith('./'):
                self.assertRegex(reference, r'^[^@]+@[0-9a-f]{40}$')
                self.assertIn('uses: ' + reference, required)
        self.assertIn('uses: ./.github/actions/setup\n        with:\n          go: "true"\n          node: "true"', workflow)

    def test_artifacts_are_always_attempted_and_scoped_to_synthetic_evidence(self):
        workflow = (ROOT / '.github/workflows/ux-visual-focus.yml').read_text()
        upload = workflow.split('      - name: Supplemental visual diagnostics for this commit\n', 1)[1]
        self.assertIn('if: always()', upload)
        self.assertIn('name: ux-visual-supplemental-${{ github.sha }}', upload)
        self.assertIn('retention-days: 7', upload)
        self.assertIn('if-no-files-found: warn', upload)
        paths = upload.split('path: |\n', 1)[1].split('          if-no-files-found:', 1)[0]
        self.assertEqual({line.strip() for line in paths.splitlines()}, {
            'web/playwright-report/', 'bin/verification/browser-environment.json',
            'web/test-results/*/path-*.png', 'web/test-results/*/duplicate-server-*.png',
            'web/test-results/*/setup-*.png', 'web/test-results/*/setup-*.json',
            'web/test-results/*/invitation-*.png', 'web/test-results/*/signup-correction-*.png',
            'web/test-results/*/grant-*.png', 'web/test-results/*/authorized-service-*.png',
            'web/test-results/*/first-profile-*.png', 'web/test-results/*/publication-review-*.png',
            'web/test-results/*/subscription-delivered-*.png', 'web/test-results/*/persisted-subscription-*.png',
        })

    def test_config_inherits_sandbox_and_selects_only_three_isolated_specs(self):
        config = (ROOT / 'web/playwright.ux-visual.config.ts').read_text()
        self.assertIn('import shared from "./playwright.config"', config)
        self.assertIn('...shared,', config)
        self.assertIn('...project,', config)
        self.assertIn('.filter((project) => project.name === "chromium")', config)
        for expected in ('webServer: []', 'workers: 1', 'retries: 0'):
            self.assertIn(expected, config)
        for forbidden in ('launchOptions:', 'use:', 'testIgnore:', 'grep:', 'grepInvert:'):
            self.assertNotIn(forbidden, config)
        specs = {'server-path-workspace.ui.spec.ts', 'forwarding-setup-backend.ui.spec.ts',
                 'invitation-subscription.ui.spec.ts'}
        self.assertEqual(set(re.findall(r'"\*\*/([^"/]+)"', config)), specs)
        for name in specs:
            source = (ROOT / 'web/tests' / name).read_text()
            self.assertIn('from "./isolated-control-plane-fixture"', source)
            self.assertIn('trace: "off"', source)
            self.assertIn('screenshot: "off"', source)
            self.assertIn('video: "off"', source)

if __name__ == '__main__':
    unittest.main()

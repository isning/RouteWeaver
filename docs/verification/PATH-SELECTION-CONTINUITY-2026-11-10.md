# Forwarding-path selection continuity, 2026-11-10

## Observed defect and correction

On parent source `839667b5955969d8593703effc96902139293aec`, a real cloud-browser journey created a synthetic server, core and listener through the UI, then opened a forwarding path from that listener. After adding a second hop and selecting a server, switching from sequence editing to graph editing and back silently removed the unfinished hop and re-enabled Save.

The inactive editing-mode tab now remains unavailable until the current endpoint choice is completed or explicitly cancelled. A short visible explanation is linked to both tabs with `aria-describedby`. The handler also checks the same condition, and in-flight endpoint reads prevent switching in either direction. Existing committed paths still switch normally. This is a bounded interaction correction, not a redesign or a new deployment action.

## Verification

- New component task fails before the change and passes after it. It covers first-hop partial server choice, a pending added hop, unchanged input after attempted switching, explicit cancellation, normal switching afterward, and Save availability.
- 45 focused tests pass across route graph, mixed editor, mixed workspace and legacy workspace suites, with one worker.
- TypeScript check, production build, private-file inventory guard and whitespace check pass. The private-file inventory guard is not a secret-content scan.
- Independent read-only diff review found no blocking issue. It noted delayed-reveal coverage as a follow-up.
- Real cloud-browser sample-data task reproduced the old defect and checked the correction, keyboard ArrowRight staying on the active tab, explicit cancellation, graph/sequence switching, and successful draft save against the real local backend. No endpoint was applied or enrolled.

## Limits

Standalone Chromium launch is unavailable in this sandbox. The supported internal preview and cloud browser were used instead, without disabling browser security. Automated browser-suite, complete keyboard/assistive-technology coverage, full repository gates and CI completion are not claimed. All data is synthetic. No live nodes, user account data, Cloudflare screenshots or production deployment are involved.

## Follow-up: rename during endpoint resolution

A deferred-response component task exposed a second failure: replace the listener with another listener on the same server, then rename the path before the reveal returns. Previously the name edit cancelled the new selection, re-enabled Save, and allowed the old endpoint to be saved. The regression fails on that premature Save availability before the correction.

Name edits now preserve the pending topology request. Completion merges the latest display name while keeping the topology revision fence, IR identity check and endpoint ownership checks. Both ordered and graph completion paths retain the latest name. The new test checks the actual saved name and endpoint, plus the delayed-read explanation and disabled view switch. Independent review found no blocking race, privacy or consistency concern. Failed-reveal and graph-specific rename-race browser scenarios were not covered by this test.

83 focused tests pass across graph, mixed path editor/workspace, legacy path workspace, first-path entry, listener-revision and TLS-editor suites. The full web gate is tracked separately; these focused passes do not imply its result.

## Narrow viewport review

The real app was also inspected in a 390 × 844 same-origin frame in the cloud browser. Pending choices remain visible, inactive graph editing stays disabled, keyboard ArrowRight does not leave sequence editing, and explicit cancellation restores the action and focus to Add next hop. The sampled fields, explanation and fixed footer remain readable without page-level horizontal overflow. This is a constrained viewport review, not mobile-device certification or a full accessibility audit. Requested captures contain synthetic demo data only and are not committed to the repository.

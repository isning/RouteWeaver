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

## Completed two-hop browser journey

Using the same isolated demo backend, the browser created a second synthetic server, core and listener through the UI. It completed the second-hop server/endpoint choice, switched graph → sequence without losing either hop, moved the second hop up and back down, renamed the path, and saved the draft. After a full page reload, reopening the editor retained the new name and the exact first-hop → second-hop order. The saved forwarding summary pointed the first listener to the second server, and left the final listener direct. Nothing was applied to a core.

## Final local web gate

On source commit `206aedef5805157fc256b38201b9ec7b604f66f2`, `scripts/verify.sh web` completed successfully: TypeScript checking, all **286 files / 3,602 tests** in 806.05 seconds with one worker, and the production build. Test stderr included jsdom's existing `Window.scrollTo()` not-implemented notices; there were no failed tests. The changes after this run are verification-document updates only. This named web pass does not establish automated browser-suite, backend/native, deployed or full-project acceptance. Remote CI was not a prerequisite for either implementation push.

## Secret-content verification

The first secrets gate correctly refused to scan incomplete shallow-clone history. After fetching the complete public branch history, `scripts/verify.sh secrets` passed: 30 scanner regressions and the checksum-pinned Gitleaks 8.24.3 source/index/reachable-history scan (4,115 distinct path/content pairs, 8,748 source entries). Existing exact path/rule/line false-positive reviews were retained; no path-wide exemption was added. This checks plaintext source patterns, not credential validity, encrypted/archive content or unreachable history, and is not a security certification. Only the two source files and this verification document are part of this work's public changes.

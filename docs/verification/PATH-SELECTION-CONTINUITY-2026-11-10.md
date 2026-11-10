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

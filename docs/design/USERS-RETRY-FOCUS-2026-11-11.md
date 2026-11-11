# Users cached-read retry keyboard continuity

## Finding and scope

The cached Users inventory retry used a native disabled button during a GET. Browser evidence reviewed by the coordinator showed focus falling to BODY at both narrow and desktop sizes. The source also used the default cached-query refetch behavior, which can cancel/restart a read under same-turn repeated activation.

This change is limited to the cached Users recovery action. Initial-load QueryState behavior and unrelated inventories are unchanged. Fresh-read authority remains `query.isSuccess && query.fetchStatus === "idle"`; stale row editing, entries, and menus stay fenced.

## Interaction decision

- Follow the existing AccountingRecovery/Outbox action pattern: pending and aria-disabled/aria-busy feedback without native disabling, plus `cancelRefetch: false` for same-turn deduplication.
- Keep focus on the retry throughout fetching, offline pause, and renewed failure.
- When success removes the error notice, transfer focus to the retained Users search only if that retry still owned focus immediately before removal. Capture ownership with stable React 19 ref cleanup, then apply the handoff after the commit. The search must still be connected, visible to accessibility, and outside an inert subtree, the Users page must have fresh authority, and BODY must be the current focus. A newer search or dialog interaction retains its own focus.
- Keep search text and pagination; do not enable stale mutations or introduce a generic focus abstraction.

## Verification

Public seam: real AdminPage, table, dialogs, and shared action controls; controlled fetch boundary and unavailable layout shims only. No component mocks.

- Red tracer: 5 existing Users cases passed, 1 new case failed because the pending retry was natively disabled (expected false, received true).
- Green: Users file passed 9/9, including same-turn double click, repeated Enter/Space/click, one held GET, controlled failure then success, retained page-two search and row fences, newer search/dialog ownership after success and failure, and offline pause/resume.
- Related focused run: 50/50 across Users inventory, Resources inventory, Sources inventory, Fleet continuous service, and asynchronous action accessibility (one worker).
- `npm run typecheck` passed. `git diff --check` passed.

These are DOM behavioral and type checks, not browser layout or cross-browser evidence. No browser was launched, no full suite rerun was performed by this worker, and no publication/deployment occurred. Real browser focus/viewport verification remains a separate delivery gate.

## Native sampler extension (execution pending)

The existing loopback-only Users sampler at 390×560 and 1440×900 now checks pending retry focus/focus-visible/viewport/hit geometry, non-native-disabled plus aria-disabled/aria-busy semantics, and exactly one held services GET after repeated ordinary Enter/Space activation. After release, it captures the original success viewport before further keyboard navigation and checks that search receives focus and the retry notice is removed. Existing stale action gates, correct-user entry task, screenshot-before-geometry ordering, strict API allowlist, mutation blocking, and final evidence capture remain intact. No script focus or scrolling was added.

Playwright discovery recognizes both viewport cases; standalone spec TypeScript checking passes. The sampler uses the real App query defaults (`retry: 1`) and requires at least two failed inventory reads before recovery, rather than disabling automatic retry. A renewed failure/backoff after manual activation is not separately exercised by this native fixture. Native browser execution is not available locally and remains unrun; these new assertions require CI. Same-turn duplicate activation, controlled renewed failure, offline resume, and newer search/dialog focus remain covered by DOM tests rather than a claimed native run.

# Page-load recovery without automatic refresh

## Observed defect and scope

The coordinator observed a blank workspace after a static build replaced an unopened lazy page's asset. The browser reported a failed dynamic import of the previous Published Routes chunk; an explicit reload recovered it. This change adds a page-region error boundary inside the authenticated shell, around the existing Suspense region. Navigation, the header and account controls remain outside the failed page. It does not change deployment retention or fetch/cache behavior.

Lazy page loaders tag import failures explicitly, without guessing browser error wording. Import failure shows a concise connection/version explanation and an explicit “刷新工作空间” button. React caches rejected lazy imports, and an obsolete content-hashed URL cannot reliably be fixed by remounting the same lazy component, so this case deliberately does not offer a misleading in-place retry. Render failures have separate copy and an in-place “重新打开页面” action, plus manual refresh. Selecting a different navigation page creates a fresh boundary.

There is no automatic reload or retry. Recovery captures dirty state before failed descendants unmount, and also checks current dirty state before an action. Recovering with unsaved work requires confirmation, with the non-destructive option focused. Still-mounted shell drafts survive cancelling recovery. A draft inside an already crashed subtree cannot be recovered by an error boundary; the message states that limitation rather than promising restoration. Raw exception details and stacks are not included in the UI.

## Verification

- Red: a public page-boundary DOM harness with a genuinely rejected React lazy import produced one failing test and an uncaught error without the boundary. The harness's shell was removed.
- Green: `npm test -- --maxWorkers=1 src/page-recovery.dom.test.tsx src/access-policy.dom.test.tsx`: 24 passed, including 5 page recovery tests. Default timeouts, no assertion skips.
- Coverage: rejected import containment; navigation after failure; no automatic refresh; manual refresh; separate rendering-error copy; repeated render failure then local recovery; hidden technical exception details; pre-crash dirty-state capture; confirmation cancellation and acceptance for retry and refresh; default Cancel focus and Enter safety; preservation of a still-mounted shell draft.
- `npm run typecheck`: passed.
- `npm run build`: passed, with the existing large-chunk warning.
- `git diff --check`: passed.

This worker did not run the full web suite, browser automation, live account operations, or backend/native checks. The coordinator owns centralized full-suite and actual-browser verification. No independent code review was completed for this boundary.

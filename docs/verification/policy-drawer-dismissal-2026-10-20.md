# Policy editor dismissal protection

## Scope

Service Offering and individual Entitlement drawers now route Cancel, close button, Escape and mask dismissal through the existing policy draft state and Ant Design confirmation pattern. Clean drafts close immediately. Changed drafts require explicit discard; continuing editing preserves the entered values. Preview and apply requests block dismissal until they settle. Successful application closes directly without a discard prompt. Failed applications retain the draft and normal review/edit recovery.

The individual editor now owns the policy controller at drawer level, so its outer dismissal controls and inner form use the same pending/dirty state. The standalone public form remains supported. User-group dismissal, reset-reason drafts, other editors and backend policy semantics are outside this change.

## Evidence

- Red: two new public editor DOM flows demonstrated that Cancel immediately called close for edited service and user drafts; 2 failed and the 5 existing tests passed.
- Green: `npm test -- --maxWorkers=1 src/access-policy.dom.test.tsx`: 19 tests passed, using default timeouts. Coverage includes both editors' clean cancellation, dirty cancel/close/Escape/mask, continue-edit preservation, explicit discard, preview/apply pending dismissal blocking, successful save, failed apply and review cancellation.
- The HTTP boundary is replaced by deterministic fixtures; actual React forms, drawers, queries and policy dialogs run. No live policy mutation occurred.
- Ant's test environment forces every portal ID to `test-id`; asynchronous mounting of the user's closed review modal then incorrectly removes the drawer's Escape stack entry. The tests use development-mode real React IDs and restore the environment after each test. No application workaround or internal collaborator mock was introduced.
- `npm run typecheck`: passed.
- `npm run build`: passed; existing large-chunk warning remains.
- `git diff --check`: passed.
- `scripts/verify.sh static`: passed after supplying the relocated official Go compiler via `ROUTEWEAVER_GO`; tracked-file exclusion, ticket DAG, 9 negative Python fixtures, architecture negative fixtures and production import direction checks passed. The first attempt stopped at the missing default compiler path, not an application failure.

The full web suite was interrupted with SIGINT at the coordinator's request because concurrent suites caused resource pressure elsewhere. It is not recorded as passing. The coordinator will run one central full suite after integration. Browser visual/keyboard verification, backend/native gates and independent review were not performed by this worker.

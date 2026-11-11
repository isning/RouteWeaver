# Users inventory read recovery

Base: `55f9615`. A services-only background read failure replaced the cached
Users table with the generic error state. Search controls disappeared and table
pagination remounted at page one after recovery, despite retained user data.

## Correction

The Users page now retains its mounted cached table and search through a failed
read. An explicit notice identifies the retained inventory and provides retry.
Pending/offline reconciliation has a visible status. Without cached data, initial
failure remains unknown; cached zero users is not presented as authoritative
empty during failure, refresh or offline reconciliation. Other pages and shared
QueryState semantics are unchanged.

Row entry, edit and authorization controls require a successful, idle combined
inventory read. Open menu items are disabled during recovery; a current-readiness
ref also fences a callback invoked while the latest rendered query is unready.
Independent creation actions and already-open editors retain their existing
behavior and drafts. This is not a general stale-save or request-cancellation fix.

## Evidence

Five public real-Admin regressions use intercepted HTTP only. They cover searched
page-two continuity through services failure, pending retry, initial failure,
offline cached-empty state, disabled open-menu actions, and correct user-specific
entry/authorization reads after recovery. No non-GET request is permitted.

- Initial baseline: four failures and one pass. A strengthened tracer first waits
  for the common HTTP error, then fails directly at the missing search control
  on the baseline. It does not depend on the new notice copy for its red result.
- Corrected final focused run: 5/5 passed in 4.33 seconds.
- Related nine-file run: 130/130 passed in 44.71 seconds; this preceded only the
  strengthened assertion ordering, with production code unchanged.
- Production typecheck/build and whitespace validation passed.
- Independent source review accepted bounded behavior and scope.

The selected-menu-item/closing-animation race is not behavior-proven. The
readiness ref is not a guarantee of latest-record freshness after a fast
successful refresh: a pre-existing queued closure can still capture older row
fields. Already-open editor reconciliation remains outside this slice. No
native-browser/pixel acceptance or complete aggregate pass is claimed yet.
No deployment or real-user mutation was performed.

Final serialized local aggregate at production/DOM checkpoint `0cbc9fa` passed
**4,105/4,105 tests across 331 files** in 1,163.31 seconds. Native preparation
`bdeab243` adds no production/DOM changes; its separate execution remains unrun.
Later Sheet, compact-tab and copy changes require their own full aggregate.

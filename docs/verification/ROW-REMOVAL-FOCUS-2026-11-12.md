# Row removal: completed-action focus

## Scope

Nodes and legacy-route row deletion now return keyboard focus to the surviving inventory search after successful confirmation. The explicit success destination belongs to the mounted page visit. Cancellation and failed deletion retain ordinary opener restoration. Newer tasks, navigation, claimed close events, and unavailable destinations retain their focus guards. No additional DELETE, awaited refresh, late focus watcher, or global fallback was introduced.

The baseline public AdminPage flows reproduced four failures with fourteen passing controls: after a successful command, a later inventory response removed the row-menu opener and left focus on the document body. The candidate adds fifty-two focused regression cases across AdminPage and confirmation lifecycle tests.

## Verification

The independently reviewed five-file patch, SHA256 `5efd22d89c165f7ecb77b185288aed390d519b489ebb6cc765ddcf3c41f5637f`, was integrated against `2d0c3db3e13630731d0cb5d81d300383a549a9ac`. All five integrated file hashes matched the reviewed manifest. Independent source review found no actionable Standards or Spec findings within this scope; the reviewer did not independently rerun tests.

Integrated verification on 2026-11-12:

- 138 tests passed across seven focused files, serialized with one worker (32.09 seconds).
- Typecheck passed.
- Production build passed.
- Patch whitespace checks passed.

The focused files cover row removal, confirmation success destination, overlay lifecycle, missing-opener fallback, inventory keyboard continuity, session departure, and return-target visibility. The previous full frontend result of 4567 tests across 356 files predates this patch and does not validate these new changes. Full regression and native browser/pixel acceptance remain pending. No Go or deployment claim is made.

## Separately tracked refresh failure

A successful deletion followed by a failed inventory refresh can still replace the entire Nodes/legacy-route content, unmount the search, and lose focus. A separate two-case DOM audit reproduces this. The command remains successful, the confirmation closes, and no second DELETE occurs. This patch deliberately does not claim to repair that cached-view/error-state behavior. A follow-up must retain useful cached context while preventing stale row edits and duplicate retry reads; merely hiding the error would not be safe.

## Completed frontend aggregate

The serialized full frontend aggregate subsequently passed against source commit `31f2c5dc2359735feb8683c233cdcc87b521b0cf` on 2026-11-12: **4619 tests across 358 files**. Shard 1 passed 2386 tests across 179 files in 630.22 seconds for the full shard command; shard 2 passed 2233 tests across 179 files in 652.11 seconds. Each shard also passed typecheck and production build. This supersedes the pending full-frontend status above for this source commit only. The separate cached-inventory candidate was isolated and is not covered by this aggregate. Native/pixel acceptance and remote publication remain pending.

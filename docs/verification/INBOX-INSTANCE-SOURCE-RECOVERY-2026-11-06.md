# Inbox and instance observation source recovery

## Provenance and scope

Base: `2a7f5cc5838f165294fd3ed476f1436f69ab3213`. Reconstructed from source-demonstrable gaps associated with inventory labels v89 (Inbox retry), v131 (Inbox freshness), and v132 (instance observation polling). This is not a recovery of those historical patches, proof of parity, or reuse of historic pass results.

## Source findings and changes

- Inbox acknowledgement failures retained content but had no in-sheet retry. An explicit retry now targets the selected event; pending event IDs prevent duplicate writes. Success still requires server acknowledgement and list readback. Notification settings/numeric parsing are untouched.
- `internal/notifications/service.go` rechecks visibility and makes an existing read receipt idempotent. List bodies can change with announcement edits, and visible entries can disappear. The open sheet now uses the latest matching result, preserving and labelling the latest displayed snapshot if absent. Absence is described only as absence from the bounded current list, not proof of deletion or expiry.
- Cached list refresh/paused states are labelled, and open-sheet refresh/failure/absence does not masquerade as current content. Existing QueryState hides list data on errors. No new client-side authorization inference is introduced.
- Instance polling previously stopped for terminal phases and initial errors. Active transitions retain five-second polling; other states use thirty seconds while mounted, under existing query visibility/network defaults. Fetching/paused/error states label retained phase and service records as previous reads, preserving focused controls.
- `internal/httpapi/agent.go` GET state returns saved desired/observation records and a service-intent view. It does not measure current process liveness. The display labels platform records and node-report time rather than asserting current online status. No backend enforcement, service grant, node command, or live operation changes.

## Public regression sources

- `web/src/inbox-read-state.dom.test.tsx`: explicit acknowledgement retry, full body retention, open-message update/removal, cached refresh/failure; existing late-A/B and dismissal scenarios remain.
- `web/src/fleet-continuous-service.dom.test.tsx`: polling after observed/stopped/unregistered records, labelling previous records during refresh, initial error recovery.

Tests use rendered public components and fetch boundary responses. Clock-controlled polling cases are source proposals, not verified scheduling evidence. Browser motion/focus, real query-timer timing, network pauses, server visibility races, expired leases and independent reviewer acceptance remain unverified.

## Review and verification

Source self-review considered documented UI loading/error distinctions, preservation of notification numeric settings, idempotent acknowledgement contract, message ownership, bounded-list absence, and persisted versus live observation semantics. Independent final-diff review is required before integration. Pinned skills path was absent; recovered `skills/tdd.md`, `skills/tests.md`, and `skills/code-review.md` were read from the recovery directory. Existing public UI/task seams were reused.

`git diff --check` is the only executed check and only assesses whitespace. All behavioral tests, test discovery, type checking, lint, formatters, Go checks, Node/npm, browser review, servers, installs, network, uploads, pushes and deployment are UNRUN. No red/green or historical-pass claim is made. The code is source-only candidate work, not release acceptance.


## Independent review follow-up

The same-item guard in `25b560e` avoided resetting an active same-event observer, but it did not solve A pending, B pending, reopen A: a single mutation observer follows B. Acknowledgement errors now live in an event-keyed map populated by mutation-level callbacks, independent of the currently observed call. Pending IDs still prevent duplicate writes; opening/dismissing a sheet does not clear another event's outcome. An explicit attempt clears only its own error.

Retry and automatic acknowledgement require a successful, non-fetching, non-paused current list containing that unread event. The handler repeats the check, and sheet retry verifies selected identity. Removed or failed-refresh snapshots remain readable but do not enable retry. This is a UI guard, not authorization: the backend remains responsible for visibility checks and may still reject a race after a successful read.

Added source regressions cover deferred same-item close/reopen failure; A/B concurrent pending calls with late failures scoped to A; duplicate suppression; explicit retry; and disabled retry through pending reads, failed refreshes, or current-list removal. All remain UNRUN. No execution, typecheck, test-discovery, browser or formatting gate was run.


A further independent review identified that using QueryState loading for every background fetch unmounted the whole instance summary and its focused controls. QueryState now handles only initial loading/no-data errors. Existing records and controls stay mounted during background refresh, pause, and error, with an explicit previous-read notice; errors also expose their message and the existing refresh action remains available. Platform-record provenance remains visible. Added public source regressions retain focus on Refresh and expanded Details through a deferred background read and failure. These changes supersede the earlier hide-during-fetch approach; no runtime evidence is claimed.


A subsequent source review found that opening a cached unread message during a guarded background read could leave it without a mark-read action. The sheet now offers an explicit mark-read action for its retained unread entry, labels errors as retry, and exposes pending state per event. It is disabled until a successful, non-paused, non-fetching list includes the unread entry. A successful later list read does not automatically send a write; the user can explicitly mark it. Only list readback supplies readAt. A new deferred-read regression source checks no pre-fresh write, retained full content, explicit marking after refresh, and readback-driven read state. All behavioral checks remain UNRUN.

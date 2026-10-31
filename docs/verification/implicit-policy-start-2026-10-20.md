# Unset individual service start

## Evidence and semantics

The coordinator observed `0001-01-01T00:00:00Z` in the required service-start input for the demo administrator. `internal/store/effective_policy.go` constructs a missing entitlement with Go's zero start and a `none` cycle; `internal/service/effective.go` compares the start to the current time without synthesizing a new start. The reviewed preview/apply path stores the submitted entitlement. This is distinct from the legacy direct entitlement endpoint's initialization behavior. Replacing the value with the current time would therefore silently change intent.

The editor recognizes only Go's exact serialized zero sentinel, displays it as an optional empty input and explains that leaving it empty preserves the existing start and calendar. Submission restores the original sentinel, not now. Other timestamps remain visible and unchanged, including explicit offsets and nanosecond precision. Deliberately entering a new start changes only that field; the cycle is not re-anchored. Clearing a pre-existing explicit start is rejected instead of silently turning it into an implicit/new start.

Malformed, impossible-calendar and offset-free start values remain visible and produce an actionable validation error before preview. They are not relabeled as unset or normalized away.

## Date/time control assessment

Existing screens use native `datetime-local` inputs, but those do not carry an offset and cannot faithfully represent all existing RFC3339 nanosecond strings. A picker would require a deliberate timezone, precision and invalid-state conversion contract. This bounded sentinel fix retains explicit-offset entry rather than silently rewriting historical values or expanding into a timezone redesign. The help/error text shows the required timezone format. No new framework, library or backend semantics were introduced.

## Verification

- Red: the public UserPolicyEditor DOM flow expected an empty start but received the year-0001 sentinel (1 failing test).
- Green: `npm test -- --maxWorkers=1 src/access-policy.dom.test.tsx`: 26 tests passed with default timeouts.
- New coverage: implicit start presentation and optional submission; unchanged zero start/no-reset anchor through preview and apply; no reset request; exact offset/nanosecond preservation; deliberate start edit without cycle rewrite; visible invalid backend data and explicit correction; rejection of a cleared explicit start.
- `npm run typecheck` and `npm run build`: passed. Existing large-bundle warning remains.
- `git diff --check`: passed.

No live policies were changed. HTTP requests use test fixtures. Full web suite, real-browser verification and backend/native gates were not run by this worker; the coordinator owns integration verification. Backend preservation statements above are source inspection plus submitted HTTP payload evidence, not a newly executed backend test.

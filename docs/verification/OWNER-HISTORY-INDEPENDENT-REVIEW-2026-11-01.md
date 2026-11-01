# Independent owner-history index review

Scope: `9e5dee0` → `a4e2072`, then exact-trigger correction `c0581ab`.
Independent worktree: `review/owner-history`. Reviewed correction is `c1008e8`
there; production files are byte-identical to the author's `c0581ab`.

## Standards

No blocking repository-standard violation found. Membership remains derived,
HMAC-keyed, with AEAD-bound per-owner counts and a canonical/derived-generation
stamp. Canonical payloads and the unchanged exact reducer remain authoritative.
No plaintext owner history cache, domain/SQL boundary change, endpoint, or new
framework was introduced. Review used the repository AGENTS contract and pinned
code-review reference; this was one independent reviewer, not two parallel axes.

## Spec / correctness

One blocking issue was found and fixed: trigger name presence did not establish
that its installed definition still performed invalidation. Independent failing
regressions demonstrated:

1. Same-name no-op derived DELETE/owner UPDATE triggers, membership deletion, and
   replay of an older authenticated count returned raw 7 rather than canonical 11.
2. A same-name no-op canonical INSERT trigger hid a new ledger fact (7 vs 11).
3. A same-name no-op canonical UPDATE trigger let an old authenticated owner
   payload be replayed after an ordinary owner move, returning false zero (0 vs 7).

`c0581ab` checks all nine exact, bounded SQLite trigger SQL definitions using
shared installation constants/helpers. Observable changed/missing definitions
cannot authorize indexed reads or advance a history stamp. No SQL body leaks to
public output. All three regressions are now green. Deliberately restoring every
matching trigger/marker before observation remains outside online anti-rollback
claims; reopening still reconstructs canonical membership unconditionally.

Other reviewed paths: generic Put/Remove/compared batches, RecordMeter and budget
settlement hooks; owner moves and empty owner IDs; fractional/future/arbitrary
windows; missing/deleted/replayed proofs and generation-reset recovery; dirty
fallback and rollback; cross-Store writes/reopen; unchanged read-only snapshot
use; BINARY generated membership keys; logical-backup derived exclusion and
physical schema allowlist fencing. Existing current-cycle name-only canonical
trigger checks are a separate prior hardening concern, not claimed fixed here.

## Verification

Independent tests: `28b46ec` plus `49e268f` (author carries equivalent cherry-picks
`3485276` and `189b54b`). Seven reviewer cases include the three failing-before-
passing regressions, cross-Store differential owner moves, overflow recovery,
never re-blessing dirty history, and BINARY membership-key assertions.

On the corrected production files:

```sh
go test -race ./internal/store \
  -run 'TestReviewUsageHistory|TestUsageHistory|TestUsageProjectionPublic(ConcurrentMeterReplay|DeniedRenewalCommitsSettlement|AtomicBatchRollback)' \
  -count=1 -timeout=4m
```

PASS, 39.939s, terminal 2026-11-01 19:55:58 UTC. `git diff --check` passed.
Earlier unaffected focused race passed 26.146s; four initial reviewer cases passed
14.657s before adding the reproduced failures.

No remaining blocker found in this bounded owner-history review. This is not a
formal proof or production-capacity certification. Full integrated gates, final
100k/25-account CLI repeat, and broader production checklist remain coordinator
work. No CI, publication, browser, native-core, live-data, or deployment action
was performed by this reviewer. Old-reader probes were author evidence, not
independently rerun here.

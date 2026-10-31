# Independent-process admission claims

`TestAdmissionClaimsAcrossProcesses` starts two copies of the race-enabled test
binary against one synthetic temporary SQLite database, waits for both to finish
opening, then releases the claim barrier. It separately checks the last online-IP
slot, last logical-stream slot and last finite quota byte. Exactly one process
must be admitted, with one durable presence and at most the single remaining
byte reserved. This is real process/SQLite evidence, not native proxy payload or
production multi-control-plane availability evidence.

The initial helper had its own stderr-buffer data race on a child startup error;
that fixture defect was corrected by joining the child before reading stderr.
The corrected unchanged test reproduced a real baseline startup failure:
concurrent `Store.Open` could fail with SQLITE_BUSY or BUSY_SNAPSHOT (517) before
the claim barrier. It reproduced on both usage-only and live-state branches, so
it is not attributed to the live-state optimization.

`migrate` now reserves the writer before its no-op schema reads using an UPDATE
whose predicate is always false. The `records` table already exists at this
point; `counters` need not yet exist. No canonical row or row trigger is changed.
The mutation inventory explicitly permits only that exact no-row statement.

The corrected test passed five race-enabled repetitions on the usage-only branch
(three contention cases each; 30 child processes, 18.357 seconds total). The
live-state combined rerun is recorded separately when available. This is bounded
repeat evidence, not a proof for every possible scheduler interleaving.

Retained logs distinguish the fixture race, pre-fix startup failures and the
post-fix successful repeats. Never count the initial single lucky pass as proof
that concurrent startup was reliable.

# Independent compact admission implementation review

Reviewed immutable commit `d18a1edd47fb95f2e629decf2192a1a67e06e7fd` against parent `2447c265f0c66b04df59dbee20707a517d5ef0e4` and the approved live-state design. Detached review worktree: `/workspace/shared/routeweaver-live-state-review`. Production sources were not edited. Only untracked reviewer tests were added there; the owner continued independently elsewhere.

## Verdict

No blocking correctness finding in this bounded review. Both original must-fix exceptional cases are implemented and pass: malformed finite unsigned underflow never silently disappears, and typed-decode errors retain canonical pending/error ordering. Arithmetic anomalies use conservative whole-domain fallback; canonical writes remain accepted. Global exceptional markers are encrypted/authenticated, and rebuilding a missing marker invalidates peer account snapshots rather than trusting partial state.

The diff preserves the two scan positions, canonical administrative/status/history guards, denial settlement commits and error rollback. Canonical record IDs, each account's stored watermark, separate generations, OLD/NEW-kind triggers, keyed per-domain account lookup, AEAD/AAD separation, fresh nonces and fresh-restore crypto construction were inspected. Both import paths invalidate the new domains and both new table pairs remain excluded from canonical backup frames. Lease/budget quantities and identifying fields stay encrypted; equality/existence, ciphertext sizes and write patterns remain observable as documented.

Trigger checks verify presence of the three expected names, not their full SQL definitions. Reopen reinstalls definitions and invalidates derived state. This is not adversarial protection against an editor replacing a trigger with a same-name no-op or rewriting canonical and derived metadata together; that remains outside the design's stated integrity model. Missing-trigger denial was tested.

## Executed evidence

- Copied the owner's public and logical-restore probes unchanged into reviewer-named files. `TestLiveState*` plus `TestAdmissionLiveStateIndependentDirtyDomains`: PASS, 0.485s. Includes both exception orderings cold/warm, unknown-owner and foreign typed errors, repair, finite/nonfinite distinctions, canonical IDs, old/new owner movement, backwards lease/budget time, late settlement, denial commits, unchanged finite-zero rate guard, and different-key logical restore. No whole-backup KDF workload was started.
- Added independent public negatives: aggregate overflow before/after pending by canonical ID, per-budget fractional rounding, arithmetic/typed error rolling back settlement followed by successful retry, own-expiry denial ahead of unrelated typed error, missing/corrupt account/marker/state rows, unsupported marker version, missing trigger, and raw-SQL reinsertion of an authenticated canonical reservation. PASS, 0.267s.
- Repeated copied probes plus independent public negatives three times: PASS, 1.721s.
- Existing focused admission, budget, recovery, connection, usage-projection and canonical mutation-inventory tests: PASS, 1.085s.
- Independent deterministic 500-step budget mutation differential (seed 20261019): public Put/Remove across two owners, repeated canonical IDs, varied finite/unlimited/closed/settled states and frozen rates; after each mutation compare optimized and unchanged canonical reservation reducers for both accounts at independently varying forward/backwards times. PASS, 0.733s. This infrastructure comparison supplements, not replaces, public tests or exhaustive proof.

Reviewer test SHA-256 values:

- `reviewer_live_state_public_test.go`: `b4724b55b3060e0abe0916bda54e42f6a0d1fde2c0d0e72dbb01bb5793c3ec50`
- `reviewer_live_state_restore_test.go`: `e09ac424336861a6c6ff2756bb503b9149071bcc57a0c0b465a8a893d53d9f7d`
- `reviewer_live_state_negative_test.go`: `b370d259a7947e0745daa27c949e475943d2a28c98cdba4506b49309886a0b13`
- `reviewer_live_state_differential_test.go`: `d11bb5177bfd92e8b96221913682ac92945c03899ca1fb9ecd29bb1434cba77f`

## Remaining acceptance scope

This is not aggregate acceptance, exhaustive interleaving proof, subprocess-race evidence, a resource bound, or a throughput claim. Whole-backup/KDF completion, release-churn above 4096 outstanding obligations, closed-history scaling, full project gates and any later implementation changes remain the owner's/root's acceptance work. The prior first-slice backup run was pending when this review was assigned; this note does not assert its result.

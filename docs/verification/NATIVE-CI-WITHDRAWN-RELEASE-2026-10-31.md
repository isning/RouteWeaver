# Native gate diagnosis: withdrawn upstream release

Run `41217692731`, job `124585553257`, tested remote commit
`1a737fa07727b9ee01425b92f0ae9e204aef33a3` (tree
`ec4e637b7737c0590df58462927d5a0180e976d1`). Actual job logs show
`bootstrap-cores.py` failed at 16:02:37 UTC: the pinned Xray 26.10.29
archive URL returned HTTP 404. Five preceding compatibility/historical stock
assets verified. Parser, stock process and managed payload stages did **not** run;
there was no native diagnostics artifact. Local passes cannot substitute for them.

The official [26.10.31 release](https://github.com/XTLS/Xray-core/releases/tag/v26.10.31)
explicitly describes withdrawal of 26.10.29 and an emergency default MPTCP
mitigation. At 16:12 UTC, both the release REST endpoint and release page for
26.10.29 returned 404. Do not restore unavailable bytes through an unreviewed
mirror, relax hashes, skip current-version tests or claim this was a runtime pass.
Replacement stock provenance, compatibility and application/managed listener
exposure require separate security review. No kernel or host network setting was
changed for this diagnosis.

## Harness contract checks

`python3 -m unittest scripts/test_managed_gate.py scripts/test_core_bootstrap.py`
passed 15 offline tests. The new managed script tests use synthetic JSON events
and a fake compiler only: they verify selection of the continuous-service payload
test, race mode, HTTP package, built managed binary path and explicit Xray target;
missing/skipped/failed continuous results and nonzero compiler status fail the
gate. These are script-contract tests, **not** native traffic evidence. Existing
bootstrap tests retain checksum, unsafe-cache and required-stock protections.

Required closeout remains an exact published-source native CI pass with real
pinned parser binaries, both selected stock process targets, and all managed
payload/revocation tests. No timeout, skip rule or native ownership guard was
weakened here. Root owns reviewed source publication; this worktree does not push.

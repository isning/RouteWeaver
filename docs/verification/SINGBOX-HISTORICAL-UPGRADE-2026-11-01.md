# sing-box historical cross-version upgrade acceptance

Status: fixture compiled and offline gate regressions passed; **native process
cases UNRUN here**. They must pass the existing CI native-runtime job before
OPS02 can use this as runtime evidence. Local stock sing-box activation is
prohibited on this workspace; no retry, netlink bypass or host change was made.

## Versions and safety scope

The fixture uses already pinned official **1.14.3 → 1.14.4** bytes, not a
same-version reinstall. Official release pages were re-read on 2026-11-01:
[1.14.3](https://github.com/SagerNet/sing-box/releases/tag/v1.14.3),
[1.14.4](https://github.com/SagerNet/sing-box/releases/tag/v1.14.4).
The latter is marked latest. The
[upstream advisory list](https://github.com/SagerNet/sing-box/security/advisories)
does not establish that every dependency is safe. The project's
[security maintenance review](STOCK-CORE-SECURITY-MAINTENANCE-2026-10-31.md)
already identifies affected standard-library dependencies in 1.14.3.

**1.14.3 remains retired for installation/upgrade**, not newly admitted by this
change. Only a verified already-installed historical receipt is staged. Existing
historical configure/rollback policy is exercised, not expanded; the new lease
is an isolated test grant, not production authorization or a recommendation to
roll back security fixes. Current installability/defaults remain 1.14.4.
There are not two currently installable sing-box versions in this catalog.

Immutable pins, unchanged from the catalog/stock lock:

| Version | Archive SHA256 | Executable SHA256 |
| --- | --- | --- |
| 1.14.3 | e2bdf179c15a3652955dc44867e33ca0965c9c9b91b34267dcc5a5d639a5feee | 768d31fa7f68debc067bb4626539498a1e8751d36a7b99e1a54bee6a23815f93 |
| 1.14.4 | 699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968 | 1264361b5f8868c8768f7555d3e77e20118bf503c41ac08bb290a0d99056aa3a |

The old pin's upstreamChecksumVerified remains false; immutable local byte
verification is not retroactively represented as an upstream checksum/signature.

## Required process outcomes

The same agent Submit/Recover/EnforcePolicy seam as the Xray fixture covers:

- Distinct old/new versions and executable digests; actual official cache bytes.
- Successful upgrade, exact runtime identity/digest, payload and reopen recovery.
- Valid config with occupied loopback port: failed new start cannot claim an
  observed owner; recovery proves both versions quiescent and no payload path.
- Expired historical lease cannot reactivate the old executable.
- Explicit higher-generation rollback with a fresh lease restores exact
  historical identity and authenticated SOCKS payload; expiry closes access.
- Exactly one archive open (the new version), no historical download.

Both engines' top-level tests AND each failed-new=false/true child are mandatory
when selected. Missing children or skips fail the gate. Unselected engines may
skip only their top-level test. Existing parser, client-feed and native runtime
requirements remain unchanged. This is loopback SOCKS/TCP process ownership and
lease evidence, not every transport's schema migration, throughput, managed
accounting, or production-host deployment.

## Local evidence

- Offline harness regression RED: omitting either sing-box outcome incorrectly
  passed before the gate change (two failing assertions).
- GREEN: python3 -m unittest scripts.test_core_bootstrap — 14 tests passed.
- Go agent test package compiled with -run '^$'; zero behavioral tests executed.
- No native runtime test was run locally. CI must establish both actual outcomes.

Cleanup review correction: preserve the old reconciler on failed reopen, retain
the original installed-adapter registry, and independently reacquire the instance
lock before selecting the process journal's exact adapter and calling Restrict.
Its OS-identity/pidfd checks remain authoritative; no blind PID/group kill.
A non-native disk-fixture regression covers closed StopOwned, corrupt-journal
reopen failure, competing-lock refusal and successful independent absence proof.
That focused regression and all 14 offline bootstrap tests passed locally.

A second independent review caught an incorrect registry capture in that cleanup
correction: Open snapshots its caller registry, so later installations populate
only the instance registry. Cleanup now retains r.registry immediately after
successful Open, independent of later Close/reopen. The strengthened disk test
opens with an empty caller registry, registers its simulated adapter only in the
instance, and verifies the caller remains empty. RED with caller capture:
"runtime descriptor not registered"; GREEN with instance capture: focused
regression passed. All 14 offline bootstrap tests were repeated successfully.
The earlier cleanup revision alone is not acceptable.

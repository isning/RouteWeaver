# Engineering baseline verification

Recorded 2026-10-19 UTC, against an actively changing shared local checkout. This is engineering-harness evidence, not acceptance of all 35 stories. No story ticket has been marked verified by this pass.

## Passed

- scripts/verify.sh static: 24-ticket acyclic graph, 35/35 feature-story coverage, generated-file consistency; four positive/negative graph tests; three architecture checker tests and actual production-import scan.
- scripts/native-cores.sh: pinned Mihomo 1.19.32, sing-box 1.14.3, Xray 26.3.27 binaries; required client, VLESS-client, server and agent native parser test families all present and passed without required skips.
- ROUTEWEAVER_NATIVE_PROCESS_TESTS=xray scripts/native-cores.sh runtime: Xray lifecycle/restart and two-hop loopback round-trip test passed. sing-box explicitly unrequested, not passed.
- bash -n scripts/*.sh and Python script compilation: passed.

## Not established

- The full local aggregate, final integrated Go/web build and browser journeys must be rerun by integration after concurrent owners finish. Earlier quick attempts correctly stopped on formatting while files were actively edited; no all-green aggregate is claimed here.
- sing-box actual process startup is host-blocked at netlink initialization according to the runtime worker's concrete attempted execution. No elevated retry or alternate privileged route was attempted. Parser validation remains separate positive evidence.
- Remote GitHub Actions, published issues/PRs, multi-VPS deployment, actual cross-entry rate/IP enforcement and complete story acceptance are not established by this pass.

## Reproduction and artifacts

Commands and prerequisite installation are documented in README. Runtime machine-readable results are bin/verification/native-parsers.jsonl and bin/verification/native-runtime.jsonl. They contain synthetic fixture information and are ignored build output, not permanent release evidence. CI runs the same scripts/verify.sh full with both process families selected on its compatible runner; the workflow has not run remotely.

## Provenance

Official Go archive SHA256 was verified before extraction. Native archives/executable bytes are pinned in scripts/core-lock.json with an explicit upstream-checksum verification distinction. Action commits were resolved from their official public repositories using read-only tag lookup. Pinned Matt skills were read from official immutable raw URLs; no skill code was installed or executed.

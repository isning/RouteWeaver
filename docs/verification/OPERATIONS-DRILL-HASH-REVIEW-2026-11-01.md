# Operational drill receipt: exact hash-pattern review

Base: `85fec8f`. The two jfrog-identity-token findings in
`evidence/OPERATIONS-DRILLS-2026-11-01.json` lines 93–94 are independently verified
source/executable SHA256 metadata, not assumed safe from their shape alone.

Receipt JSON was decoded rejecting duplicate keys and checked against its exact
12-field schema. Its eight-entry hash map contains only safe relative paths and
lowercase SHA256 strings. All eight values were recomputed from retained files in
`operations-drills-20261101`. In particular the flagged values match bytes of:

- `operations-drills-20261101/internal/agent/managed_xray_process_test.go`
- `operations-drills-20261101/bin/drill-managed-xray`

Only two exact receipt-path/rule/source-line-SHA256 reviews were added. No receipt
bytes, scanner rules, ignore paths or history scope changed. Actual pinned-scanner
regressions cover each original line, modified same-path line and identical line
at another path. The latter two remain rejected. This is a pattern classification,
not a new operational drill, credential validity assessment or deployment claim.

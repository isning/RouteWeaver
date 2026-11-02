# Terminal custody evidence: exact hash-pattern classification

Base `ebc12f2`. Preliminary full source/index/all-reference scan reported 24 matches:
23 on the production/test manifests and one on the legal-lifecycle source receipt.
No matched values were emitted, and none are assumed safe merely from hex shape.

Both manifest JSON objects were decoded rejecting duplicate keys and restricted to
safe relative source paths with lowercase SHA256 values only. Every **248 production**
and **302 test** entry was independently recomputed from declared Git snapshot
`b38b12b7730a964cf3b3bf0273b8991617a2b586` and the current checkout: all match.
Exact immutable manifest bytes match their operational receipt bindings. The actual
retained `terminal-operational-refresh-20261102/bin/operational-managed-xray` bytes
also match the receipt's fresh native executable hash.

The legal-lifecycle receipt's exact top-level field set was checked after
rejecting duplicate keys. All four source hashes match retained files in
`operational-legal-lifecycle-20261102`, including the flagged
`internal/agent/managed_xray_process_test.go` line. It is source metadata, not a
native-pass claim; this classification does not rewrite historical outcomes.

Five exact path/rule/source-line-SHA256 entries were added: two rules for each
manifest and one for the legal-lifecycle line. Immutable evidence, detection rules
and history scope are unchanged. Actual pinned-scanner regressions cover original
lines, modified same-path lines, and original lines at another path; the latter
two must reject every applicable detector rule. Terminal logs accompany this note.

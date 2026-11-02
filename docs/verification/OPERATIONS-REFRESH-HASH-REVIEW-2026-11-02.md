# Failed operational refresh: exact manifest hash review

Base `5e15505`. Full-history scanning reported 23 pattern matches on the one-line
production and test manifests for FINAL-OPERATIONS-REFRESH-2026-11-02. This review
classifies only hash metadata; the failed operational result remains failed.

Strict JSON parsing rejected duplicate keys. Each manifest contains only safe
relative source paths and lowercase SHA256 values. All **244 production entries**
were recomputed from their declared Git source `c95e477c1cf33908962017d103ea1326bd8f98e7`;
all **297 test entries** were recomputed from declared test source
`db67b40c91098800aefe2eba36d5f03bf2198198`. The full immutable manifest bytes match
both their receipt binding and artifact hash fields. No shape-only assumption.

The production manifest also matches this current checkout. The historical test
manifest differs from current checkout only at
`internal/httpapi/browser_native_bridge_test.go`, subsequently changed by the
native bridge harness correction. It is deliberately **not** relabeled as a
current-test manifest, and its historical byte binding remains intact.

Only four exact path/rule/source-line-SHA256 review entries were added (two rules
per manifest). No broad JSON/path exemption, scanner change or receipt rewrite.
Actual pinned-scanner regressions reject modified-line and other-path copies for
both detector rules. Verification records and terminal scan/test logs accompany
this note. Neither clean pattern scanning nor these hash checks establish a
production retirement fix, explain the original failure, or authorize deployment.

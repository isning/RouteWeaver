# Exact reference-evidence false-positive review

Base: `9f7c612`. The previous full-history scan failed 17 pattern matches; that
failure is not reclassified as a pass. No receipt or manifest bytes are changed.

The one-line UPDATED-MANAGED-SOURCE-MANIFEST contains exactly 224 unique entries,
each a safe relative source path and lowercase 64-character SHA256 value. Strict
JSON decoding rejects duplicate keys. Every entry was recomputed from both the
receipt-declared production base `a7963c689c7ae5c3c8abb19efa59083f19d0a970` Git blob
and the unchanged current file. The exact full manifest bytes also match the
UPDATED-MANAGED-1800S receipt's manifest hash. There are no non-hash values,
additional payload fields or unverified paths. This establishes source-hash
metadata, rather than assuming every hex-shaped string is harmless.

Four other findings are executable hashes, independently recomputed from retained
executable bytes:

- UPDATED-MANAGED-1800S lines 24–25: both binaries under
  `operations-updated-reference-20261101/bin/` (`reference-managed-xray` and
  `reference-httpapi.test`).
- Historical STORAGE-ATTRIBUTION-120S at `99b7bdf`, lines 198–199:
  `capacity-evidence-20261101/httpapi.test` and
  `operations-updated-reference-20261101/bin/reference-managed-xray` respectively.

The existing reviewed mechanism gains six exact path/rule/source-line-SHA256
entries: two rules for the manifest and one for each executable-hash line. It
changes no upstream detection rule, path-wide exclusion, history scope, or
immutable receipt formatting. Regression tests run the actual pinned scanner:
original manifest at exact path passes; modifying its line or using another path
still rejects both generic-api-key and jfrog-identity-token matches. All 24 scanner
tests pass. Separate final source/index/all-reference-history scan results are
retained with the task evidence and reported for the exact final commit.

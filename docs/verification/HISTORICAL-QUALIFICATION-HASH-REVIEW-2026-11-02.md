# Historical qualification: exact manifest classification

Base `bbfc348`. Preliminary scanning reported 23 pattern matches on the one-line
qualification production/test manifests. Four exact path/rule/source-line-SHA256
reviews address these verified hash-metadata matches, not arbitrary hex strings.

Strict JSON decoding rejects duplicate keys. Each manifest contains only safe
relative paths and lowercase SHA256 values. All **248 production** and **303 test**
entries were independently recomputed from their declared snapshot
`81b5c7a11e62873a847dd0d42305f0acdcb1f793`, tree
`6dc9f1db86cd60c5db8e7906d781893a6a024ff1`. Exact manifest bytes match the receipt.
Both retained native/test executable bytes and the raw JSONL bytes independently
match their receipt hashes. This is historical qualification provenance only.

**The manifests are not current capacity-guard source manifests.** Six listed
production files and one test file differ from the current checkout; additional
capacity-guard files are outside the old path set. Exact changed manifest paths
are retained in provenance.json. No current-source or current-binary qualification
is inferred, and no immutable receipt or manifest bytes are rewritten.

Actual pinned-scanner regressions cover each original manifest, a changed line
at the same path, and identical content at another path. Both detector rules must
still reject the latter two. No broad path exemption, upstream rule modification,
history omission or production change was made. Terminal test/scan logs accompany
this note; the final candidate still requires its own source-bound scan.

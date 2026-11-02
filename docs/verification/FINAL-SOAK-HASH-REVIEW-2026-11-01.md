# Final managed reference: exact executable-hash review

Base: `23650ca`. Full-history findings at commit `d640f01` in
`evidence/FINAL-MANAGED-REFERENCE-2026-11-01.json` lines 47–48 were verified as
executable SHA256 metadata, not presumed harmless from their hex shape.

Both values were independently recomputed against retained executable bytes:

- `operations-final-reference-20261101/bin/final-reference-managed-xray`
- `operations-final-reference-20261101/bin/final-reference-httpapi.test`

Receipt parsing rejected duplicate JSON keys. Exact top-level, attempt and binding
field sets were checked, including the binary map containing only those two names.
The complete attempt2 binding equals retained `bin/verification/attempt2/binding.json`;
its production and test manifest hashes also match the retained manifest bytes.
This classification does not change the failed first attempt or imply a new soak.

Only the two exact path/rule/source-line-SHA256 reviews were added. No immutable
receipt bytes, broad path exemptions, upstream rules or history scope changed.
Actual pinned-scanner tests require the original reviewed line at its exact path
to pass, but reject a modified line and the original line at another path. Numeric
byte fixtures retain these exact historical metadata lines without depending on
unpublished Git history or introducing another credential-shaped copy elsewhere.
Final source/index/all-ref scan output is separately recorded for the final commit.

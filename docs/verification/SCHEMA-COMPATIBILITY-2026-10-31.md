# Database compatibility fence

The control plane now rejects unsupported migration histories and unrecognized
table/column shapes before initialization writes. A read-only preflight runs
before journal-mode setup; initialization repeats the check under SQLite's
`BEGIN IMMEDIATE` writer reservation before creating or migrating any table.
This preserves concurrent first-open behavior without modifying a lock row in
an unknown schema.

Supported inputs are a new empty database, the original records-only shape, and
the known migration histories `[1]` and `[1, 2]`. Rebuildable projection tables
are optional but must have the recognized physical shape when present. A future
version, a gap in migration history, an unknown table, or an extra canonical or
derived column produces `ErrUnsupportedSchema`. The existing backup shape
validator is shared rather than maintaining two competing table inventories.

Readiness also checks the current schema and migration history in a read-only
snapshot; a successful SQLite ping alone is insufficient. These checks do not
make live schema changes supported. Stop the control-plane service before
upgrading or restoring a database; use a matching program version or a compatible
offline backup when the fence rejects an input. Never edit migration markers to
silence the error. Ordinary mutation paths retain their existing transaction
semantics; this change does not add schema scans to every write or claim to guard
arbitrary out-of-band SQL changes against an already-open Store handle.

## Verification

- Before the change, four focused cases accepted unsupported databases and
  rewrote the encrypted key-check record. All four reject without record changes
  after the fix.
- Added migration-gap refusal, records-only initialization, supported historical
  migration with preserved data, concurrent first-open, and readiness rejection
  after a synthetic out-of-band future-version change.
- Focused initial cases passed three repetitions. The initial fence passed the
  complete store package with `go test -race ./internal/store -count=1` using
  Go 1.27.3 (171.279s).
- Independent review then found that `pragma_table_info` hides generated
  columns. Canonical and derived generated-column counterexamples reproduced
  the gap. Both validators now use `pragma_table_xinfo` and reject nonzero
  hidden/generated markers. Focused schema and backup-shape tests passed three
  race-enabled repetitions after this correction; the final integrated full
  gate remains separate from the earlier complete-store result.
- No production database, live service, master key, or deployment was changed.

Full integrated CI, exact-source package verification, and target-host upgrade
and recovery acceptance remain separate gates. This note is not an assertion
that every possible future schema or deployment topology is supported.

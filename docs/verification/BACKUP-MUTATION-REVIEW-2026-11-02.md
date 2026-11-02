# Backup-set corruption fixture review — 2026-11-02

Base: `c95e477`. This change modifies tests only. No encryption, authentication,
restore validation, timeout, publication or cleanup guarantee is relaxed.

## Observed failure and established defect

[CI5](https://github.com/isning/RouteWeaver/actions/runs/41379700309), backup job
`125067567502`, reported `TestBackupSetRejectsCorruptionAndCleansPrivateStage/tampered`
accepting corruption. The former mutation overwrote byte 200 with the constant
`0xff` and ignored open/write/close errors. A random ciphertext byte already equal
to `0xff` is unchanged by that operation. The CI preimage was not retained, so
that particular no-op is a plausible explanation, **not a recovered fact about
that run**; ignored I/O errors were another way the fixture could fail to mutate.

A deterministic counterexample now proves the old overwrite leaves an existing
`0xff` unchanged. The replacement XOR mutation is checked over all 256 possible
input bytes, verifies bounds and exact persisted bytes, and rejects a no-op.
Every corruption setup operation and the output-directory inspection now checks
its I/O result. Copying the immutable fixture also checks directory enumeration.

## Authentication-path review

`RestoreSet` reads the age-encrypted manifest through EOF before parsing its
canonical authenticated contents. `readSetPart` authenticates past the terminal
plaintext footer, checks the scanner error, exact ciphertext byte count and the
ciphertext SHA256 from the authenticated manifest. An ACK or parseable prefix is
not treated as successful authentication. This focused review and finite tests
did not establish a production authentication bypass; they are not a formal proof
of all possible corruption or restore inputs.

## Executed evidence

- Focused race suite: **PASS, 95.676 s**. Valid round-trip and fresh-target rules;
  nine corruption cases, including guaranteed payload-byte, final-tag and
  manifest-tag mutations; no target/staging leftovers; unchanged authenticated
  ciphertext remains valid after a same-byte rewrite.
- Exhaustive mutation test covers every input byte. With the old constant
  assignment deliberately substituted, it fails deterministically at `0xff`
  with `ciphertext mutation was a no-op`. Restored XOR implementation passes under
  race (**1.034 s**). Enumeration was made descending so this counterexample runs
  first; no mutation or rejection expectation was weakened.
- No other constant `0xff` ciphertext overwrite remains in the backup package;
  the only occurrence is the explicitly labelled negative counterexample.
- Raw focused, negative and restored logs are retained in
  `evidence/backup-mutation-20261102/`.

Command: `scripts/go.sh test -race ./internal/backup -run '^TestBackupSet(CiphertextMutationChangesEveryByteValue|UnchangedCiphertextRewriteRemainsValid|RejectsCorruptionAndCleansPrivateStage|RoundTripAndFreshPublication)$' -count=1 -v`.

The final integrated backup package and full CI still require execution. No
native process, remote CI, push, or production change was performed here.

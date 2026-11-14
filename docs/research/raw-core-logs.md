# Optional raw core process logs

This is separate from fixed-category `--core-diagnostics`. It is **off by default**.
Only explicitly starting an enrolled, locally supervised Agent with
`--raw-core-logs-accept-sensitive` permits capture of its owned core's stdout/stderr,
only after the current instance policy is explicitly enabled in the control plane.
It does not read arbitrary files, run shell log commands, alter a core's log level,
or enable access logging. The website cannot grant the local opt-in or restart a core.

## Privacy and operators

Raw text is not redacted. It may contain client IP addresses, destinations, account
labels, file paths or credentials. Before opting in, the operator must be authorized
to disclose that content to this control plane and its administrators. Do not turn
it on merely to collect more dashboard detail. Disable it locally by restarting the Agent
without the flag, or pause platform collection in the instance settings. No production setting is enabled by this implementation.

The Agent has no plaintext raw-log spool: a bounded in-memory queue and one pending
batch are discarded on restart. It cannot recover startup logs from before it was
attached, logs sent to files, or events the core did not emit. The existing classified
diagnostic path still never transmits raw output.

## Limits and access

- Every report uses the existing enrollment token and exact node/instance/epoch
  check. Revocation/rotation prevents former enrollment reports and hides old history.
- Only administrators can read `/api/admin/instances/{id}/core-logs`; no tenant route
  exposes these records. Raw text is untrusted data, never HTML or a command.
- Query filters are literal case-sensitive text (`q`, maximum 128 UTF-8 bytes),
  `stream=stdout|stderr`, and `since=RFC3339`. Streams are not severity levels.
- `format=ndjson` exports the same filtered retained set as JSON, not unlimited
  history. Exports are attachments, `application/x-ndjson`, `no-store`, `nosniff`.
- Captured lines are at most 4096 UTF-8 bytes. Overlong and invalid UTF-8 lines are
  discarded whole, not silently truncated. No claim of byte-for-byte binary logging.
- Each stream parses at most 64 KiB per second; the Agent queue holds at most 128
  entries, each batch at most 16. Slow/offline delivery can drop newer data.
- The control plane accepts at most one new batch per instance every 5 seconds,
  retains at most 128 entries per instance for the selected 1-hour, 24-hour or
  7-day maximum age, and caps histories at 64
  instances. JSON escaping can increase serialized byte size above raw-text size.
- `dropped` describes the latest acknowledged batch interval and includes discarded
  fragments/oversized lines, not a precise count of lost log entries or a lifetime
  total. The UI must not call a recent heartbeat “healthy” or “complete”.
- Foreground cleanup runs at startup and every minute, also pruning on reads/writes.
  Retention is not forensic erasure: SQLite/WAL, disk snapshots and existing encrypted
  backups may retain former data. Downloaded exports are separate copies. Offline
  servers do not run cleanup. Secure these copies with the same care as credentials.

Session IDs permit a new memory-only Agent to report after restart without persisting
sensitive pending text. Within a session an immutable pending batch is retried with
an exact digest until acknowledged. Expired pending text is forgotten after an hour
and a new session starts. This is bounded best-effort diagnosis, not an audit archive.

## Per-instance collection policy

New installations and instances default to platform collection disabled. An
administrator can read or update `/api/admin/instances/{id}/core-logs/settings`.
Updates require the exact `expectedRevision` (empty for an unconfigured instance),
`enabled`, and `retentionSeconds` (3600, 86400, or 604800). Every successful save,
including a retention-only edit, atomically clears the currently stored log history
and rotates the policy revision. Conflicts return 409 and require a fresh read.
This is a logical deletion of the live record, not secure physical erasure from
SQLite pages, WAL, independent backups, or previously downloaded exports.

Agents read the authenticated instance-scoped settings endpoint and must attach
`policyRevision` to every report. Disabled, missing, and superseded policies reject
reports, including late retries across disable/re-enable cycles. Platform enablement
does not enable the local `--raw-core-logs-accept-sensitive` opt-in, restart a core,
or turn on its access logs. Raw text may contain credentials and personal data.

The retention selection changes the maximum age of both observed and received
records. All policies still retain only the newest 128 entries per instance, at
most 64 instance histories/settings, and 4096 bytes per line; this is not a complete
log archive. Background cleanup continues every minute and read/write cleanup
also applies. Existing pre-policy history retains its original one-hour maximum;
without a configured enabled revision, new reports are refused. Policy changes
cannot retroactively recover previously expired or cleared entries.

The compatible Agent checks policy before each batch (normally every 10 seconds).
Settings fetch/validation failures pause capture and drop the raw memory queue;
permission/revision rejection or invalid HTTP receipt also purges pending text and
partial line buffers. A policy change starts a fresh delivery session. Deletion
of a core instance removes its policy and history atomically, so reusing its ID
cannot inherit enabled collection. Old Agents without the revision handshake must
be upgraded; the server rejects their legacy reports rather than guessing consent.

Clearing memory references is not cryptographic memory erasure. A partial line is
bounded to 4096 bytes per active writer (at most 16) and is discarded on policy
change/stop; normal incomplete lines are not a durable archive or an age-cleaned
memory buffer. Startup lines emitted before both consent gates open are not recovered.

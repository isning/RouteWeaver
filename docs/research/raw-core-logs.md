# Optional raw core process logs

This is separate from fixed-category `--core-diagnostics`. It is **off by default**.
Only explicitly starting an enrolled, locally supervised Agent with
`--raw-core-logs-accept-sensitive` captures its owned core's stdout/stderr.
It does not read arbitrary files, run shell log commands, alter a core's log level,
or enable access logging. The website cannot enable capture or restart a core.

## Privacy and operators

Raw text is not redacted. It may contain client IP addresses, destinations, account
labels, file paths or credentials. Before opting in, the operator must be authorized
to disclose that content to this control plane and its administrators. Do not turn
it on merely to collect more dashboard detail. Disable it by restarting the Agent
without the flag. No production setting is enabled by this implementation.

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
  retains at most 128 entries per instance for one hour, and caps histories at 64
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

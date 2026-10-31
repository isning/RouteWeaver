# Encrypted backup and fresh-target recovery

RW-21 / M02. This is a complete logical database backup, not a redacted sharing
template. The administrator UI downloads age files and uploads them directly as
multipart files, without base64 or whole-archive JSON copies.

## Interfaces and module ownership

- `CreateStream`, `PreviewStream`, `Prepared.Summary`, `Prepared.Restore`, and
  `Prepared.Close` are the growth-capable interface. Callers must close prepared
  previews. A successful preview is secret-free metadata, not live activation.
- `internal/backup` owns age, versioned JSON framing, byte/time/category bounds,
  ciphertext digests, and ephemeral encrypted preview storage.
- `internal/store/backup_stream*.go` owns consistent row iteration, fresh import,
  SQL-backed validation, and durable fresh-target publication. Account/index and
  generation relationships share their policy with legacy snapshot validation.
- `internal/httpapi/backup*.go` owns authorization-adjacent upload handling,
  endpoint deadlines, one-operation concurrency, preview receipts, and explicit
  restore confirmation. Existing administrator authorization and session CSRF
  still run before these handlers.
- `Create`/`Preview` and the Snapshot interface remain **v1 compatibility APIs**,
  with their original 16 MiB archive / 15 MiB snapshot / 100,000-row limits. New
  HTTP exports use v2. `PreviewStream` imports both v1 and v2, including formatted
  v1 JSON; v1 still uses bounded in-memory decoding, not the larger stream limits.

## Encryption and format

The outer container is standard age v1, via pinned `filippo.io/age` v1.3.2. No
custom cipher, KDF, nonce scheme, compression, archive extraction, or embedded SQL
is introduced. Passphrase encryption uses age scrypt work factor 18; untrusted
headers cannot request more than 18. HTTP allows one backup operation per server
and returns 429 for concurrent work, bounding concurrent memory-hard KDF work.
Passwords require 12 Unicode characters through 1,024 UTF-8 bytes. Keep a unique
random multi-word passphrase separate from the backup: there is no password
recovery.

V2 authenticated plaintext is newline-delimited JSON:

1. A `manifest` header with format `routeweaver-backup`, version 2, database schema
   version 2, creation time, `containsSecrets: true`, and initially zero counts.
2. One logical frame per row, containing exactly one of `record`, `identity`,
   `token`, `counter`, or `migration`. Tables appear in that order, each in strict
   primary-key order. JSON encoding escapes embedded newlines. No paths, unknown
   frame fields, SQL, or executable hooks are accepted.
3. An `end` manifest with exact observed table counts and the original metadata.
4. Authenticated age EOF. A syntactically valid footer without age's complete
   authentication trailer is not a valid preview. Additional lines, frames,
   ciphertext bytes, or multipart parts reject the operation.

A dedicated read-only SQLite connection and single WAL snapshot transaction cover
schema inspection, complete validation,
and all exported tables. Unknown physical tables/columns/migrations reject the
operation; opaque future logical record kinds are preserved. No history is
silently omitted. The snapshot holds neither the Store mutex nor its single writable connection;
admission leases and normal configuration writes continue while export emits.
The read transaction can delay checkpoints: allow headroom for ordinary source-WAL
growth while it is held.

## Explicit resource envelope

Default operator flags (checked at startup):

- `-backup-max-archive-mib=1024`: hard maximum 1 GiB ciphertext and 1 GiB logical
  stream, configurable downward. Multipart framing has a separate 64 KiB allowance.
- `-backup-max-record-mib=32`: default 32 MiB decrypted JSON per database record;
  configurable from 1 through a reviewed ceiling of 128 MiB. Framing overhead is
  bounded separately. The database adapter checks ciphertext lengths in SQL
  before allocating a stored record. Oversize export rejects with an actionable
  record-limit error instead of dropping the row.
- `-backup-max-rows=2000000`: total across all five logical tables, including
  migrations, configurable downward. At most 4,096 summary categories are allowed;
  identifiers are bounded to 4,096 UTF-8 bytes.
- `-backup-timeout=10m`: hard maximum total HTTP operation duration, configurable
  downward. Only authenticated backup handlers extend socket read/write deadlines
  beyond ordinary server timeouts, while also applying context cancellation.
  A fixed bounded scrypt invocation is not interruptible inside the age library.
  Non-HTTP stream callers must provide readers/writers that unblock themselves;
  context checks cannot interrupt an arbitrary blocking custom `io.Reader`.

This is **bounded growth support, not unlimited capacity**. A normal 16 MiB
source fetch with up to 10,000 normalized endpoints can produce a larger stored
JSON record, so the old 4 MiB proposal was not used. Whole-state notification
records have no architectural lifetime size bound: operators must plan their
migration if they approach the record ceiling. Raising the ceiling is not a
substitute for splitting perpetually accumulating whole-state records. Archives
above 1 GiB/2M rows require a deliberately reviewed further storage/backup design,
not silent retention/deletion or a promise that current limits will suffice forever.

V2 memory scales with the largest allowed record plus bounded buffers/categories,
SQLite cache, and age's fixed scrypt memory, not total ledger history. JSON and
record encryption may temporarily hold several record-sized copies. Scrypt uses
approximately 256 MiB; budget materially more for Go GC, SQLite, the rest of the
server, and larger configured records. Do not size a process to the archive buffer
alone. The measured 40k/200k ledger comparison is in the verification report.

Disk is also bounded separately from memory:

- HTTP export first finishes into a private mode-0600 ciphertext-only temporary
  file, at most the configured archive limit. Only then are HTTP 200 and the exact
  Content-Length sent. A failed/incomplete export never becomes a successful
  download.
- Preview imports each row into a mode-0700 random directory and mode-0600 SQLite
  database using a random in-memory master key. Record payloads, including
  passwords, source content and tokens, are encrypted before SQLite sees them.
  Ordinary index identifiers remain index metadata as in the regular Store.
  No plaintext JSON file or plaintext-secret SQLite/WAL/temp table is created.
- Import caps SQLite cache to 8 MiB and database pages to
  `2 * configured archive bytes + 16 MiB`. An atomic import WAL can temporarily
  approach another database-sized file. Restore can hold two such staged stores,
  so reserve up to roughly 8 GiB + 64 MiB at the default limit, plus normal source
  storage and any downloaded/exported archive. Disk-full fails without publishing
  the target. These are limits, not an assertion every operation reaches them.
- Ordinary success, cancellation, and errors clean staging. A process/power
  failure can leave encrypted `routeweaver-backup-*`, `routeweaver-export-*.age`,
  or `.restore-*` artifacts for operator cleanup. Ephemeral preview keys are not
  persisted, so abandoned preview files cannot be recovered after process loss.
  Configure a private disk-backed TMPDIR if `/tmp` is RAM-backed.

Passphrases and records are not logged. Buffers are cleared where practical;
Go strings/decoded values/cipher internals do not provide a complete secret-memory
zeroization guarantee.

## Coverage and recovery semantics

Every database row in records, identities, token_index, counters, and
schema_migrations is included: account hashes/MFA, sessions/invites, source URLs
and content, endpoint credentials, grants, profiles/revisions, subscription
credentials, ledger/cursors/receipts, audit/deployment history, and generation
fences. The old master key is neither included nor needed. Restore re-encrypts
all record payloads with the configured target key. Binary/runtime files, VPS
state, external environment secrets, and service-manager configuration are not
inside this database backup. Restoring does not establish remote application.

1. POST `/api/admin/backups` with JSON `{password}` downloads v2 age ciphertext.
2. POST `/api/admin/backups/preview` as multipart: the first part is a `metadata`
   JSON field `{password}`, followed by one `archive` file. The browser supplies
   the multipart Content-Type boundary. The legacy JSON `{password, archive}`
   canonical-base64 request remains capped at 16 MiB (23 MiB encoded request).
3. Preview authenticates the entire age stream and verifies frame ordering,
   counts, physical/logical schema, migrations, complete account identities,
   bidirectional feed-token links, and sufficient generation fences. SQL-backed
   indexed lookups avoid history-sized maps. Only then does it commit private
   staging and return a secret-free manifest/digest/impact. The scratch preview
   is closed afterward. A 10-minute receipt retains only administrator identity,
   exact SHA-256 ciphertext digest, and expiry, not passwords or database contents.
4. POST the same file and metadata `{password, digest, confirmation:
   "RESTORE TO NEW STORE"}` to `/api/admin/backups/restore`. The complete file is
   authenticated again and its actual ciphertext digest must equal the receipt.
   The receipt must belong to the current administrator and remain unexpired.
5. Logical rows are imported into a fresh private encrypted target. Durable
   close/reopen and a canonical streaming SHA-256 row comparison must pass.
   Publication uses a no-replace hard link to a server-generated filename in the
   configured restore directory. Existing files and symlinks reject atomically.
   There is no raw SQLite-file restore or untrusted filename/path selection.
6. The receipt is consumed and success says `status: restored, activated: false`.
   The running store is unchanged. Stop the service, retain the prior database
   and its key, and explicitly restart with the returned file and configured key.
   Verify login/subscriptions/node status before retiring the previous copy.
   Backed-up sessions/grants/tokens return to their backup-time state, including
   ones revoked afterward. For rollback, stop the service and select the retained
   prior database/key. Never overwrite a live database or swap it online.

No overwrite-live switch, automatic upgrade, third-party upload, remote restart,
or automatic activation is provided. Existing restore-directory ownership and
permissions are an operator trust assumption. Lack of hard-link support fails
safely rather than falling back to overwrite semantics.

## Verification

See `docs/verification/BACKUP-STREAMING-2026-10-19.md` for commands, retained red and
green outputs, realistic growth/memory measurements, and explicit untested limits.
All fixtures are synthetic local temporary stores; no real user data, production
database, third-party service, or external credential was used.

Official library/format references (previously verified 2026-10-19):
https://pkg.go.dev/filippo.io/age@v1.3.2
https://github.com/FiloSottile/age/releases/tag/v1.3.2
https://age-encryption.org/v1

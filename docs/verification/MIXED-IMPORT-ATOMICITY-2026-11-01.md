# D01 mixed-import acceptance contract

Base: `dcfbe27`. This is evidence for existing behavior, not a new partial-import
feature or a proposed change to source application policy.

## Exact boundary

`importer.Parse` builds candidate connections privately and returns a complete
snapshot only after every extracted connection validates. Unsupported connection
protocol/options or a malformed connection cause an error and no usable partial
snapshot. The HTTP source path separately requires `Complete == true`.

Rejection is atomic with respect to **accepted connection state**, not the entire
source-edit record. The user's rejected draft is intentionally saved privately
for correction, with a new source revision and `failed` / `source_parse_failed`.
An initial failed import has no accepted snapshot, candidate or application
history. A later failed import retains the entire old accepted snapshot,
diagnostics, application history and accepted-update timestamp, and clears a
pending candidate. Existing published outputs are never automatically replaced.
`acceptPartial: true` is not an escape hatch; it does not change this contract.
Ordinary error responses do not expose submitted credentials; explicit owner
reveal can recover the rejected input.

Native import is connection extraction, not full configuration migration.
Routing, DNS and other top-level policy settings are omitted with the existing
`connection-extraction` warning. Recognized sing-box policy/built-in outbounds
(`direct`, `block`, `dns`, `selector`, `urltest`) are not connection rows and are
omitted with `non-connection-outbound`. This declared extraction behavior must
not be misrepresented as silent acceptance of unsupported connection rows.

## Regression evidence

Existing importer tests already exercise late connection validation, unsupported
security/connection settings, duplicate keys, and declared native extraction
warnings. Existing HTTP tests cover failed edited input retention and unsupported
mixed input preserving an older accepted snapshot.

New `TestMixedSourceImportNeverStoresPartialAcceptedSnapshot` provides 16 public
HTTP cases: URI list, base64 URI list, Mihomo JSON and sing-box JSON; supported
first row plus unsupported or malformed later row; both auto and manual modes.
Every case explicitly submits `acceptPartial: true`, verifies rejected initial
state, repairs using valid input in the same format, publishes a real output,
and then verifies a rejected mixed update cannot alter the complete accepted
snapshot/history/diagnostics, frozen output or downloaded feed. The private
rejected draft remains recoverable by its owner.

All inputs are synthetic text. No URL fetching, external subscription, native
runtime activation, browser execution or deployed node is involved. No production
code or import acceptance behavior changed. Release-source CI remains separate.

Local pinned Go 1.27.3 validation:

- `go test -race ./internal/importer -count=1`: PASS, 1.238 s (entire package).
- `go test -race ./internal/httpapi -run '^TestMixedSourceImportNeverStoresPartialAcceptedSnapshot$' -count=1`:
  PASS, 4.550 s (all 16 cases on final test source; not the full HTTP package).
- `git diff --check`: PASS.

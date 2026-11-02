# Managed terminal capacity preflight — local regression receipt

Base: `81b5c7a`. This is local fake/pure/API evidence, not a new native qualification.
No wire schema, storage version, count ceiling, or one-MiB limit changed.

## Reproduced gap and fix

`TestManagedTerminalCapacityRejectsGeneratedMetadataBeforeRendering` was run
against the original base versions of `internal/render/principals.go` and
`internal/render/server.go`. It failed as intended: a reachable 1,000-principal
configuration using current generated metadata lengths rendered successfully
(`got <nil>`). The guard restored, the same regression passes. Another regression
covers a smaller configuration whose zero proof fits but future counter growth
cannot, so admission is not based on the initial snapshot alone.

The shared bound includes both complete snapshots, actual binding metadata,
maximum valid uint64 counter widths, rejected-flow widths, 35-character times,
producer-shared epoch lengths, maximally escaped bounded scope identities, and
4,096 bytes reserved for actual meter-batch/exact-GET wrappers. A wire-shape test
checks that reserve. Short-metadata 1,000-principal rendering still passes.

## Checks

- Focused race: entrypolicy 1.276s; render 1.494s; agent 2.656s; HTTP 7.112s.
- Pure runtime pre-native-build rejection race: 1.209s; no core/listener started.
- Full entrypolicy and render package tests passed.
- Vet for entrypolicy/render/agent/HTTP, architecture imports, formatting and
  diff whitespace checks passed.
- Fake replacement preserves the exact healthy observed and last-known-valid
  identity, with no replacement or restriction. Historical oversized fixtures
  can still stop/revoke through all tested agent withdrawal paths.
- HTTP denial preserves all 1,000 bindings, an authenticated denied lease and
  the access-bit-bound request digest. Grant/regrant fails without desired-state
  mutation; structurally invalid denial still fails. Existing Fleet stop with
  an invalid draft passes. Artifact SHA256 is not a policy signature.

Manual denial retains its existing reviewed-fingerprint requirement. New review
of an oversized deployment does not issue a fingerprint; use the dedicated Fleet
or owned-agent stop if the prior exact fingerprint is unavailable. No native
process run, remote CI or push was performed for this receipt. This does not
upgrade the separately measured one-binding native profile into a claim that
all 1,000-principal metadata combinations are supported.

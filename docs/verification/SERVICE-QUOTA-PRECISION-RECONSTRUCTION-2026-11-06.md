# Service quota precision: source-only reconstruction

This is a new bounded reconstruction on baseline a1fbbc3, not recovery of the unavailable historical v103 ServicePolicy changes and not a claim of parity with them.

## Intended contract

- Edited GiB text is parsed as an exact decimal coefficient/exponent and converted to integer bytes before Number conversion. Fractional bytes, negative amounts, and unsafe integers remain pending. Nonzero sub-byte edits cannot become unlimited.
- Stored quota bytes are authoritative until a valid quota edit. Renaming or editing another field does not reconstruct bytes from the rounded display. No new business maximum is introduced; Number.MAX_SAFE_INTEGER remains the serialization ceiling.
- A 4096-character input bound and lexical exponent bound precede BigInt work. This is a parsing resource guard, not a quota limit. Oversized text remains visible and recoverable.
- The shared NumericInput and its keyboard stepping are unchanged. Each raw edit invalidates pending latest reads and policy reviews, including incomplete edits that emit no numeric value. Field validation runs on the raw-text callback after the exact-intent state is updated, so correction feedback reflects the current edit.
- Invalid quota text blocks preview at both validation and submit. Explicit discard restores the last accepted quota, not necessarily the opening quota, and names its exact current bytes. Close still uses existing unsaved-change confirmation.
- Explicit adoption of the latest saved service can retain an incomplete quota draft. Retained comparisons display that raw intent as missing/needs correction, while complete copies use authoritative bytes. A creation conflict cannot restart with invalid quota text: repair or explicitly discard that input first. This prevents silently seeding a new service with a rounded or missing quota.
- Service context/preview records must contain nonnegative safe integer quota bytes. Existing normalized proposal comparison continues comparing exact bytes and rejects changed proposal values.

## Public regression seams

Rendered ServicePolicyEditor with fetch boundary only, plus rendered ServicePolicyComparison. Added cases cover blank/incomplete/negative/sub-byte/rounded/oversized/exponent input, exact one-byte input, explicit unlimited, exponent notation, untouched maximum-safe stored bytes, current-value discard, immediate correction feedback, keyboard stepping, stale latest read invalidation, and unsaved close confirmation. Existing conflict/adoption/retained-copy scenarios remain in the same suite.

## Verification limits

All executable tests, TypeScript checks, lint, builds, browser/visual review, backend suites, and integration gates are UNRUN. No Node/npm/Go/gofmt/browser/server/network/install/push/deploy was used. Test sources were written before implementation but no red/green result is claimed. Git diff whitespace inspection is not behavioral verification. Permitted executable acceptance remains required. This frontend reconstruction is not server-side numeric write protection, deployment evidence, or a user-comprehension claim.

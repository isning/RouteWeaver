# Group priority draft continuity

## Finding and bounded correction

The group editor tracked only NumericInput's numeric value. Replacing a priority with an incomplete nonempty input such as `-` or `1e` therefore did not mark the task dirty or retire an older latest-version read/preview. Cancel could discard this input without a decision. Latest-version adoption and creation-ID recovery also retained only the previous numeric value, losing the exact input.

The group task now owns every raw priority edit. It marks the draft dirty and retires latest-version and preview authority, while NumericInput's shared behavior stays unchanged. Local draft copies retain the raw spelling, including valid spellings such as `+0002`. A narrow comparison prop shows that spelling in the retained-copy priority row and identifies invalid input as needing correction; server policy reviews continue using only their authoritative numeric records. Collision restarts restore the input and own an unsaved active draft independently of any removable backup copies.

Form validation and the final preview request boundary both check the raw decimal intent. The existing bounded positive-integer parser is reused with signed 32-bit bounds and exact zero handling. Nonempty incomplete input, out-of-range values and fractional tails that Number would round onto an integer cannot submit an old or rounded priority. Valid negative priorities, zero, endpoints and integral scientific notation remain supported.

## Public-seam evidence

The existing GroupPolicyEditor DOM/HTTP seam supplies coherent edit contexts and guarded previews; no private implementation helpers are tested.

Observed red before green:

- A raw-only `-` replacement did not register unsaved navigation state. After correction, Cancel asks for a decision, Continue preserves the input, and explicit discard invokes close once.
- Direct form submission of `-`, `1e` and hidden fractional tails opened an incorrect authorization review. The corrected tests reject them without a preview request, retain the raw text, and preview the explicitly corrected integer. Empty input and signed out-of-range values are also covered.
- Adopting the latest group retained `-` and `1e` as the previous numeric value, and normalized `+0002` to `2`. Retained comparisons now show the exact draft while the active editor receives the explicitly accepted latest priority.
- Creation-ID recovery changed `1e` to `0` and `+0002` to `2`. Both now survive the restart, and incomplete seeded input cannot submit until corrected.
- Independent source review identified that deleting a restart's retained copy removed its only dirty-state protection. Both raw restart tests reproduced this failure. The active seed now keeps Cancel and navigation protection after its backup is removed; Continue preserves the exact input.

Additional passing cases cover a held latest read, an outdated latest-adoption confirmation, a held preview response, signed 32-bit endpoints, exact zero, negative/scientific notation, and returning from review without rewriting valid raw spelling.

## Final local verification

After the seed-ownership correction, at 2026-11-11 21:34 UTC:

- Six focused suites passed: **149 tests**, serialized with `--maxWorkers=1`, in 32.64 seconds. The group-intent file now contains 78 tests, including 22 added cases.
- Suites: `policy-group-edit-intent`, `group-policy-submit-recovery`, `group-stale-recovery-copy`, `access-policy`, `policy-confirmation-content`, and `operational-integer-remount`.
- `npm run build` passed, including `tsc -b` and Vite production build.
- `git diff --check` passed.
- Independent source/test-design review accepted the corrected bounded patch. The reviewer did not run a separate suite.

These results are DOM and source/build evidence, not a new full-suite, browser/pixel, real-server or deployment acceptance. No commit, remote mutation, publication, credentials or deployment action was performed for this patch.

## Separate deferred observation

Read-only review also found that the manual usage-reset reason in UserPolicyEditor is outside the policy form and does not register its own unsaved state. Closing an otherwise untouched policy sheet can lose that reason. Its confirmation has no explicit owner cleanup, so departure behavior should receive a separate public-seam check. These are source observations only; this patch does not change or test that flow.

## Native fixture preparation

Four real-App synthetic GET-only journeys cover raw `-` with Cancel and raw `1e` with Escape at 390×560 and 1440×560. They require the discard decision, Continue with exact text/focus, blocked invalid Preview, explicit discard and clean reopening. All API writes are aborted; original masked screenshots, keyboard geometry and fixed-category ledgers use narrow artifact names. This small native fixture omits adoption/restart, which remains DOM-covered.

Strict native TypeScript passes. Supplemental discovery is 54 cases across 18 specs; five workflow contracts pass. Independent source review accepted selectors, context response shape, overlay keyboard flow, HTTP safety and evidence bounds. Required sandbox, workers, retries, time limits and discovery are unchanged. No native execution/pixel acceptance, lane-runtime acceptance or WebSocket protection is claimed.

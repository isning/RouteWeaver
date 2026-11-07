# Profile runtime numeric intent: bounded reconstruction

Source-only candidate based on a1fbbc3. Lost v98/v99/v100/v112 commits were not recovered; this is a new, deliberately split implementation.

## Implemented scope

Profile mixed proxy and DNS ports retain incomplete/invalid text, mark the draft changed, and block save, preview, and publication handoff until corrected. The accepted model is unchanged for invalid edits. Navigation retains runtime controls so raw intent survives tab switches, and blocked actions return focus to the offending control. Removed DNS controls no longer block unrelated work. Existing NumericInput, including arrow behavior, is unchanged. Untouched zero/absent optional ports are not reinterpreted. Applying configuration-intent JSON is an explicit replacement: it discards old raw numeric edits and errors and remounts only numeric input controls, even for unchanged accepted values or reused DNS IDs. Canceling or merely opening JSON, unrelated edits, and tab switches do not reset that lifetime.

Edited port lexemes are bounded to 256 characters with at most three exponent digits. Decimal integer equivalence is checked from digits before converting the port to Number; nonzero tails cannot round into an allowed integer. Accepted range remains 1–65535. Oversized/incomplete spellings remain editable and block requests.

## Verification

Agreed seam: ProfileEditor public controls and HTTP fetch requests. Authored regressions cover incomplete text, empty edit, exact fractional tails, huge exponent, tab retention, save/preview/publication prevention, focus recovery, valid scientific notation, DNS arrow correction, untouched zero/optional ports, removal of an invalid DNS server, explicit JSON replacement with changed/unchanged accepted values and reused DNS IDs. The parser also requires full-string consumption; text inputs sanitize newline characters, so newline rejection is source-reviewed rather than asserted through an impossible UI value.

All runtime verification is **UNRUN**: no Node, npm, Go, browser, server, installs, or network actions were used. No red/green pass or full correctness claim. Git diff whitespace check only. Independent source review identified a stale numeric lifetime after explicit JSON application. This follow-up repairs that finding; runtime validation and review of the repair remain pending.

## Explicit split and integration obligations

Group interval edits (existing group plus create-and-use modal), Collections per-source/aggregate override ports, and their exact-tail regressions remain outstanding. Do not describe this candidate as complete v98/v99/v100/v112 restoration.

Malformed DNS-default recovery is a separate candidate. This change does not repair or replace that logic. Integration must retain its malformed-data normalization when deriving live DNS control IDs and retest its fixtures. Source-only final review and full runtime gates remain mandatory before release. Preexisting invalid data requires full integrated UI regression review.

# Notification numeric intent reconstruction (source only)

Base: 3662b34242868b2aa1bc1124186dcefee47c6178. This is a new reconstruction from recovery-inventory.json entries v114/v115, not recovery of their original bytes or historical test results.

## Contract and changes

- Backend authority inspected: internal/notifications/model.go validateSettings. Repeat hours are integers 1–720. SMTP port is an integer 1–65535, including when email is disabled. Neither blank nor zero selects a default in these fields.
- Threshold lists accept at most ten unique positive integer values each. Quota/remaining percentages max at 100; expiry hours max at 8784 (366 days). Empty lists disable their reminder category. Order is preserved, not sorted or deduplicated.
- Decimal/exponent spellings must denote the exact bounded integer before Number conversion. Fractional tails that IEEE-754 would round away, incomplete numbers, hexadecimal, whitespace-bearing selected tokens, zero, out-of-range values and numeric duplicate spellings are rejected. A 4096-character resource guard bounds parsing; this is not a new domain maximum.
- Repeat and SMTP raw edits live in form state, including partial and blank input. Existing NumericInput arrow handling is retained. Failed saves preserve raw spelling and replacement secrets. Baseline revision and secret omission/explicit removal logic remain unchanged.
- The settings form delegates submit validation to field rules (noValidate) so a hidden SMTP input's native validity cannot swallow the attempt. Invalid email fields reopen the email accordion. Sender address gets an explicit field rule reading the native input typeMismatch flag because native submit validation is bypassed; it preserves the browser's email acceptance rather than imposing a different email regex. The other settings inputs have no native required/pattern/length/URL constraints. No changes apply to announcement forms.
- Shared MultiChoice remains unchanged: it trims custom search text when creating a selected token. Exact validation here governs selected tokens, not uncommitted combobox search text. There is no automatic list repair or replacement.
- Invitation code is untouched. Historical v114 notes distinguish invitation's initial 72 hours from its blank-input backend default of 24 hours; this reconstruction makes no invitation completion claim.

## Evidence and limitations

Added public DOM-to-HTTP regression source to notification-channel-draft.dom.test.tsx: invalid scalar rejection and repair, dirty partial edits, collapse/tab retention, failed-save retry with secrets and revision, rounded fractional/duplicate/invalid threshold rejection, list order, empty-list disable, ten/eleven thresholds. Existing tests cover never-opened channels and explicit secret removal.

Only source inspection and git diff --check were performed. Node/npm, TypeScript, Vitest, builds, Go, browser interaction, server runs, native input/focus, real backend and external delivery checks are all **UNRUN** under the source-only instruction. No red/green or behavioral pass is claimed. No installs, network, upload, push or deployment. This work does not establish whole-product acceptance. Independent source review checked raw-value ownership, native sender validity and scope; executable verification remains pending.

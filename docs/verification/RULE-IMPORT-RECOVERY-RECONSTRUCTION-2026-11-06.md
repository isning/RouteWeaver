# Rule-file import recovery: source reconstruction

## Provenance and limits

Based on saved integration commit `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`.
The missing v117 object `7b12232fabf5eff0bb9e7825a6767b89ece00ce6` is not
available. The recovery inventory reports frontend recovery work and explicitly
leaves the backend opened-revision gap unresolved. Its historical test totals
are not evidence for this source. This change reconstructs demonstrable source
risks, not historical parity.

All application execution is **UNRUN**: no Node/npm, Go/gofmt, test runner,
typecheck, build, browser, server or aggregate gate was run. No red/green claim,
runtime validation, native file-picker result, backend fix or deployment is made.
Only Git/Python/text inspection and editing were used. Git whitespace checks
are source hygiene, not behavioral verification.

## Source findings and changes

- `RuleFileImport` reads bytes only after explicit Save. Previously unmounting
  during that read suppressed later UI callbacks but did not prevent its POST.
  The dialog now owns an abortable read and a lifetime token. A removed dialog
  cannot start or finish preparation into a new write. Reader abort/error releases
  the pending mutation and retains the user's form and selected file for retry.
  Synchronous browser read exceptions now use the same cleanup path, removing
  installed handlers and the abort listener rather than retaining them after
  Promise rejection.
- `prepareFilePost` already captures session authority before reading bytes.
  Preserve that guard and add an optional dialog-owner check after the session
  wait, immediately before dispatch. Existing callers without this predicate
  retain their behavior. A write already dispatched cannot be recalled; late
  server success still invalidates resource queries, without closing another
  dialog or reporting its outcome in that dialog.
- Invalid local selection previously cleared the file and could leave a pristine
  form marked clean. Selection attempts now remain dirty until explicit discard
  or the new **清除文件选择** action. Clearing does not erase name/format choices.
  Invalid replacement still removes the prior file, so Save cannot upload old
  bytes in place of the rejected selection.
- Reset the native input after a nonempty selection, allowing the exact same
  file to be selected again after failure. An empty picker event preserves the
  current choice; only explicit clearing discards it. Selection changes and mode
  changes clear obsolete import feedback. Mode changes remain blocked while Save
  is pending, and the existing synchronous duplicate-submit guard remains.
- Parent `Resources` already keys each import instance. This patch preserves
  that ownership and the existing retry behavior after an HTTP failure. It does
  not change source import, resource inspection, template catalog, privacy
  disclosure, packaging, or resource acceptance payload semantics.

## Bounded public-seam regression sources

`web/src/rule-import-recovery.dom.test.tsx` uses the real rendered dialog/form,
query mutation, confirmation provider and API request path. Only browser file
reading, HTTP transport and the public session-transport boundary are controlled.
Ten cases specify:

1. Invalid selection on a pristine form requires discard review; continuing and
   explicit clearing removes the error and restores clean-close behavior.
2. Explicit discard after invalid selection closes without uploading.
3. Local read failure preserves draft, prevents duplicate Save while pending,
   and allows same-file reselection and successful explicit retry.
4. Canceled picker retains the prior selection, while invalid replacement cannot
   upload that prior file.
5–6. Old read success/error after unmount cannot upload or affect a new dialog.
7–8. Old HTTP success/error after dispatch cannot close or show feedback in a
   newly opened dialog.
9. A completed read waiting for session authority cannot dispatch a POST after
   its dialog unmounts and the wait resumes; the replacement dialog is unaffected.
10. A synchronous `readAsDataURL` exception releases the pending form, retains
    the selected draft, and allows explicit retry.

Existing `rule-files.dom.test.tsx` covers same-file retry after HTTP rejection
and avoiding hidden format-version metadata. `async-action-accessibility.dom.test.tsx`
covers busy action names/focus and repeat submission for both upload and HTTPS.
Those sources are unchanged and also UNRUN in this reconstruction. This new
bounded set does not independently exercise real authentication changes, native
picker cancellation, or complete navigation. The delayed session-wait test uses
the public `installSessionTransport` seam and unregisters it after each test.

## Still unresolved

The import request still lacks an opened-revision conditional-write contract
for an existing resource. No UI lifetime guard prevents another editor's
concurrent backend write. No server endpoint, persistence or revision behavior
is changed here. Backend transaction/authorization guarantees need a separate
implementation and HTTP/persistence evidence. Runtime review must also include
HTTPS fetch mode, session changes while preparation waits, actual file chooser
behavior, accessibility/layout and all integration gates before acceptance.

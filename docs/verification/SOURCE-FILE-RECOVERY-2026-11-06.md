# Source file ownership reconstruction

Source-only candidate reconstructed from baseline a1fbbc3. This is not recovery of the unavailable historical v105 (868e7d1) or v106 (11c762d) objects.

## Scope

Selecting a file immediately creates an unresolved local choice. Pending and failed selections register with the navigation guard, require the existing discard confirmation, and prevent both button and form submission from saving old content. The existing file picker retries the same file; an explicit cancellation preserves previous content and invalidates late reads. Typing content or switching import kind also invalidates file ownership and clears its status/error. Newer files supersede older reads. Successful reads retain the normal content-based dirty/save behavior. The existing 1 MB limit, accepted extensions, retained-save handling, source API payload, and local-read-before-upload boundary remain intact.

Public UI/File/fetch regression source covers delayed selection on a clean existing source, blocked form submission, close/continue/cancel, late completion, same-file retry after failure, mode switching and obsolete rejection, newer-file ownership, and successful submission of retried content. Existing manual-edit and oversize regression source remains. The retained-failure aggregate fixture now expects “last submission saved” when an oversized replacement is unresolved, rather than falsely describing the current selection as saved.

## Evidence and limits

- `git diff --check`: passed for the candidate source diff.
- Git and Python text inspection only. No Node/npm, Go/gofmt, test runner, compiler, formatter, server, browser, dependency installation, network, push, or deployment was run.
- All runtime checks, focused DOM tests, TypeScript, lint/format checks, aggregate suites, browser UX, and backend integration: **UNRUN**.
- Test source was added before the corresponding implementation, but no executable red/green cycle was possible; no failing-before/passing-after claim is made.
- The historical aggregate failure is not a pass; this fixture adjustment is unvalidated source, not evidence of aggregate success.
- Independent runtime review remains pending; original recovered baseline is unchanged.

## Remaining validation

Run the source-editor, source-controls, source-saved-failure, source-editor-close and navigation-related DOM suites with one worker, followed by the repository aggregate gate on the final integrated commit. Check deferred File.text completion after cancellation, unmount, repeated selection, and mode changes in an actual browser. The same-file retry relies on clearing the native input value, as before. File.text cannot be aborted; cancellation revokes its authority rather than stopping disk IO.

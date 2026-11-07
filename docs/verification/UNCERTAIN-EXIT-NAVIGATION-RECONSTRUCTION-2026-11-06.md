# Hidden uncertain exit navigation reconstruction

Source-only reconstruction from base `4e660eb0e0395a9ae0a0705408cbb56028f0d5d0`. The historical commit `7b1e02422e920207f8bb09cda9cc18a64929957a` was unavailable; this is a replacement candidate, not an exact recovered commit or executed acceptance result.

## Contract and changes

- A mounted route-exit task guards departure while saving or while its outcome is unresolved, even after its sheet closes. Merely closing the sheet does not cancel the operation or make its result known.
- Departure explains that the exit change may already be saved, leaving does not cancel it, and the page-owned recovery information will be lost.
- `useUnsavedChanges(dirty, warning?)` remains compatible with boolean-only callers. Each owner registers its own optional consequence in memory. `getNavigationWarning()` combines distinct consequences and retains the ordinary unsaved-draft consequence whenever another draft is registered. No first-wins selection hides another owner's risk. `hasNavigationWarning()` selects neutral departure wording instead of promising a saved operation can be discarded.
- The workspace confirmation also retains the unknown-history forward-history warning alongside task consequences.
- Existing TLS file-read pending guards, exact operation retry identity and durable terminal receipt validation are unchanged. No secrets, requests or recovery metadata are written to browser storage.

## Verification scope

Public DOM regression sources cover hidden unresolved save dismissal and reopening with the same operation, beforeunload cancellation and terminal cleanup; combined warnings from multiple owners plus a separate draft; duplicate wording, StrictMode cleanup; and actual workspace departure confirmation, cancellation and acceptance. Public UI seams were already authorized in the task and repository contract. Tests were authored before the corresponding implementation, but no executed red/green result is claimed.

Executed: `git diff --check` (passed). Source review checked guard lifetime, per-owner cleanup, aggregation and App wiring.

Not run: Vitest, TypeScript, formatting tooling, build, browser, server, Go or aggregate verification. The current recovery task explicitly permits only Git, Python and local source/text work. Focused future verification should include `navigation.dom.test.tsx`, `route-exit-editor.dom.test.tsx`, `workspace-shell.dom.test.tsx`, and the existing workspace-history suites, then serialized aggregate checks in a permitted environment. Independent review remains outstanding.

## Bounds

This is not durable recovery across reload, forced departure, page unmount or session loss. Browser beforeunload prompts are browser-controlled and can be suppressed. A metadata-only GET receipt recovery backend is absent; the existing explicit same-operation retry still depends on the mounted editor's memory. Navigation warnings cannot guarantee the user retains recovery data. No deployment, native runtime acceptance, network traffic acceptance, source publication or delivery is claimed.

# TLS read ownership source reconstruction

Baseline: a1fbbc3. This is a new reconstruction, not recovered historical commits 977c3e3 or a341c143.

## Scope

- TLS file completion uses the current value and current owner callback, so an earlier closure cannot replace a newer deployment draft.
- Certificate and private-key reads have independent generations. New selection, direct editing, cancellation, and layout-lifetime unmount cleanup invalidate obsolete results and errors. Layout cleanup revokes authority during replacement commit, before passive cleanup. File inputs clear their native selected value to permit same-file retry.
- Pending material blocks deployment save and route-exit preview (both disabled UI and request guards). Cancellation releases the gate without discarding existing material.
- Deployment updates target listener identity against the latest draft rather than an old array index. Removing a listener unmounts its reader. Explicit listener refresh invalidates only that listener; applying a replacement JSON intent invalidates the prior readers.
- Route-exit material retains endpoint identity and editable/recovery guards. Unrelated path edits and the paired PEM read no longer invalidate each other. Reviewed uncertain commit request/operation identity remains frozen in memory.
- No persistence of PEM or private keys was introduced.

## Regression source and seams

Public rendered UI, browser File.text boundary, and fetch requests. Added source covers paired reads plus newer name/path edits, manual PEM supersession, stale errors, replacement selection, cancellation, removed listeners, independent listener imports, same-ID listener refresh with an unrelated import pending, same-file retry, pending exit preview, and unchanged uncertain retry after cancellation. Existing retry tests remain in the suite. Fixtures are synthetic.

## Source review follow-up

A source review identified that passive cleanup left obsolete same-ID readers authoritative until passive effects ran. Cleanup now uses the layout lifetime: it revokes both read generations and reports that reader as no longer pending during the removal/replacement commit. Replacement cleanup precedes interaction with the new reader, while the parent retains the pending entries for other listener IDs. The same-ID refresh regression checks retained material, refreshed listener settings, and the independent pending save gate. It does not establish real-browser scheduling behavior without execution.

Native file inputs previously retained their selected value. Both now clear it after capturing the File, permitting explicit selection of the same file again. Added same-file cancellation/retry regression source; runtime support remains unverified.

## Verification limits

All executable checks are UNRUN: TypeScript compilation, formatter/lint, Vitest, browser UI, Node/npm, Go/gofmt, server, native runtimes, and aggregate verification. No red/green TDD execution is claimed. Only source inspection, Python text editing and Git diff whitespace checks were performed. Runtime and visual behavior remain unverified. Source review is ongoing.

Backend metadata-only GET receipt recovery is not implemented here. Reload-safe uncertainty recovery is not solved, and this change does not claim to solve it. File.text cannot be physically aborted; cancellation prevents its eventual result/error from changing the draft. This is frontend source reconstruction only, not acceptance, deployment or publication evidence.

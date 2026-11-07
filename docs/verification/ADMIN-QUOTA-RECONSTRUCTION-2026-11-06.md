# Admin quota write guard reconstruction: unverified source

Baseline: a1fbbc301378e47489660791e68f8c50fcf2b93f (v88). Historical v111 commit 09b9ef578c6c6d144584cfc40b9db4615461cc1c is unavailable. This is a new reconstruction of the recorded protection, not recovered historical bytes or a claim of equivalent verification.

## Source findings and repair

- `web/src/Admin.tsx`, `EntityEditor`: baseline mutation recomputed every `quotaGiB` with `Math.round(Number(...) * 1024 ** 3)`. This includes existing user edits where the quota control is disabled. New positive fractional bytes could become zero (unlimited), and Number conversion could discard typed decimal intent.
- `web/src/ui-patterns/numeric-input.tsx`: `onInputText` supplies the original text after numeric form updates. The reconstruction retains that text separately, includes raw-only edits in dismissal protection, validates on the raw-input trigger, and captures exact bytes again at submission. No shared numeric component changes.
- `web/src/observability-model.ts`, `measuredBytes`: existing bounded decimal parser uses BigInt numerator/denominator, rejects fractional bytes and values above Number.MAX_SAFE_INTEGER, and converts to Number only after checking. Reused unchanged for new quotas. Ordinary unsigned decimal notation with digits before and after a decimal point is supported; exponent notation, incomplete input, negatives, and more than 128 characters are rejected. This intentionally does not expand the shared parser contract.
- Existing nonnegative safe integer quotas are copied directly from the opening task's record, never reconstructed from their displayed GiB value. Existing unsafe quotas block Save, public-form submission, and mutation write construction, with a visible explanation that even rename/enable edits cannot safely be saved.
- Scope remains the Admin account editor. This is not a repair for JSON int64 transport, concurrent revision protection, other quota editors, or exact preservation of already-rounded API data. The backend remains responsible for validation and concurrency. Independent source review traced `internal/store/store.go` PutUser: it assigns `v.UsedBytes = old.UsedBytes` inside the transaction before policy storage. Submitted usage does not replace accumulated usage on this route. This does not resolve quota int64 transport or revision concurrency.

## Public regression source

`web/src/admin-task-lifecycle.dom.test.tsx` exercises AdminPage user tasks and records requests only at the external fetch seam. Cases cover explicit unlimited zero; half GiB; exact one byte; maximum safe bytes; positive sub-byte values; fractional bytes; raw decimals rounded by Number to a different intent; over-range input; blank/partial/exponent/negative input; correction without losing the draft; safe existing quota retention on rename/disable; blocked unsafe full writes even via form submission; and raw-only dismissal protection.

These tests were written against the agreed public Admin UI seam. They have NOT been run. No red-before-green, typecheck, lint, build, browser, screenshot, visual acceptance, backend enforcement, or end-to-end success is claimed. The runtime dependency set is incomplete and task instructions prohibit Node/npm/Go/browser/network execution. Only source inspection and `git diff --check` were performed; whitespace checks are not behavioral verification.

## References read

Repository AGENTS.md, GLOSSARY.md, docs/design/CONTENT-DESIGN-RULES.md, the existing form migration contract, and the locally recovered pinned tdd.md, tests.md, mocking.md, code-review.md reference texts under the recovery directory. No absent reference is claimed as executed. Independent review, when supplied, must be recorded separately from these source findings.

## Required next verification

When an authorized complete toolchain is available, run the focused Admin lifecycle suite with one worker, TypeScript/build/style gates, then relevant full web regression gates. Review the new warning, invalid-input recovery, dismissal protection and narrow-screen layout in the rendered app. Review exact-int64 transport and full-write revision semantics independently before claiming product completion.

# Personal override draft continuity

2026-11-12. Isolated patch based on `4cb5ad9`. Production scope is `UserPolicyEditor.tsx`; shared numeric controls, backend semantics and the existing visibility helper are unchanged.

## Observed failure and existing protections

The initial 16 public editor cases produced **6 failures and 10 passes**:

- Four failures: clear an enabled personal quota/IP/connection/rate input, then collapse its accordion. Visible validation had blocked Preview, but after collapse Preview sent the cleared property as null without the user disabling the override.
- Two failures: incomplete online-IP `-` and rate `1e` reopened as the old numeric displays `17` and `1`. Their pending ledger still blocked requests, so these were display-continuity failures, not request bypasses.
- Passing controls: nonempty incomplete text stayed blocked after collapse/direct submission and protected Cancel; explicitly disabling an override sent null; explicitly choosing zero sent 0.

The transport and backend distinction matters. `types.ts` and `service-policy-edit.ts` permit null overrides. `internal/service/cycle.go` uses nullable pointers; `internal/service/effective.go:130-144` applies individual values only for non-nil pointers. Null therefore restores inherited/base policy, whereas zero is an explicit unlimited override. Backend validation correctly permits null and cannot infer the editor's still-enabled checkbox.

## Narrow change

The request boundary now checks enabled override values independently of mounted field rules. Blank enabled fields cannot serialize as inheritance. The native form and guarded Preview paths reopen invalid hidden overrides before the existing form validation/focus recovery runs. Opening-motion reveal reuses the existing helper without replacing it.

Controls receive their existing unfinished text when remounted. Valid-value normalization and explicit current-value discard retain the established personal-editor contract. This does not transplant service-editor last-accepted-value behavior. Date-picker command-start guards, cycle pending ownership, latest-generation invalidation, usage-reset ownership and explicit adoption semantics remain unchanged.

Explicit checkbox-off inheritance and enabled zero still work. A blank draft can be intentionally replaced through latest-version adoption, with its enabled flag and null form value preserved in the separate unsaved copy; the new active editor uses the authoritative saved value.

## Verification

The original 16-case file passed after the patch. The expanded file contains 41 cases, including all four override types, direct submit, collapsed reveal/focus, correction, Cancel/Continue, explicit inheritance, zero, fresh reopen, latest/copy reset and held read/preview invalidation.

```sh
cd web
npm test -- --maxWorkers=1 \
  src/user-override-draft-continuity.dom.test.tsx \
  src/policy-entitlement-edit-intent.dom.test.tsx \
  src/user-policy-submit-recovery.dom.test.tsx \
  src/usage-reset-ownership.dom.test.tsx \
  src/policy-control-settlement.dom.test.tsx
npm run build
```

Final result: **105 tests passed in 5 files**, one worker, followed by successful TypeScript and Vite build. Independent source review found no blocker in the bounded change.

No aggregate-suite or native-browser acceptance is claimed by this patch. Actual keyboard behavior, animated focus visibility and viewport geometry remain native acceptance work. No main-checkout source, external state, credentials, live policy, commit, publication or deployment was changed during isolated preparation.

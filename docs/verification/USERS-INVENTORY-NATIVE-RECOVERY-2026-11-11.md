# Users inventory native recovery coverage

This supplemental fixture adds two native cases at 390×560 and 1440×900 for the localized Users recovery implementation. It is not a native execution or pixel-acceptance claim. The supplemental configuration now discovers 70 cases in 21 specs; required full discovery is unchanged.

## Public task and safety

The actual App uses exact synthetic loopback HTTP. All API mutations and unexpected reads are blocked. The task uses keyboard search, page two, an opened row menu, browser offline/online reconnect, failed dependent services read, disabled stale row actions, keyboard retry held pending, and recovered correct-user platform entry. The ledger records only counts and fixed rejection categories. No real account, credential, server mutation, publication or deployment is involved. HTTP routing does not claim WebSocket coverage.

Real wall time must exceed the application's existing 15-second query staleTime before reconnect. A bounded 17-second polling precondition starts only after the initial ready row and its opened menu are observed, later than the entire inventory query success. This establishes the freshness boundary without incorrectly timing from a component HTTP request. This is separate from interaction budgets; test timeout, interaction timeout, retries, normal animation and browser sandbox remain unchanged. No synthetic clock or CSS animation overrides are used. The existing 45-second test budget is unchanged and not yet runtime verified for this fixture.

Open-menu disabled selection is covered; selecting an item immediately before its close callback and then losing read authority is explicitly not proved. Correct-user attribution is checked for platform entry, not successful authorization-form loading or server persistence.

## Evidence contract

All explicit output filenames begin `users-inventory-`. Six original viewport screenshot/geometry stages are allowed exactly: cached-error-open-menu, retry-keyboard, retry-pending, recovered-entry-keyboard, correct-user-entry, final-original. The independent users-inventory-request-ledger.json survives capture/assertion errors. Automatic screenshots, traces and videos remain off; explicit screenshots mask password/key/token inputs and textareas. No scripted focus/scroll, overlay reconstruction or reduced-motion override is used. Keyboard retry and recovered entry assert focus-visible, viewport and hit geometry.

The workflow allowlist restricts each filename to this spec's output directory and excludes a generic request-ledger.json. Contract checks cover retained representative filenames and rejected unrelated/private artifacts. Screenshots at both widths still require independent inspection after authorized native execution.

## Local verification

- Strict targeted TypeScript for the new spec and ui-settled-task helper passed using the installed compiler from web with --ignoreConfig, --strict, ES2022, bundler resolution and noEmit. Initial invocations from the repository root and without --ignoreConfig failed on compiler invocation setup; neither was a source error or a pass.
- Playwright supplemental discovery passed: 70 tests in 21 files. Discovery did not launch a browser.
- All five supplemental workflow contract tests passed.
- Native execution, screenshot review, remote CI and full-suite verification of this native-only commit are not claimed. The coordinator's concurrent full DOM run is separately tracked.

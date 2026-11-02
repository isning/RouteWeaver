# E13: joined subscription-origin settings journey

Source base: `23650ca`. This change adds acceptance tests only; it does not change
production settings, verification policy, network access or trust configuration.

## Added coverage

- `web/tests/settings-origin-backend.api.spec.ts`: isolated normal control-plane
  CLI, authenticated HTTP and real persistent revisions. Invalid saves leave the
  state unchanged; stale saves and stale activation reviews are rejected; a saved
  custom origin cannot activate without proof; an explicitly reviewed default
  origin activates and persists its configured revision.
- `web/tests/settings-origin-backend.ui.spec.ts`: two authored browser journeys at
  1440 and 390 px, using the same isolated normal CLI and actual built frontend.
  No API fulfilment or session bypass is used. An independent authenticated admin
  client makes concurrent changes through the public API.
- The browser journeys require invalid/stale draft retention, refreshing the
  saved preview without overwriting local text, successful retry, saved/effective
  separation, unverified activation denial, Escape cancellation with opener
  focus, stale-confirmation rejection, checkbox/Enter keyboard approval, and
  persisted default activation after reload. The exact eight browser mutations
  and statuses are asserted, including no verification probe or surprise write.

## Local validation

- New isolated API companion: **1 passed**, 381 ms test body / 10.6 s harness.
- Existing `TestSubscriptionOrigin*` Go HTTP tests: **PASS**, 0.326 s.
- Existing subscription-origin DOM suite: **3 passed**, 2.97 s.
- Application TypeScript check: **PASS**.
- Strict TypeScript check explicitly including all three new test files: **PASS**.
- Playwright discovery: **2 browser cases discovered**, not executed.
- Whitespace check: **PASS**.
- Pinned Gitleaks current-tree scan: **PASS** (1,824 path/content pairs);
  final all-history scanning belongs to the integrated candidate gate.

Commands used the repository's pinned Node/Go tools. Explicit test-file type
checking uses `tsc --ignoreConfig --types node --noEmit --strict --skipLibCheck
--target ES2022 --module ESNext --moduleResolution bundler` because the normal
application tsconfig does not include `web/tests`. The initial CLI configuration
attempts were corrected before the successful check; they were not test passes.

## Remaining evidence

Browser execution remains **UNRUN** pending authorized CI; discovery and API/DOM
passes are not joined browser evidence. Do not close E13 solely from this report.

Custom addresses under `.example` are draft strings only. This journey makes no
DNS request and performs no custom-domain HTTPS probe. Successful external HTTPS
verification and custom-domain activation remain the existing HTTP transport-seam
tests plus the eventual authorized target-domain check; default-origin activation
is not evidence that a custom public domain works. The `tokensUnchanged` assertion
checks the settings contract, not a new downloaded-feed token-identity experiment.

Repository AGENTS.md was read. The referenced local engineering skill files were
absent, and the pinned official tests skill URL returned a cache miss; this report
does not claim that unavailable skill was executed.

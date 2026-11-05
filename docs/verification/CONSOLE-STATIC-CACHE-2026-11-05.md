# Console static delivery and production measurement

## Finding

Restored baseline `a9d7590` applies `Cache-Control: no-store` to every response, including Vite's fingerprinted JS, CSS and fonts. Its Go static handler does not compress responses. A normal new document therefore cannot reuse those static responses from HTTP cache. This is source evidence about this server, **not a measurement or established explanation of the owner-private Site's reported delay**. A hosting proxy can have different transfer/compression behavior.

A fresh production build of that restored head gave a default Subscriptions static closure of 764,803 raw JS bytes (242,420 per-file gzip estimate) plus 155,325 raw CSS bytes (24,242 gzip estimate). Fonts, dynamic imports, API/auth work and browser CPU are excluded. See `../design/qa/console-static-cache-20261105/bundle-restored-head.json`.

Existing query/loading behavior remains unchanged: session validation precedes private reads; overview/profiles/outputs then load independently; initial loading is not an empty inventory; QR and graph modules remain deferred. No auth prefetch, artificial delay, timeout increase or speculative route split was added.

## Narrow correction

- The normal Vite production build now emits `.vite/manifest.json`; existing package copying includes it.
- Only an exact manifest-listed `assets/<name>-<eight-character-fingerprint>.(js|css|woff|woff2)` path is eligible for `public, max-age=31536000, immutable`.
- Files must be regular, bounded files. Their SHA-256 is recorded at server startup and checked against the exact byte snapshot served. Unlisted files, encoded/normalized path aliases, symlink replacements, changed bytes (including unchanged size/mtime), missing/malformed manifests, new assets introduced after startup, HTML and SPA fallback retain `no-store`.
- A response wrapper applies the policy at status write time: successful verified 200/206/304 may be immutable; errors including 404/412/416 are `no-store`. This matters because Go's `ServeFile`/`ServeContent` can remove cache headers on error.
- Security headers and API/feed handling are unchanged. No gzip, service worker or public endpoint was added. HEAD remains the pre-existing router behavior; no HEAD support is claimed.

Deployment still requires a coherent build and process restart. Retain old fingerprinted assets during a rollout if existing documents may request them. Do not overwrite content under an existing fingerprint: earlier browser-cached immutable bytes cannot be revoked. If the server observes such an overwrite, it will not label new responses immutable. A missing old lazy chunk still uses the existing page-load recovery path.

The cache check reads at most 16 MiB per eligible asset request and compares hashes. Actual current assets total about 2 MiB; there is no per-user server cache. A browser cache hit avoids that request. This improves repeat-document transfer opportunity; it does not reduce cold-transfer bytes or establish an end-to-end latency improvement.

## Verification status

- **Passed locally:** production TypeScript/build with manifest; production bundle script; new browser test independent TypeScript check; discovery of two browser cases; whitespace check.
- **Not run:** Go compile, gofmt, HTTP regressions or full gate, because this restored environment has no verified Go compiler. Both attempted focused commands failed at compiler discovery before tests. Tests were authored before the implementation, but **no observed red/green result is claimed**. Exact-source CI must run them.
- **Not run locally:** the new production browser cases. Local Chromium is host-denied and was not retried. Existing authorized CI must provide execution evidence.
- An independent source review checked cache scope and production manifest inclusion. It identified Go error-response cache-header removal; the implementation and regressions now cover every static branch, including uncached HTML and missing-index errors. Source review is not a compile/test pass.

Focused HTTP cases in `internal/httpapi/static_ui_test.go` cover listed/unlisted paths, malformed manifests, aliases, private endpoint responses, security headers, deployment mutation, missing assets, symlink replacement, valid 206/304, and uncached 404/412/416 outcomes.

## Production browser measurement

`web/tests/console-production-loading.ui.spec.ts` joins the existing browser gate at 1440 and 390 px. It reuses the established isolated-control-plane fixture: actual production Vite build, actual Go handler, fresh synthetic account/database and ordinary UI login. A fresh browser context receives only the resulting in-memory session cookie. No owner credentials or data are used.

No network interception is installed, because routing disables HTTP cache. Cold visit uses the fresh context; warm visit leaves to `about:blank` and opens a new document in the same context, preserving HTTP cache but not React/module/query state. Both visits must revalidate identity and read the real overview/profiles/outputs with `no-store`.

The test records sanitized navigation/paint/resource timing, transferred/encoded/decoded sizes, browser version and exact CI source SHA in JSON before cache/budget assertions. It verifies actual hashed production assets rather than Vite source modules, identical cold/warm asset paths, positive cold transfer and zero warm static transfer. Coarse 850,000-byte JS and 180,000-byte CSS decoded-size budgets catch major initial-bundle regressions; they are not an acceptable-UX claim or elapsed-time SLA. `readyObservedAt` includes assertion/collection overhead and is not an instrumented application-ready timestamp.

The current working-tree bundle JSON includes concurrent independently owned UI corrections; it is not a cache-only byte-reduction comparison. No bundle reduction is claimed. CI timing is unthrottled loopback data, not hosted-Site TTFB/FCP/LCP evidence.

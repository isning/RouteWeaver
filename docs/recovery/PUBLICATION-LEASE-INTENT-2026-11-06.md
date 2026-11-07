# Direct-publication lease reconstruction

Reconstructs missing v121 intent from recovery-inventory.json (historical commit 7d4157791f77e98393fbe2ec0a60234a9ce18ac7), not original bytes. Depends on the scoped OperationalIntegerInput introduced by Fleet reconstruction.

Default remains 300 seconds. Exact decimal/exponent integer values in 30–3600 are accepted, matching internal/httpapi/publication_requests.go; blank, zero, malformed, out-of-range and rounded fractional intent are retained and rejected before publicationRequests.start can persist or send a request. Every edit resets access/quota confirmations so approval cannot survive a changed lease. Existing deployment revision/fingerprint checks, actor ownership, request uncertainty, dismissal, retry and storage reconciliation are unchanged.

New public DOM test source: web/src/publication-lease-intent.dom.test.tsx. Uses real publication owner and rendered page with HTTP boundary fixtures; checks no outgoing publication or durable envelope for invalid input, exact valid payloads and renewed confirmation after edits. All behavior tests, typecheck/build, browser/backend and aggregate validation are UNRUN. Historical passes are not evidence for this reconstruction. Source inspection and git diff --check only.

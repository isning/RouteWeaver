# Usage-reset native fixture diagnosis

Prepared against cdf9196 checkout; no checkout edits. Patch changes only web/tests/usage-reset-ownership.ui.spec.ts, adding exact synthetic GET /api/rates -> [].

The six failing journeys begin at #services via enterUsersFromServices. App renders AdminPage; Admin.tsx:904 mounts RateSettings only for Services; Rates.tsx:54–56 requests list('/rates'), and api.ts prefixes /api. The fixture omits this read. Direct #users Cancel/Escape journeys pass and do not mount RateSettings. This is a legitimate Services-page dependency, not evidence of a reset operation making an unauthorized API request.

Exact da66409 artifact: ci-evidence-da66409-13875953631. All ten ledgers have reopenedClean=true, zero page errors, and correct write/reset-settlement counts. Six navigation journeys fail only final rejected-ledger assertion: Stay has one rejected read per width, retirement/Leave have three per width. Held Stay has reason focus events 0 before/1 after decision; Leave has 0/0. Navigation milestones complete. Original navigation-left.png at 390px visibly shows the Services rates section failing to load, consistent with the missing rates response. Initial mount, subsequent remount and configured query retry explain why leaving creates more reads; sanitized fixed-category artifacts do not preserve URLs/timing, so individual historical rejected requests cannot be conclusively attributed.

Safety unchanged: exact path only; API query metadata still rejected; method guard still blocks writes; only existing held-reset allowance is writable; unexpected reads still fail; ledger not relaxed. No production/configuration changes proposed.

Validation: git apply --check passes against checkout; copied native fixture strict TypeScript passes using ES2022/ESNext/bundler, skipLibCheck, types node. Initial isolated typecheck failed because copied helper dependency and explicit node types were absent; adding the existing helper to the temporary validation directory and enabling node types resolves the setup issue. No browser execution or full suite run; local browser restriction respected. Native CI rerun is required for corrected execution evidence. Historic da66409 object is not present in local Git, so source chain inspected in current checkout. Pinned /workspace/shared/routeweaver-skills files are absent in this executor; not claimed read.

Apply fix.patch; web/tests/usage-reset-ownership.ui.spec.ts is also supplied as full patched file. Auxiliary copied helper files are unchanged and are not part of patch.

# Console loading reconstruction — 2026-11-02

The workspace reset lost the unpublished loading commits (`ca3b3ef`, `2b182bd`, `cbadbb1`, `3aed3b5`), build output and test logs. This branch reconstructs their intended behavior on verified archival baseline `87444b7` (accepted application bytes `87bfac5`) from retained task context and edit inputs. **This is new code, not a byte-identical recovery. Historical test passes and bundle measurements do not validate it.** Fresh combined verification is required.

## Recovery milestone 1 (not yet tested)

- Shape-matched shared table/cards/form/field/subscription/summary placeholders; one named loading status, decorative shapes hidden from assistive technology, reduced-motion support.
- QueryState prioritizes actual errors, distinguishes an initially paused network read, and does not alter the caller's cached-data policy.
- Auth confirmation and lazy route fallback use skeletons. Subscriptions is loaded through the existing tagged lazy-page boundary after authorization; session/cache boundaries are unchanged.
- Subscription inventory keeps available data and the create action while missing data loads. Initial paused reads do not become false empty/missing results. Overview gets a summary placeholder.
- QR rendering and legacy graph canvas load only on demand with local error boundaries. QR failure leaves link/copy/Close outside the boundary. Graph failure leaves the ordered editor available. No invented success, artificial delay, timeout increase or access bypass.
- Unchanged infrastructure read/name helpers moved out of the server page; old exports retained.
- A reconstructed `web/scripts/measure-bundle.mjs` walks production static import closures and reports raw/per-file gzip bytes. Run after `npm --prefix web run build -- --manifest`, then `node web/scripts/measure-bundle.mjs web/dist`. It does not measure latency or count dynamic imports/fonts/HTTP/CPU.

## Evidence limits and remaining reconstruction

No durable original patch/bundle or original before/after JSON survived in the permitted workspace. The previous loading-only numbers (shell raw -21.3%, gzip -19.4%; subscription gzip +2.2%) are historical context only, not current measurements. The original private preview static analysis and empty runtime-log query do not establish hosted speed or a cold start. Hosted TTFB/FCP/LCP/auth/platform latency remains unmeasured.

Remaining work at this milestone: replay initial page read gates and the finite 24 secondary + 2 inline read corrections; restore focused regression cases and selector alignment; reconstruct browser-controlled loading/import-failure evidence. No local Chromium, native operations, CI or publication are authorized to this worker. Coordinator owns fresh aggregate validation and checkpoint upload.

## Recovery milestone 2 (not yet tested)

Replayed the main page read layouts and finite follow-up inventory: 24 formerly missed shared read boundaries plus two inline reads (profile linked-output summary and published-route user selector). Disabled reads retain their task guards: initial profile supplied/no output, planning closed, non-lifecycle Fleet plan, closed user-entry task, unselected user, and direct diagnostic mode. Existing mutation/manual states and collection-dependency `isFetching` freshness are unchanged. User assignment keeps cached selection/credential input on background failure and retains its submit guard.

Replayed the six known DOM selector adjustments and the existing creation-entry browser loading assertion. They target named loading feedback, actual section/card containers, and saved-draft status without removing downstream behavior assertions or changing timeouts. Remaining `isLoading` occurrences belong to the manual Security session machine, child empty messages already protected by QueryState, or profile-entry feedback that explicitly handles `isPaused` first. These source observations are not a fresh test pass.

## Recovery milestone 3 (not yet tested)

Reconstructed the 20 secondary-read and two inline-read regression cases from retained source/edit context. They cover six initial paused→pending→error→retry→cached-background-refresh journeys, ten other active offline panels, four disabled-task guards, profile draft continuity and assignment field/input/close/background-error continuity. No old test result is being reused.

## Recovery milestone 4 (prepared, not yet tested)

Reconstructed five loading-state and one interrupted-QR DOM tests, plus four Playwright cases for module→data→content transitions at 1440/390 px, superseded route import and interrupted QR copy/Close. Browser tests explicitly use the existing Vite **development** harness, normal demo login, document reload, assertion-controlled response gates and reduced motion. They attach static-resource/paint/mark observations and screenshots without absolute timing thresholds or production-speed claims. Browser tests have not been executed locally. Test sources/formatting are newly reconstructed, not recovered original bytes.

## Fresh reconstruction validation

- **96/96 tests passed across ten focused files**, one worker: `loading-states`, `qr-loading-recovery`, `secondary-read-loading`, `inline-read-loading`, `creation-entry`, `secondary-read-states`, `subscription-content-decisions`, `subscription-overview-status`, `ux-recovery`, `workspace-return` (all `.dom.test.tsx`). This is a new run, not the lost historical 157/146/88/104 results and not a full-suite claim.
- Application typecheck and production build with manifest pass. Reconstructed browser test is separately typechecked and four cases are discovered with `--list`; neither is browser execution.
- Browser interception assertions explicitly prove `/src/Subscriptions.tsx` and `/src/Sources.tsx` module requests, both inventory reads, and a `node_modules` QR dependency request were intercepted before the associated phase is claimed. QR component is at `src/ui-patterns/qr-code.tsx`; graph wrapper/canvas are now at `src/route-graph.tsx` and `src/route-graph-canvas.tsx`. The browser cases do not claim graph-module measurements. These reconstructed paths should not be inferred from old filenames.
- Fresh production static-closure output for **this loading-only reconstruction** is `qa/console-loading-recovery-20261102/bundle-reconstructed-loading.json`. Final combined layout/copy bytes and a fresh accepted-baseline comparison remain coordinator work; no historical artifact was fabricated.
- No local browser, native operation, CI run, hosted deployment or platform-latency measurement was performed. Full combined behavior/browser gates remain pending. `git diff --check` passes.

## Independent review correction (baseline `8364e96`)

Three fresh-review findings were reproduced with public render seams before correction: endpoint description named the wrong consumer (transfer path rather than legacy chain configuration), admin settings used a table skeleton, and the nested profile-editor module boundary still used bare prose. `loading-review-recovery.dom.test.tsx` failed exactly those three checks before the fix; the inventory table-shape control passed. The narrow correction changes those three presentations only. The module-gate case also checks transition into an editable draft, canceled departure retaining that draft, and no HTTP writes. Post-fix validation is pending at this checkpoint.

Post-fix result: **37/37 tests passed across six focused files**, one worker (`loading-review-recovery`, `settings-tab-continuity`, `admin-history-presentation`, `creation-entry`, `initial-form-commit`, `workspace-return`, all `.dom.test.tsx`). Typecheck and diff check pass. This is a fresh narrow regression result; combined full-suite/browser validation and the independent delta re-review remain coordinator-owned.

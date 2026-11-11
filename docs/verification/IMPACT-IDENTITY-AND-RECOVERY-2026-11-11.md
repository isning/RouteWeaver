# Impact identity and recovery review — November 11, 2026

## Verified previous checkpoint

Exact `59f62052fbab00adb3ddfef012bd3dbb0df4b31a` passed all 18 jobs in Repository quality run [42988041338](https://github.com/isning/RouteWeaver/actions/runs/42988041338), including its required aggregate. The four supplemental/focused workflows also passed. These results belong to that commit, not the identity changes below.

Recovery artifact 13839799891 from [42988041312](https://github.com/isning/RouteWeaver/actions/runs/42988041312) has verified ZIP SHA-256 `310190f324dd466879f9321ecd58687a67815d992d55cca79ab089ad21f548aa`. Independent original-PNG/ledger review supports:

- Both 390×560 keyboard failure retries and their outlines are contained at y511.5–555.5, replacing the previous clipped y528.5–572.5 position. Desktop retries are contained at y386.5–430.5.
- Both widths retain the repeated four-request/two-retry keyboard flow. Concurrent checks keep the latest result after an older completion and do not reopen a dismissed result.
- Remaining visual defects/limits: the narrow long result heading encroaches on Close; immediate returned-focus PNGs lack a painted ring despite focus-visible observations, while later final-state images show it. Capture timing is a hypothesis, not a proven explanation. Whole-product visual acceptance remains open.

These are synthetic Chromium tasks, not live deployment or backend proof. The current local sandboxed Chromium could not start because host socket creation was denied; browser isolation was not weakened.

## Affected-account identification

A public impact-review regression reproduced indistinguishable same-name affected accounts on separate review pages. The comparison previously showed only the catalog name, so pagination did not provide an identity clue at the consent decision.

The review now determines collisions across its complete affected-account set, including missing-catalog ID fallbacks. Colliding names retain their original text and show separate labeled stable-ID metadata; headings expose that identity to assistive technology. Unique names remain uncluttered. No policy values, requests, consent or apply behavior change.

Independent review identified an ambiguity in an intermediate generated-suffix approach. Separate metadata replaces that approach; regressions also retain a literal decorated account name to distinguish it from generated identity metadata. This is ordinary duplicate-label clarity, not immunity to deliberately deceptive names.

Validation: the first public regression failed before the fix. The final production change passes 48 tests across access-policy, group-submit recovery and stale-group recovery; the final added literal-name test cases pass separately. Application type checking and production build pass. An overlapping full-suite run imported an intermediate test revision and failed its two subsequently corrected accessible-name expectations; it is not claimed as a final-source full pass. Exact new-commit full CI and native/pixel validation of this identity presentation remain pending.

## Result heading / Close clearance

Original narrow result PNGs above establish the title crowding the focused Close button. TaskSheet reserved 56px, exactly the 12px right inset plus 44px Close width, leaving no clearance for its 3px focus ring. Its header now reserves 64px, matching TaskDialog; this is spacing, not smaller text or a reduced hit target.

The native recovery observation records title-right, Close-left and their separation for the open result sheet. Both pointer and keyboard journeys require at least 4px clearance after saving original PNG/JSON evidence. No focus or scrolling is injected to satisfy this assertion. Existing filenames and artifact allowlists are unchanged.

Independent source/original-pixel review accepts the bounded correction. Fourteen overlay behavior tests, application types/build, strict native-spec TypeScript and 28-case recovery discovery pass. New-commit native geometry and pixels still need CI review; local startup remains blocked as described above. The immediate returned-focus painting caveat remains separate and unresolved.

## Exact heading reacceptance and route-account continuation

Exact b95e530 recovery run [42993856212](https://github.com/isning/RouteWeaver/actions/runs/42993856212) passed. Artifact 13843645745 has verified ZIP SHA-256 `aa043911180546ee723648fcb5fd195a2b4b58d950192d0c93c4cd5289c69635`. Independent review inspected all eight pointer/keyboard result originals and measurements. Every result records 8px title/Close separation (narrow 326→334, desktop 1376→1384); the narrow heading wraps clear of the button and focused ring. Failed retry containment remains intact. This closes the specified captured-state gap, not all-screen acceptance or the immediate return-ring caveat.

The route-account continuation audit reproduced duplicate account names being indistinguishable in “线路使用用户”. The same unqualified name then appeared in the locked account field when preparing an entry. A local shared choice builder now uses a linear pass over distinct identities and adds separate ID metadata only for colliding labels. The open option, collapsed selection and locked next-step value retain that identity; option accessible names and name/ID search are explicit. Unique names remain unchanged. IDs still own selection, URL and API addressing.

A public regression failed before the correction and passes after: choose Bob among two identically named accounts, observe Bob's URL and authorization GET, then verify Bob remains identified in the locked entry-preparation selector. The entire journey performs only GETs. Sixty-three related line-workflow, path and concurrent-edit tests, application types/build and whitespace checks pass. Independent review accepts the bounded change. Native duplicate-account layout and assistive-technology acceptance remain pending; older originals do not prove this new state.

## Independent limit-source hierarchy follow-up

The populated group-decision originals from baseline `59f6205` showed repeated long plan provenance on one side of mobile limit comparisons when the opposite side had mixed sources. The existing proof required both sides to share provenance before either could be summarized. The follow-up applies the unchanged proof separately to each column: proven repeated numeric-limit sources appear once; mixed, unknown, mismatched and catalog-only sources stay inline. A neutral `来源` row with `见各项` on an unproven side avoids claiming a shared origin. Each consolidated numeric cell describes only its own source cell. Stable-ID disambiguation, single-limit comparisons, non-limit fields, consent and apply behavior are preserved.

Verification at the existing public PolicyEditor seam: the new asymmetric-source case failed before implementation and passed afterward. Final related access-policy/source/pairing tests passed (77 cases), including all 25 source cases after independent review added both-mixed and same-name cross-column cases in both orientations. App type/build passed. Native group-decision assertions now verify the incoming account's own source association and source-free numeric cells. Native spec strict TypeScript passed; supplemental discovery lists 32 cases across 10 files. The existing real-backend group journey is added to the supplemental recovery lane with its bounded original PNG/ledger uploads; required gates, Chrome sandbox verification, fixture lifecycle, timeouts and retries remain unchanged. Five workflow contract tests passed.

This is source/DOM acceptance, not pixel acceptance. Fresh narrow/wide native group captures are still required. The earlier mobile loss of account/column headings while scrolling remains a separate navigation-context opportunity; source consolidation does not claim to solve it. Local native browser launch remains host-restricted and is not bypassed.

CI checkpoint: `6063b0a` completed full Repository quality successfully (run `42993327318`) with all four focused/supplemental workflows green. `ae91497` completed its four focused/supplemental workflows, including native recovery run `42996160341`; its full Repository quality was still pending at this check. Screenshot creation/green assertions are not independent pixel acceptance.

Local offline Python helpers passed (108 tests). An attempted broad Python discovery also included scanner integration: 42 subtest failures were caused by the unavailable pinned Gitleaks executable, so this is not a full local security/static-gate pass. Required CI remains authoritative; no guard was weakened.

## Group choice identity follow-up

Group service/member choices previously appended IDs directly to duplicate names, so an ordinary duplicate such as `Same person`/`u1` rendered identically to a different account literally named `Same person（u1）`. Selection values were distinct, but the user-facing options and removal actions were ambiguous.

Choices now keep the raw name and show separate ID metadata when names are duplicated or a literal name resembles another option's generated identity caption. Precomputed name/ID and potential-caption collections keep construction linear, preserve ordinary unique labels, and cover literal-caption chains. Explicit accessible labels and search text preserve stable-ID lookup, selected-value context and distinct removal actions. Raw service/member IDs and preview preconditions are unchanged.

Verification: the original literal-parentheses regression failed before implementation. Independent review caught a residual literal-accessible-caption collision; its regression also failed before the caption-set correction. Both forms now pass through the public editor, including ID search, removing only the intended member, and previewing the correct service/member IDs. All 96 related group/source/pairing tests passed. App TypeScript/Vite build and native group-spec strict TypeScript passed. Independent final source review found no blocker in this bounded scope. The existing native group decision selector was updated to the new accessible service caption; its search remains compatible because the choice filter includes accessible labels. Fresh wide/narrow captures and independent pixels remain pending publication. No universal encoding guarantee for arbitrary delimiter-bearing identifiers or new runtime enforcement claim is made.

Final local whole-suite recheck: application/test source `12d96c4` passed all 4,027 DOM tests across 324 files (one worker, 1,054.52 seconds), completed around 2026-11-11 11:25:39 UTC. This includes the route/settings isolation changes, corrected cross-page contracts and group identity fixes, superseding earlier local whole-suite limitations for those changes. Native execution and original-pixel acceptance of unpublished changes remain pending.

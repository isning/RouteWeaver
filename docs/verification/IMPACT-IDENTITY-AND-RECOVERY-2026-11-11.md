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

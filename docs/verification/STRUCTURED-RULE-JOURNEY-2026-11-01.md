# E07 structured editor and owned-rule update evidence

Base: `23650ca`. Production change is limited to the DNS enable handler in `Profiles.tsx`.

## Reproduced defect and fix

Enabling DNS from the off state previously created a random resolver ID but set `dns.final` to the unrelated string `primary-dns`. The new DOM regression failed on this exact mismatch. The handler now assigns the same generated ID to the resolver and final selector. It does not contact DNS, change a target, or alter validation.

The regression also edits DNS, enables sniff/TUN, receives a simulated 409 save rejection, verifies retained values and retries the identical draft. These are component-level retention assertions, not proof of a real backend optimistic-concurrency contract. The first test authoring attempt incorrectly started with DNS already enabled and was corrected before the recorded product RED.

## Executed acceptance

- `profile-content-hierarchy.dom.test.tsx` and `rule-files.dom.test.tsx`: 9 tests passed. Covers exact resolver reference, dirty draft/error retention, busy controls, identical retry, retained uploaded rule file and bundle-only delivery UI.
- `TestStructuredRuntimeAndOwnedRuleVersionPublication`: both engine subcases passed under the race detector (4.185 s). Real owner invitation, HTTP persistence, preview, ZIP download, resource replacement, stale review denial and explicit publication are joined in one test.
- For each engine, a pinned and a following profile begin at the same accepted owned file. Replacing the resource head changes neither frozen output; a stale follow review is rejected; fresh explicit publication retains old bytes for pinned and selects new bytes for follow. Publishing one does not alter its sibling.
- Structured DNS/sniff are present in both generated configurations. Sing-box TUN is present. Mihomo's declared TUN capability is unsupported and explicitly returns 422; the test turns it off before successful Mihomo publication. The first fixture assumed support and was corrected, not the capability contract.
- Combined HTTP race rerun of the new matrix, native-draft owner/privacy preservation and frozen-bundle stale-review/token regression passed (10.510 s); no native process was requested.
- App typecheck and explicit strict browser-source typecheck passed. Two browser cases are discoverable. Discovery is not execution.

## Authored browser seam, pending execution

`structured-runtime-backend.ui.spec.ts` uses the existing isolated normal control-plane CLI and an invited ordinary account at 1440 and 390 px, without mocked API responses. It edits a rule destination and DNS/sniff/TUN controls, saves through the UI, then previews and publishes through the real API and verifies frozen output after reload. Thus publication confirmation interaction is not asserted by these two cases; other publication browser cases own that UI seam. Local Chromium execution remains prohibited; these cases must run in authorized CI before receiving browser acceptance credit.

## Existing complementary evidence, not rerun here

`TestNativeOwnedRuleFileBundles`, client native parser tests and native override conflict tests cover their respective parser/composition boundaries. This task does not relabel prior runs or claim current native execution. Existing failed-save DOM and native-draft preservation API tests are not one continuous browser conflict flow.

No production DNS lookup, host TUN activation, system trust change, native process start, remote CI or push was performed. E07 remains pending final-source CI/browser evidence and any broader conflict-flow requirements in the canonical checklist.

# RouteWeaver recovery status

Status date: 2026-11-06.

## Current reconstruction branch

This separate source-only integration branch contains forty-two bounded UI reconstructions, listed below, and documentation for two unresolved backend risks. No backend code has changed. It is not the restored v137 source and is not accepted for release. The verified v88 baseline remains unchanged in its own checkout.

- Lifecycle source candidate: `a9acd3fa261ff370f375afdd4840936606e32112`, composed as `3572787`.
- DNS source candidate: `591222cc054109971238a431faa4e89eb3c3c09d`, composed as `af20c32`.
- Quota source candidate: `67f4a7ce3d46301990d102213b202b4b7819d005`, composed as `29120de`.
- Security source candidate: `0ed929661e028d57a968bc05adff7441bc6457ff` plus review follow-up `967c1da1ee6e58b4c06afb35676503cf767d6e43`, composed as `0793413` and `98cf7ec`.
- Subscription rotation source candidate: `09d867138a9145347a3dde9097f1d8fbc7f2f47b` plus clarification `cc28c445587ccca48e0aa5d3f26c9276240b5271`, composed as `a1afc48` and `2f46077`.
- Rates source candidate: `6f5e997a43757f760042e007ffeade6315d58e76` plus honest-example follow-up `aff4686166bfc7e6e2a7fca92531d944cf13b418`, composed as `e641cd2` and `54be8cb`.
- Backend risk plan source document: `53cdbc9e4a7d6b482305b30a1687eb94296ee7ad`, composed as `9ab33a0`. This is a verification/design plan, not a fix.
- UserPolicy source candidate: `5b44ff3ea02364e3b9164f93358444f6f6668322`, composed as `f2d4976`.
- Invitation source candidate: `f80c5e7e285bf9c3ffdf2c04a6b71570137646ea` plus evidence clarification `dcd385a26b9497153de486bf10a290a6935fef48`, composed as `cc9b45b` and `d57ab9c`.
- Effective-route source candidate: `2d969ebf9db3d952ed8bf8674112e6eac74ac794`, composed as `7c60043`, `c74ca5e` and `9ffcaeb`.
- Service-quota source candidate: `ee6addf8792896454a29ffd2d28a51fb8f628fdb`, composed as `8810c4c`, `62b4018` and `425f393`.
- MFA local dismissal source candidate: `23394e3e1137c0c0c9e253a3ac952c3e4b732d3a`, composed as `260aee6` and `5405ba0`. Unknown enable outcomes remain unresolved.
- Policy partial-audit source candidate: `4112bda172d656a398b6f902019f02f1935e14f1`, composed as `2a3d0df` and `43c3f07`. Only the exact structured server contract is classified as committed with missing audit.
- Source-file ownership source candidate: `cffc2f21f87aaff785db16166058cf4539bf76bb`, composed as `fbd9a34` and `64aa2c4`. Pending/failed selections block stale saves and count as unsaved; cancellation revokes read ownership, not disk IO.
- TLS read ownership source candidate: `30ca1afe73c0febc7df59efc2221d8d0ce9d5ea7`, composed as `c2469b1` and `9f1f162`. Layout cleanup revokes obsolete reads during replacement; pending reads block save/preview. Backend receipt recovery remains absent.
- Policy date source candidate: `9db8771fca4597decb87f7347435972e08f0eb7e`, composed as `7a4404f` and `2f061c1`. UTC carriers preserve fixed UTC+8 wall time; locked calendar timezone compatibility and DST execution remain unverified.
- Resource numeric/inspection source candidate: `e01d37e83d538cd111e575c2bbeb669d32c3b98b`, composed as `d65972e`, `fc0dbbf` and `ba5b025`. Exact submit parsing is separate from explicit numeric stepping; malformed inspection-response schema remains unvalidated.
- Template endpoint catalog source candidate: `c06ab0cfb6ceb6a936ab98fa87c17b12d1dfebeb`, composed as `1101045` and `cff1d3e`. Uses processed preview and resolved grant observations, not raw source fallback. Separate reads are not atomic authorization proof.
- Diagnostic request recovery source candidate: `2d7d10846d07c3fc4891e3deade37adb24660187`, composed as `6c76b8e`, `3fb48be`, `3339731` and `d42a625`. Exact-ID acknowledgment is not execution success. Explicit owner-bound abandonment may permit duplicate traffic and replaces the entire form task; no automatic replay.
- Connection port source candidate: `a93ebc6d4c5997e737f96d9ee85dada2a9652c21`, composed as `b5e5922` and `ea8084c`. Exact form text reaches validation and dirty state; corrected textual edits remain dirty until reset/save. Host browser journeys are unrun.
- Profile runtime port source candidate: `37466f5eb755f7cbf85732d44f41eaaa71f8c86e`, composed as `d6ecd4a` and `b0b5bf2`. Mixed/DNS ports retain invalid edits and block requests; explicit JSON replacement resets numeric lifetimes. Group intervals and collection override ports remain separate.
- Backup inspection source candidate: `e260bd9e9bda04ec847c7fdc309a3372833e7e52`. Revision-owned errors retire on file/password/reset changes; reinspection retires earlier preview and consent. Restore uncertainty remains unchanged.
- Template extraction lifecycle source candidate: `1b4c98603b484bc02ae8f32f27ea8d2a90daa825`. Synchronous owners exclude extraction/publication overlap; new extraction requires fresh review, and old source errors cannot replace current drafts. Publication unknown-outcome behavior is not repaired.
- Domain activation source candidate: `1dbd985e1e4057ed60a26bdf56b235bee6e82f4d`, composed as `69cdf89` and `5e7514f`. Unknown activation blocks writes until validated read and fresh review; frozen reviewed values and live source checks fence dispatch. Save/verify uncertainty remains ordinary error handling, not recovered history.
- Group interval and collection pipeline source candidate: `e14b310a18f0e5c131518566b65e15b785eecc29`, scoped changes composed as `e0c2d2b`, `0d9e649`, `8750a62`, `6b1fce9` and `26fe2eb`. These are two bounded scopes. Existing group/create-and-use intervals and per-source/aggregate ports retain exact raw intent with repeated recovery focus, explicit replacement/discard and source-subtask ownership.
- Notification scalar and threshold-list source candidate: `0f8b34eb8b96bb9b4c75eff1b1bb47dd3721f6fc`. These are two bounded scopes: repeat/SMTP exact raw values and exact unique threshold tokens/count/order. Collapsed error recovery retains native sender validity, revision and secret handling. Invitation defaults are covered by the separate expiry scope below; uncommitted combobox search text is not included.
- Rate boundary source candidate: `bc700be64ae2c16e11f247b711246d7ee497d49e`, composed as `6fb35f5` and `a16a61e`. One render-time clock snapshot owns pending labels and timer scheduling; local boundary updates do not observe backend enforcement or immediately detect clock jumps.
- Provider allowance and diagnostic numeric source candidate: `b720d105d6ac166136a2cb2393df718e4eb3f005`, composed as `178d7a0`, `1ddd56b`, `cf0dccb` and `459d406`. These are two bounded scopes. Exact units, safe-byte cap and diagnostic limits preserve request ownership; a local spinbutton adapter restores bounded keyboard stepping. Native wheel/locale/visual-spinner equivalence is unverified.
- Fleet, direct-publication and published-route numeric source candidate: `a7ed26b566436c5acf3fb3674aed5ea41365db11`, composed as `99f1716`, `df7f310`, `273c43f` and `021107c`. These are three bounded scopes. Invalid raw edits remain visible, are rejected before requests and retire existing review. Fleet-create uncertainty and backend publication contracts are not repaired.
- Bundle access source candidate: `c687afb84b5a9f98c01152fd5432f71196b5a08a`, composed as `12261b2` and `e4c79c6`. Token-authenticated downloads use a fixed endpoint and monotonic layout-lifetime ownership; cookie downloads remain native. Rotation does not imply unchanged content needs reimport. Actual saving, auth and client behavior remain unverified.
- Inbox retry/freshness and instance polling source candidate: `45635d340510570f33aca6099fff3b162cc68e2b`, composed as `c4f12db`, `9bf69da`, `4acb77d`, `cbe2294`, `15e8a7b`, `931486f` and `a07549a`. These are three bounded scopes. Per-event outcomes survive concurrent sheets; stale reads block acknowledgement until fresh explicit action. Instance polling preserves focus and labels cached platform records, not current liveness.
- Collection preview source candidate: `35c53b9c23e6bd4d062e92d64315299902fd18c6`, composed as `123850c`. Stable collection/scope/source/step identity preserves selection through reorder; an owned removed tab falls back to final with nearest scrolling without stealing editor focus.
- Invitation expiry source candidate: `cf1e31d67274fef86f5d6b7111d1aac39d0f1f46`, composed as `0a18190` and `de06e9d`. Exact raw 1–168 hours, initial 72, explicit blank omission/backend 24-hour default, dirty state and bounded keyboard stepping. Invitation acceptance uncertainty remains a separate scope.
- Rule import source candidate: `863bb771a451dd1e36328eac3a6385538bb460a4`, composed as `ab7a1b0` and `27e8adf`. Failed selection remains discardable; abandoned local reads and the post-session-wait request boundary are task-owned. Rule opened-revision backend contract remains unresolved.
- Hidden uncertain-exit navigation source candidate: `13d382bd8cef71949261f497ea4da7b840fbfece`, composed as `193b092`. Pending/uncertain hidden saves retain departure protection; distinct operation consequences and separate draft loss are combined. Forced departure still loses memory-only reconciliation and does not cancel a possible commit.
- Enrollment pending source candidate: `fa56dae122ed802196feb72f0dfdcfb5f6f18c2b`, owned changes composed as `0448359` and `6c6f2a3`. Pending dismissal/duplicates are guarded and late responses belong only to the mounted task. Standalone candidate includes the preceding navigation prerequisite; it was composed only once. Issued token is not returned to the mutation result cache. Lost-response recovery/idempotency and manual uncertain retry remain unresolved.
- Native-output review documentation candidate: `f35e1b9799da3c8f3493f3ad01a67a480bfabb9b`, composed as `b961bbd`. Clarifies optional new-output frozen review versus legacy digest omission without reservation/idempotency promises. This is documentation, not an additional UI scope or a backend change.
- Source composition resolved the Profile runtime editor overlap by retaining both DNS repair and numeric intent. A shared readable-DNS predicate now selects both visible controls and live numeric keys. Combined regression source covers malformed JSON replacement after invalid input. No execution, type check, build, browser, backend or product acceptance result is available for this branch.
- Other recorded missing contracts and opaque historical changes remain unresolved here. In particular, v97 route-check scope cannot be identified confidently from its available summary, and v103/v106/v119 aggregate evidence is not a source feature or a current test pass. Security uncertainty coverage excludes MFA enrollment; the separate local dismissal cleanup does not resolve unknown enable outcomes, cross-flow ownership or success response validation; the Admin quota guard does not repair other numeric editors, exact-int64 transport or concurrent full-write semantics. Subscription uncertainty survives same-account page remounts only, not a new account epoch or full reload. The separate UserPolicy candidate covers six edited numeric callbacks; it does not repair other numeric editors. The separate service-quota candidate preserves exact stored bytes and last accepted edited bytes; a creation-conflict restart is blocked while raw quota input is incomplete. Invitation uncertainty is not durable across mode exit/reload and does not prohibit manual resubmission. Do not infer that the checkpoint inventory below is implemented.

Independent source review found and corrected a delayed-validation ownership gap in the security candidate before composition: inactive actor tasks now stop before persistence and dispatch, using layout-effect cleanup. Current-state reads remain inconclusive historical evidence and do not automatically unlock repeat writes. The review also traced Store.PutUser preserving old UsedBytes rather than trusting the submitted usage. These are source findings only, not executed regressions. Lifecycle consequence strings and all regression additions were preserved through the automatic merges. Effective route choices consume validated user-scoped effective-policy IDs rather than unioning legacy grants, and distinguish failed reads, deny-all and catalog-missing routes. Service-quota source review corrected validation ordering so raw intent updates before field validation. All forty-two bounded UI groups remain runtime-unverified. Rates retains NumericInput spinbutton/arrow behavior and only displays a quota example for an exactly representable factor. Subscription rotation uses a minimum matching metadata acknowledgment and independently fetches current access; neither an access read nor this source review is a durable historical operation receipt. The policy audit branch preserves editor input and retained drafts while retiring the consumed review; generic unknown policy outcomes and backend atomicity are unchanged. Source-file ownership preserves current content on cancellation and suppresses obsolete read results/errors. TLS source review additionally corrected passive cleanup to layout-lifetime revocation and preserves paired imports with newer drafts. Policy date carriers use UTC fields without changing the fixed UTC+8 policy; unchanged confirmation retains the original timestamp string. Resource source review restored baseline arrow stepping while retaining exact submit validation and fenced stale inspection errors. Template catalog review added consumed shape/origin checks and known upstream cache invalidation. Diagnostic source review added actor/record-bound abandonment confirmations and synchronous retirement of the old form instance to prevent delayed validation dispatch after a fresh task. Its valid-record abandonment is an explicit new design choice rather than historical parity; raw numeric precision is covered by the separate diagnostic numeric scope.

## Source coverage audit

The pinned [49-checkpoint semantic coverage map](reconstruction-coverage-6c6f2a3/COVERAGE-AUDIT-2026-11-06.md) inspects application source `6c6f2a33a6381e0badbfb8eeab9ba6a191cf3314`. It classifies 42 records as source-reconstructed, three partial (v89/v102/v134), three aggregate-only (v103/v106/v119), and one uncertain (v97). This coincidental count of 42 is not equivalence to the 42 UI scopes, recovered original commits, test passes or whole-product coverage. All 49 original primary objects remain absent. The preceding [audit](reconstruction-coverage-4e660eb/COVERAGE-AUDIT-2026-11-06.md) is preserved unchanged for provenance and describes an older source, not this composition.

An [additional bounded composition source review](TASK-COMPOSITION-SOURCE-REVIEW-2026-11-06.md) found no concrete new blocker in the newly composed task areas. Neither review executed application code. The source omissions that could be identified from the surviving summaries are addressed; opaque historical work, incomplete contracts and every applicable execution/acceptance gate remain open. Do not reconstruct historical test counts as current evidence.

## Verified recovered source

Recovered checkpoint v88 contains commit `a1fbbc301378e47489660791e68f8c50fcf2b93f`.
Its tree, `3ed10055f48b6b84228494841d4eedc4a19cf98c`, matches remote CI62 commit `3229cb4c6f468866f8f70734f49ac13c5e3501c5`.
Local bundle verification reports complete history, and a fresh object restore passed `git fsck --full --no-reflogs`.
The bundle SHA-256 is `494f6cc9e4e3c1c91a1a48135f8d9f3b1034155e5e4b48db7e18b90d75d843ed`.

## Source not recovered

Checkpoints v89 through v137 were reported as saved on 2026-11-05, but their source and test bytes are unavailable in the accessible current workspace, saved bundle, and remote repository.
All 49 reported primary commit objects below were checked and are absent from the recovered complete object database.
The last reported target is `ad1577e4a4d23f16e02c16daa2ac2cc75c140e55`, with reported bundle SHA-256 `e99f9bb3be17f96f55e53ccd7e704f79a4c3068c2fca486ea7ceb47ee627f3ed`.
This target and its reported 3,127-test result are historical records, not a currently restored or independently reverified checkpoint.
An older successful test run does not establish current product acceptance.

## Verification limits

Current frontend dependencies are incomplete. A read-only Linux/x64 lockfile inventory found 129 digest-matching cached package archives and 321 missing archives; the lockfile names only the official npm registry.
No installation, test, compiler, browser, backend, server, deployment, account action, or public push was performed during this recovery.
Any newly reconstructed fixes must receive new commit identities and be identified as unverified until applicable checks run.
Unverified source changes must remain separate from the verified recovered baseline.

## Missing checkpoint inventory

| Checkpoint | Reported primary commit | Recorded work |
| --- | --- | --- |
| v89 | `efff8d332921972785ba03463cb1ed5375981939` | local fixes and two pending decisions |
| v90 | `0542c3d153b6d3a66ebecb1083bacc1e89217ea3` | rate draft fix preserved locally |
| v91 | `f46f657a923c71db50152563f7689a2a7e3cdbee` | backup inspection fixes preserved locally |
| v92 | `a9d248736b9ff25738eeefad7ba17d1c1e75ed1e` | template lifecycle fixes preserved locally |
| v93 | `08f9e5c434a18eb14a109d4cad43f51a4093a992` | MFA cancellation fix preserved locally |
| v94 | `8159df2bd164e7c76e099b4366c5f92b2c8be7b6` | collection preview selection fix preserved locally |
| v95 | `ecbde0b3e9cdc7e0dafca1cb1c83fc5060d360ad` | collection focus reveal follow-up preserved |
| v96 | `0000e88d640f8a8566da289f75e0f328ee7d15f2` | uncertain domain activation recovery preserved |
| v97 | `315858e7a3cfdec835b4e8f1fb7e0b2946c16bf6` | serialized aggregate and profile draft investigation |
| v98 | `d2001d7f359f79ef4fd45fa9915e1701cf87f313` | proxy/DNS numeric draft fix reproduced and preserved |
| v99 | `388e443709d311d84f8e7eefb01f0a062c38364e` | group interval draft fix preserved |
| v100 | `4c6752400d6b866e4ee150e21a966beaea38d072` | original numeric inventory locally addressed |
| v101 | `d1dae3d3c7f54b5b3183dc5815661dc0dd32437b` | diagnostic recovery integrated; aggregate underway |
| v102 | `3fb249de1815f7e9a1f3e7f9841eb271dbbdaaa6` | account-security uncertainty recovery preserved |
| v103 | `e206c0341f7add5d14a8a4be93027175550b1142` | service-policy aggregate passed; TLS draft investigation |
| v104 | `977c3e3e167997b12329f0406b303168f75c5de0` | TLS import fix integrated; aggregate running |
| v105 | `868e7d1b2c8d0bf6c47f86046e9286145d7ba8cc` | source-file import fix integrated; aggregate underway |
| v106 | `11c762d2468c7d7ca32c9257a2adc2b89bdf8579` | repaired source-import aggregate passed |
| v107 | `e7f0714fcc0695df9417e0c495b1c4b76e2741dd` | fixed-UTC+8 policy date repair integrated |
| v108 | `dc1ca855e49f4391d3adba72c8ae371cccb8976a` | effective-policy route fix integrated |
| v109 | `23e8eb918f75c09fdff2354e71cef7096f7924f8` | rate and user-policy precision fixes preserved |
| v110 | `940693bf23fa58d56b41b9e51d8d21af60636f05` | resource numeric/inspection intent fix integrated |
| v111 | `09b9ef578c6c6d144584cfc40b9db4615461cc1c` | Admin quota protection integrated; contract gap remains |
| v112 | `08289e07c09cb490902fd5edf6f80159454a1f77` | Profile/Pipeline exact raw numeric fix integrated |
| v113 | `f3c9a671c86f1f872ad70d9982c1be6122395f8e` | connection port intent fix integrated; aggregate running |
| v114 | `0b4c5e054f69b51eabe9c7517ec04391cfb37ada` | notification/invitation scalar fix preserved |
| v115 | `11c8d7930d1435e4f6d9567bc527aa1ca8f89551` | threshold token validation integrated; aggregate underway |
| v116 | `93a0f73bc2456fba3234b37ad1e1a0efd93bc20b` | bundle access/rotation fix integrated locally |
| v117 | `7b12232fabf5eff0bb9e7825a6767b89ece00ce6` | rule-import recovery integrated; aggregate running |
| v118 | `52e287641ec0687408b371324b7b13766b28f50f` | template endpoint catalog fix integrated |
| v119 | `772dae15d060c09b4861dddcac58ebc86c7c08a6` | corrected template aggregate passed; Fleet baseline active |
| v120 | `592fee4ecc33a7d9c0ea65b7672fdedcf594175c` | Fleet numeric intent fix integrated; aggregate underway |
| v121 | `7d4157791f77e98393fbe2ec0a60234a9ce18ac7` | publication lease intent fix integrated; aggregate underway |
| v122 | `073df2fe9eb37af5580226fff12cd5d4bb0d87c8` | public-route port intent fix integrated; aggregate running |
| v123 | `c2754865dd24983c00648e912c16488c96d17f82` | provider allowance unit-intent fix integrated |
| v124 | `a8f8e0562ddab32452b889fbf8f04a464a9af658` | diagnostic numeric intent fix integrated |
| v125 | `ec2baea5dec5fb553f8050963a2d5e0293d7f283` | pending enrollment lifecycle fix integrated |
| v126 | `a341c1430d43883a6d79390082b8f8b2333c9280` | exit TLS pending-review fix integrated |
| v127 | `7b1e02422e920207f8bb09cda9cc18a64929957a` | uncertain-exit navigation warning integrated |
| v128 | `6d3db6a1c994f792a44952bdb75c17ae4403f923` | native-client review contract documentation clarified |
| v129 | `e250a9623a86d1de8661dc065e474a1dae1ace5d` | subscription rotation uncertainty guard integrated |
| v130 | `f9729fcf77f61dc891fd254750c457e0b46fbcf4` | policy partial-audit UI fix integrated |
| v131 | `4a7d4b1a91c4f2b5ec06be35b7b0badd5884d379` | inbox freshness fix integrated; aggregate underway |
| v132 | `9d814da1fed4c1f6477edb03fcedadb4655b3fac` | instance observation polling fix integrated |
| v133 | `579cdbd3f6d629296d0fc9be6fdcb0d786d72a39` | invite onboarding uncertainty safeguard integrated |
| v134 | `c6f41f644349af9ffaded4b22868ed88d7cd1499` | recovered full frontend aggregate passed |
| v135 | `6d76dd3ad693885283243cebcfa89f71ce9d0546` | managed-entry stop warning fix integrated |
| v136 | `b7f3aa9bd04cbd1765178af86234a5cd09b4aff6` | DNS recovery |
| v137 | `ad1577e4a4d23f16e02c16daa2ac2cc75c140e55` | Account lifecycle warning |

Checkpoint numbers are not an assertion of one commit or one feature per checkpoint. This is a reconstruction checklist, not a byte-for-byte diff or acceptance result.

## Separate unresolved backend and acceptance work

- Future cycle-anchor quota accounting and runtime observation ordering remain source-only risks, not runtime reproductions or completed fixes.
- Fleet uncertain creation, provider usage revision, policy/audit atomicity, account exact-integer updates, enrollment lost-response recovery, and exit receipt recovery still need their backend contracts and tests.
- Nodes-only output semantics require a product-contract decision before implementation.
- Current composed page/state/browser acceptance and real deployment validation remain open.

## Safe next steps

1. Recover exact later artifacts if they become available; do not overwrite recovered originals.
2. Reconstruct small, independently reviewable changes from recorded behavior and the surviving source.
3. Restore locked frontend dependencies only with authorization and permitted network access.
4. Run failing-baseline regressions, focused tests, type checks and build before release acceptance of the source-only composition, followed by the complete aggregate.
5. Preserve each new checkpoint with its exact identity, full bundle and verified receipt. Keep public publication and Go execution paused until separately authorized.

## Next execution boundary

See `RECONSTRUCTION-EXECUTION-PLAN-2026-11-06.md` for the ordered unrun verification plan. The web gate can be considered only after dependency/tool execution authorization and a permitted dependency source. `verify.sh static`, `quick`, `full`, API, browser and native gates are not substitutes: they can invoke still-unapproved Go, external tools or local servers. No permission is implied by this plan.

Connection and profile port changes preserve shared NumericInput semantics. Source review corrected explicit JSON replacement retaining obsolete numeric errors before composition. The integrated malformed-DNS path preserves raw JSON and remains repairable, rather than filtering rows or introducing an unreachable numeric blocker. New combined regression sources are unrun; source inspection is not dynamic verification.

Backup/template lifecycle source review traced revision ownership and both directions of same-turn overlap, and preserved existing restore/publication behavior. Synthetic regression sources were reviewed, not executed. Template re-extraction failure retains editable old structure and requires an explicit new review before publication.

Domain source review corrected malformed cache acceptance, live dispatch ownership and inconsistent synthetic backend-view fixtures. Group/pipeline composition preserved the shared readable-DNS predicate and explicit JSON reset. Additional synthetic tests specify source-task removal/return, discard/reopen and group strategy/JSON replacement. Notification source review removed an unintended unrelated form edit before preservation and retained the native email validity rule rather than broadening email validation. Every executable result remains absent.

Independent source review corrected the rate render-to-effect boundary race; restored provider/diagnostic spinbutton keyboard behavior; revoked obsolete bundle downloads at layout boundaries and across review-return cycles; and repaired per-event Inbox failure ownership, focus loss from instance polling, and missing explicit acknowledgement after a guarded refresh. All affected public regression sources are proposals only. No native/core/backend execution, network bypass, public push or deployment occurred.

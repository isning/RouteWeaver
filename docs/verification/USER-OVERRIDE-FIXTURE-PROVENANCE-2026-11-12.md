# Personal override fixture provenance

This fixture-only proposal starts from source `0ed7a06d13c14093ec2ea8ac92785f19ea380377`.
The [earlier original-pixel review](USER-OVERRIDE-FIXTURE-FIDELITY-2026-11-12.md)
recorded “未单独设置” beside saved personal limits because the sampler returned
an empty provenance map. Those images remain evidence of that older fixture.

## Source contract

`internal/service/effective.go` initializes `service: none`, `quotaBytes: account`,
`routes: direct` and `cycle: account`. Each non-null numeric override, including
zero, supplies its effective value and sets its source to `individual`.
Without a selected service, a removed quota override falls back to the user's
`quotaBytes`; absent IP, connection and rate overrides have zero values and no
provenance keys. The sampler has no selected service, groups or route grants.
It models only that scenario, not general service/group resolution.

The real edit-context and preview paths call the same resolver through
`effectivePolicyTx` and `policySnapshot`. No production provenance or comparison
change is proposed. `policySource` already renders `individual` as “个人覆盖”,
`account` as “账号设置” and an absent source as “未单独设置”. Thus an unset IP,
connection or rate limit retains that last caption; it must not be mislabeled
as account or group inheritance. The separate personal-settings row still
describes removal of an override as “继承”.

## Narrow change and checks

Only the synthetic sampler and this record change. Its response builder now
supplies those exact sources, preserving explicit zero, typed optional-field
omission and request non-mutation. The response type is checked as `Entitlement`;
null expiry is normalized before the existing omission loop. Exact outbound
request checks, allowed reads, rejection rules and the no-apply boundary remain
unchanged.

Existing journeys gain text assertions scoped to the affected user's numeric
row. They do not scroll, focus or otherwise interact with the page. Existing
interactions, screenshots and viewport sizes remain unchanged. These assertions
can inspect an offscreen row and do not establish its viewport readability.

The saved-source pure contract first failed against the original empty map,
then passed after correction. Eight pure sampler contracts pass without a
browser or web server: the existing serializer case and seven source cases.
Coverage includes all four correction/inheritance pairs, null/omitted equivalence,
explicit zero, unchanged sibling limits, source-only differences and non-mutation.
The existing policy-review model suite passes all 12 tests. Targeted sampler
TypeScript, full web TypeScript, discovery and whitespace checks pass.
Discovery contains ten browser journeys and eight pure cases, not eighteen
browser journeys. The independent source review is recorded with the delivery.

## Pending acceptance

Native execution and fresh desktop/narrow original-pixel review have not run
for this proposal. Existing browser availability restrictions remain unchanged;
no workaround or alternate sandbox was attempted. Earlier screenshots and
native receipts are not reassigned to this source. No full integration,
deployment, backend enforcement or new visual acceptance is claimed.

## Coordinator integration

The two-file patch `9a2dd2b86ef42640042cc8af36442746ce0a8502e6220a3a3a09aa6c9dfbf5d1` received independent source/document review. Integrated pure execution passed 8/8 in 1.2 seconds using a temporary Playwright configuration selecting only `user-override fixture` tests, with no `webServer` or browser fixture. Targeted strict TypeScript passed. Actual recovery CLI discovery measures 118 cases across 30 specs, exactly once as 59 + 59: 110 browser journeys and eight pure contracts. No test was removed. Native execution, new locator assertions and fresh screenshots remain pending.

# E06 — nested dynamic source publication

Base: `23650ca`. Test-only addition; no production code, native activation,
browser run, external source fetch or probe request.

`TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication` joins public
HTTP operations against the real backend and temporary repository, for each
supported Mihomo strategy: manual, URL test, fallback and round-robin balance.

The finite contract is:

1. An invited owner accepts a synthetic text source and saves a three-level
   Root → Middle → Dynamic leaf policy. The leaf keeps its explicit DIRECT
   member while adding current accepted members from that specific source.
2. Two separately published feeds initially deliver the same one-source-node
   policy. A harmless source addition changes the accepted snapshot.
3. Selected-output review shows exactly one changed group and one newly added
   member, without a strategy change. Exact rendered group types, depth,
   default route, test URL/interval and balance strategy remain intact.
4. Source acceptance and review leave both original feed bytes unchanged, with
   both comparison baselines reporting a pending change.
5. Fallback and load balance requested for sing-box return the specific
   `GROUP_STRATEGY_UNSUPPORTED` diagnostic and no substitute artifact. Neither
   feed changes.
6. Publishing the selected review changes its revision and delivers the reviewed
   JSON plus the renderer's single trailing newline through the original URL.
   The sibling retains its original bytes and pending comparison. The selected
   comparison becomes unchanged. The saved dynamic recipe is byte-structurally
   unchanged; resolution did not replace it with frozen members.

Validation uses the new table plus the existing accepted-source, manual-source
application and frozen semantic-review regressions. Early authoring failures
were test assumptions, not product defects: publication deliberately does not
return a feed token, and redacted preview JSON does not include the renderer's
trailing newline. Assertions were corrected to the actual documented seams,
without weakening member/strategy/depth or sibling isolation checks.

Scope remains finite. This is joined API evidence, not a browser task, actual
client execution, live network reachability or proof of arbitrary graph depth.
Existing UI and native-parser evidence must retain their separate source/run
bindings. Full current-candidate CI is still required.

## Local result

Focused race command:

```
scripts/go.sh test -race ./internal/httpapi -run 'TestNestedDynamicSourceUpdateRequiresExplicitScopedPublication|TestSourceAutomaticDynamicAdditionDoesNotRequireReview|TestSourceManualApplicationRecomputesDependenciesWithoutRepublishing|TestSemanticPublicationReviewExplainsFrozenGroupMembers' -count=1
```

PASS, 13.266s (four new strategy subcases plus three existing top-level tests).
Pinned Gitleaks current-tree scan is recorded separately. Full-history review is
owned by the final integration gate; this branch does not incorporate the later
historical-receipt hash exception commit.

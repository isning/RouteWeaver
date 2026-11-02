# Literal acceptance: evidence hashes and QR test dependency

Base `877cc8a`. Preliminary all-reference scan reported 23 pattern matches on the
FINAL-CAPACITY-REFERENCE production/test manifest lines. Strict duplicate-free
JSON maps contain only safe source paths and SHA256 values: all **250 production**
and **309 test** values match declared historical source
`6742d04b7e1c036de8fcc3551d0c49390f562b75`. Exact manifest bytes match both operational
and qualification receipt bindings. Both actual retained binaries and all three
raw JSONL artifacts independently match their receipt hashes.

The current checkout differs at production `internal/conversion/pipeline.go` and
three test files listed in provenance.json. These historical manifests are not
relabelled as current source evidence. Four exact path/rule/line-SHA256 reviews
were added; immutable manifests/receipts and scanner rules remain unchanged.
Actual scanner regressions reject modified-line and other-path copies for both
rules. This classification does not extend historical native acceptance scope.

## jsqr 1.4.0

- Exact devDependency 1.4.0; lock marks dev=true, Apache-2.0. Comparing the lock to
  6742d04 shows only root metadata and node_modules/jsqr changed.
- Official npm registry metadata matches version/license/integrity. Downloaded
  official tarball SHA512 matches the lock; installed LICENSE is byte-identical
  to its Apache-2.0 license. Its package declares no runtime dependencies.
- Only import found is the browser test `web/tests/service-center-backend.ui.spec.ts`;
  none is in application source. `npm ls jsqr --omit=dev --json` contains no jsqr
  node (its exit 1 denotes the empty requested dependency tree).
- No current web/dist existed, so this is source/package-graph exclusion evidence,
  not a new emitted-bundle inspection. The packaging recipe does not ship
  node_modules. No production build or root-file mutation was performed here.
- Fresh npm audit still reports six affected nodes, two primary advisories:
  GHSA-g3hv-75wg-m249 and GHSA-gcqx-w48m-w2h4. Node/advisory identities equal the
  previous retained audit; counts remain low=2, moderate=4, high=0, critical=0.
  jsqr adds no audit finding. This is not a zero-vulnerability claim or a blanket
  safety assessment. No npm audit fix, dependency sweep or new runtime dependency.

Raw registry, audit and scanner output is retained outside the checkout; compact
facts and terminal test/scan logs accompany this review. No native execution,
remote CI, publication, live target or credential change was performed.

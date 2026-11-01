# Distribution dependency notices

`scripts/package.sh` runs the offline, Python-standard-library-only collector
`scripts/collect-notices.py` after building. The archive keeps the existing managed
Xray notices unchanged and adds `licenses/root-and-web/`:

- `go-build-info.txt` records linked dependency versions from the actual root
  control-plane and node-agent binaries. Their cached module sources provide the
  upstream texts. The Go toolchain's top-level license is retained separately.
- `npm/` retains texts from installed production entries in the pinned npm v3
  lockfile. This includes transitive dependencies and is a conservative superset
  of bundled code, not an exact tree-shaking map. Development-only entries are
  excluded; missing optional packages are not installed/distributed and skipped.
- `inventory.json` records each dependency, npm declared license metadata, copied
  paths, SHA-256 hashes and missing-text status. `README.txt` explicitly lists
  missing text candidates. License metadata alone is not a license text.

The scan retains upstream bytes unchanged, including nested vendored notices and
license directories. README files with a Markdown license heading are retained
whole, because some upstream packages embed their license only there. It never
downloads dependencies or follows symlinks. Missing
required installations, mismatched npm versions, or Go replacement modules fail
packaging rather than guessing a notice source. Missing license text candidates
are conspicuous warnings and inventory entries, not a claim of complete compliance
and not currently a package-build failure. Review them before distribution.

The filename scan is best-effort: embedded notices, unusually named texts,
source-offer requirements, toolchain-vendored code and any runtime code injected by
build tooling require separate review. This inventory is technical provenance,
not a legal conclusion. Managed Xray has a separate source/license notice process.

Run focused checks without rebuilding the product:

```sh
python3 -m unittest discover -s scripts -p 'test_collect_notices.py'
python3 scripts/collect-notices.py /tmp/routeweaver-notices-new
```

The output directory must be new to prevent stale notices. Re-running with another
fresh destination against identical binaries and installed sources produces the
same inventory and notice contents. The current local pinned dependency scan
retains `is-mobile@5.0.0`’s full original README, including its embedded MIT notice
and upstream copyright. No license text is synthesized or fetched separately.

## Rolldown binding review (2026-11-01)

The two `@rolldown/binding-linux-x64-{gnu,musl}@1.2.14` missing-text
candidates are native build-tool `.node` binaries, not files copied by
`scripts/package.sh`. Do not suppress their inventory warnings or infer a license
from package metadata. The actual web bundle does contain the injected
`rolldown/runtime.js` helper: the collector already retains its parent
`rolldown@1.2.14` upstream `LICENSE` and `THIRD-PARTY-LICENSE` unchanged.
No additional omission was verified for this package recipe. This conclusion
must be revisited if distributing `node_modules`, build-tool binaries or a changed
bundler. See [the bounded dependency/input review](verification/DEPENDENCY-INPUT-REVIEW-2026-11-01.md)
for module inclusion evidence and remaining maintenance findings.

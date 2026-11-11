# Initial Resources retry observation

2026-11-11. Bounded desktop result: the suspected repeated-initial-failure keyboard defect was **not reproduced in native Chrome**. No production change is justified by this observation.

## Evidence

- Exact source: `23545e07c38d4857154666abe818cae43873c3a6`.
- CI run `43081806877`, recovery job `130735991382`; supplemental recovery suite 72/72 passed, including the two initial Resources cases.
- Artifact `13885696369`; original ZIP SHA-256 `708cabf2e1fc2ad6a85153dacb64d6ee6c963915284f537ce2beabce06023b7f`.
- Browser provenance: sandboxed Google Chrome `156.0.8078.79`, Ubuntu 24 runner image `20261101.360.1`; viewport 1440×900.
- Decoded original report: `decoded-report/b5bd7b895d03d7111946.json`. Its `initial-resource-ledger` attachments contain observations and request accounting. Image paths below resolve under the artifact's `web/playwright-report/`.

## Findings

- A preliminary real-App jsdom tracer observed BODY focus after the retry button was removed, followed by 17 ordinary Tabs back to Retry. This did **not** predict native sequential keyboard behavior. In Chrome, after the held initial retry failed again, the next Tab returned directly to Retry: **one Tab**, with visible focus, an unobscured 72×32 target at (316, 213). BODY alone was not a usability failure.
- Successful empty recovery left BODY focused. The first Tab reached the clearly visible “跳至主要内容” skip link. Continuing with Tab alone took 13 additional Tabs to “添加公开引用”. The existing skip-link handler focuses main, but its activation was not sampled here. This shortcut remains an optional future audit, not a blocker or a demonstrated task failure.
- A newer Add-public-reference dialog retained the same focused resource-name field and synthetic draft while the held initial inventory read succeeded. Before/after geometry remained (360, 125), 720×44, focus-visible and unobscured.
- Unknown loading remained a skeleton, not a false empty list. Authoritative empty appeared only after success. The retry case recorded two initial failed GETs, two repeated-failure GETs and one successful GET, matching the real App's automatic retry policy. The newer-dialog case recorded two initial failed GETs and one success. Neither case recorded unexpected/rejected requests or page errors; no writes were allowed.

## Inspected original-position screenshots

| Stage | Report attachment path |
| --- | --- |
| Held initial retry | `data/cc3204cd3f2d1c5e35fbf030ab5e6733691479d9.png` |
| First Tab after repeated failure | `data/6254bb632cc9b90fe0c6b4cdebffd22142cae1ae.png` |
| Successful empty recovery | `data/574cbe5276e2738b2288b89288f6820fa5e44df7.png` |
| First Tab after success | `data/bd6e75cda6b94e694a944551da6093504dad21cc.png` |
| Newer dialog before recovery | `data/2a11c75805980ba3613805e5ed7348cce8e6907c.png` |
| Newer dialog after recovery | `data/570fbaf8d9e43a2f82bf6832c5b6dcbb22259fc7.png` |

These are original-position captures with intentional privacy masks and Playwright's default hidden caret, not wholly untouched pixels. The final-original capture precedes request cleanup. Screenshot inspection supports visible focus and layout; ledger/geometry and task assertions separately establish focus ownership and request behavior.

## Decision and limits

Close the suspected repeated-initial-failure defect for this bounded desktop scenario. Preserve initial unknown/loading semantics and avoid a broad QueryState focus abstraction. The success shortcut can be sampled later if that task becomes important. Passing observations do not establish comprehensive usability: narrow viewports, other browsers, assistive technology, nonempty recovery and general accessibility remain untested. No production code or additional tests changed for this note.

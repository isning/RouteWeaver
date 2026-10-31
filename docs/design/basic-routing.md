# First-use subscription setup and basic routing

Status: bounded local implementation with model, DOM-task and HTTP contract
coverage. RW-07 and RW-12 remain in progress. This slice does not claim browser,
real-client, native-engine, deployed-network or complete story acceptance.

## Task and scope

The ordinary subscription home now opens **设置订阅** directly when there is no
published output. **调整分流** opens the same focused task for an existing output.
A user names the subscription, selects a supported client, chooses the endpoint
for ChatGPT and explicitly chooses the default endpoint for other traffic. There
is no forced source import, raw profile canvas, graph or technical dashboard on
this path. Own-airport management remains a separate, optional task.

Choices come only from the existing owner-scoped contracts:

- `/api/me/platform-entries`: entries the backend exposes as provisioned and
  entitled for this user; their names are data, not hardcoded infrastructure.
- `/api/me/sources`: enabled sources' accepted snapshot endpoints. Choices show
  both the airport/source name and selected endpoint name. Pending source-update
  candidates are not substituted for accepted snapshots.
- `/api/me/overview`: current platform route rate, displayed once per choice;
  an unavailable rate is not invented. These records are not live health probes.

Platform-only, own-airport-only and mixed setups work. The basic path deliberately
selects explicit endpoints, not an implicitly changing collection. Collection
processing, more applications, nested groups, rules, DNS, private rule files and
native overrides remain available in the full editor. No DNS, TLS, host, external
account or real traffic action is performed by this implementation or its tests.

## Ordinary profile intent, not a new backend contract

`basic-routing-model.ts` produces a normal full profile. It creates two manual
single-endpoint groups, one for ChatGPT and one for other traffic, with an explicit
default action. The visible bounded preset contains domain-suffix rules for
`chatgpt.com`, `openai.com`, `oaistatic.com`, and `oaiusercontent.com`. This is an
editable initial preset, not a maintained claim of exhaustive service-domain
coverage. The full editor exposes and can change every rule.

The payload retains source/platform references. It does not copy revealed
connection credentials into new endpoint records; the server materializes the
referenced inputs and validates normal profile intent. Existing runtime settings
are retained. The basic recognizer accepts only the exact generated group/rule
shape, supported pinned target version and matching materialized source scope.
Extra rules, resource references, native overrides, collection processing,
unsupported versions or independently targeted existing outputs go to the full
editor without mutation. There is no lossy conversion of an arbitrary advanced
profile. Full-editor draft handoff retains unsaved values and its dirty guard.

## Save, review and publish are separate

1. **保存草稿** uses the existing owner-scoped profile save API and does not create
   or update a published output.
2. **保存并查看修改** saves the draft and calls the existing saved-profile preview
   endpoint. The review names both selected endpoints and the client; generated
   text is collapsed and redacted by default. A rejected preview retains inputs.
3. Only **发布并获取订阅** or **发布修改** performs output publication. Existing
   outputs submit the authoritative preview digest to the existing publish API.
   A stale/uncertain update clears the review and requires another preview.
4. New output creation uses one stable output identity. If the response is lost,
   an authenticated output-list lookup reconciles that identity before returning
   success, rather than creating a second subscription. The UI opens the returned
   authoritative output, and access still uses the current authorized `/access`
   response, not a cached feed link.

Changes to selected inputs, draft values or refreshed choice records invalidate
review. A missing selected endpoint stays visible as unavailable and must be
explicitly replaced; the UI never chooses a fallback. Close/navigation guards
protect unsaved changes. Loading, failed reads, true empty state and failed
save/preview/publish remain distinct.

### Existing backend limits, not UI disclaimers

New-output creation revalidates current profile/source/entitlement state but does
not accept a preview digest. Therefore this slice does **not** claim that a newly
created output is byte-for-byte the earlier reviewed preview under a concurrent
change. Existing-output updates do have the digest fence. The focused review
shows the proposed draft, not a fabricated old-versus-new comparison: the current
API does not expose the published profile intent separately from the saved draft.
Neither limitation is disguised as a product health/status banner.

## Verification evidence

- `web/src/basic-routing-model.test.ts`: actual platform/private references,
  independent default choice, bounded profile shape, refusal of advanced shapes,
  unavailable sources, materialized scope and pinned target preservation.
- `web/src/basic-routing.dom.test.tsx`: mixed/platform-only/private-only setup,
  readable preview before explicit publication, retained input on preview failure,
  no mutation during advanced handoff, canceled close, missing original endpoint,
  existing digest conflict, separately pinned output preservation and lost-response
  creation reconciliation. The pinned-output test failed before the guard and
  passed afterward. Initial tracer tests failed before the new modules existed.
- `web/src/task-experience.dom.test.tsx`: the empty subscription home enters the
  task directly; optional airport navigation remains separate. Current access
  authorization still overrides cached links.
- `internal/httpapi/basic_routing_test.go`: temporary-store authenticated HTTP
  flow provisions a synthetic entitled platform entry and imports an owned text
  source, saves the normal profile, previews without publishing, explicitly
  publishes, and checks the rendered feed groups, domain rules and default.
  Disabling the private source blocks later preview while the last published feed
  stays byte-identical. The fixture uses documentation addresses and no network
  fetch or actual infrastructure.

Focused verification at source freeze, 2026-10-19 20:12 UTC:

- `npm --prefix web run typecheck` passed.
- `npm --prefix web run test -- --run src/basic-routing.dom.test.tsx src/basic-routing-model.test.ts src/task-experience.dom.test.tsx` passed: 3 files, 21 tests.
- `scripts/go.sh test ./internal/httpapi -run TestBasicRouting -count=1` passed.

The shared final quick gate and final aggregate web/API/build runs are recorded
separately by their owners. DOM interaction is not browser layout/keyboard/native
acceptance, and this bounded HTTP proof does not close all profile, output or
prerequisite acceptance criteria.

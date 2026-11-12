# Add-endpoint uncertain-result recovery

## Scope and status

Candidate prepared from `1a1c6f342e0e93a43233ebde0a00f9b616228927` in an isolated snapshot. No main-checkout edits, publication, deployment, real nodes, or real credential values. This is a reusable connection-record task, not server registration, managed-listener creation, or remote provisioning.

Frontend behavior has bounded local acceptance below. Backend source has independent review; Go compile/tests/race/gofmt and real HTTP/database acceptance are **unrun**. Browser launch is blocked before a page opens, so there is **no desktop/narrow pixel or native-browser acceptance**. Full frontend integration on this candidate is still for the coordinator; the previous 4412-test result is not a pass for these new changes.

## Defect and failing evidence

The audited Add-endpoint path generated a new ID on every Save. After a synthetic persisted command lost its response or returned unreadable successful JSON, unchanged retry created two records. Cancel stated `当前端点修改尚未保存。` even when a record already existed, and the list could remain stale. The current fresh-ID behavior did not overwrite later edits, but a stable-ID-only replay would: legacy POST and PUT both upsert through `PutNode`.

The isolated audit on source `16c48b9` had nine passing controls/characterizations and three intended failing assertions: two duplicate-count assertions (expected one, observed two) and one false-unsaved Cancel assertion. For this candidate, the new API contract test first failed because createNode did not exist (two legacy controls passed); the new real-AdminPage recovery task first failed because no uncertain-result state existed. Both new contract tests then passed after implementation. Original audit files were not modified to imply a fix had already passed.

## Backend command contract

- Only `POST /api/nodes` with exactly one `If-None-Match: *` opts into create-only behavior. Empty, repeated, quoted, list-valued, and other conditional headers fail explicitly instead of falling back to upsert. Surrounding space/tab is accepted.
- `CreateNode` validates through existing domain validation, forces `status=unregistered`, reserves the SQLite writer, checks absence by `nodes` and ID, writes through the existing encrypted canonical writer, and commits before returning the Node. It does not perform a second State read after committing.
- A collision, including identical replay or later edited content under the same ID, returns 412 `NODE_CREATION_CONFLICT` without modifying it. Known invalid header/input returns 400 `NODE_CREATION_PRECONDITION_INVALID` or `NODE_CREATION_INVALID`; detail does not quote connection input. Other storage failures use generic 500 and remain uncertain to the UI.
- Existing Huma JSON/type/schema errors retain their existing framework responses and are conservatively treated as uncertain by the UI. They are not misclassified as one of the new known pre-write errors.
- Unguarded legacy POST and all existing PUT behavior, path/body ID checks, authorization, origin and CSRF guards remain unchanged. No user quota/usage/policy, host, core instance, managed endpoint, deployment, account, or authentication workflow is added.

## Frontend task contract

The existing EntityEditor creation lifecycle now also owns Add endpoint, without a separate duplicated editor state machine. Editing an existing endpoint still uses its previous path.

1. The first valid submission binds one task ID and an independent normalized connection snapshot. A known pre-write rejection permits correction under that same task ID. An uncertain response freezes the submitted snapshot; ordinary Save is replaced with result checking.
2. Only the new create command sends the atomic absence guard. Response validation covers every persisted Node field, nested TLS/REALITY/transport/header types, identity and status, and rejects unknown record fields. The comparison accounts for Go optional-value omission and header-map ordering. It does not apply protocol normalization to returned data and therefore cannot erase a differing saved parameter. Status and optional core metadata are compared, not guessed.
3. A fresh state read is checked for a well-formed endpoint list and duplicate IDs. Matching saved data confirms completion. Differing data remains visible for review without overwrite. Read failure or malformed list does not become confirmed absence. Present absence offers only guarded retry of the original ID and body because the earlier request may still complete.
4. Close and App navigation explain possible completed creation and do not imply rollback. Closing or moving away refreshes the inventory; error completion also invalidates stale inventory. A later Cancel/navigation decision, task replacement, or unmount owns dismissal over older responses. A save completed during a newer navigation decision remains available as completed after Stay.
5. Connection authentication values remain only in the existing input/attempt and encrypted Node workflow. They are not added to localStorage, a durable operation ledger, or recovery error text. Difference summaries show only name, address, and protocol, never raw authentication options.

This is **same-task recovery only**. No durable cross-reload idempotency or create-delete-recreate guarantee is claimed. Name/address deduplication and blind stable-ID upsert are deliberately absent.

## Executed local checks

All behavior runs used `--maxWorkers=1` in the isolated snapshot.

- Focused web run: **283 tests across 15 files passed**, including **118 new endpoint API/comparison/UI cases** and the existing Add-user, endpoint editor, lifecycle, validation, connection and navigation regressions.
- New endpoint outcome file: **34 UI task cases passed**, covering lost/unreadable/malformed/wrong-identity responses, absent readback and guarded retry, intervening edits, full metadata differences, read errors/malformed inventory, prior uncertainty after retry rejection, truthful Cancel/list refresh, newer tasks, local validation and numeric normalization, pending repeated submission, unmount, and real App navigation decisions.
- New endpoint API and Node comparison files: **84 cases passed**, including all persisted fields, nested data, optional omission, map ordering, unknown/malformed receipts, pre/post-dispatch session fences, authentication/CSRF header preservation and unchanged legacy saveRecord behavior.
- `npm --prefix web run typecheck`: passed.
- `npm --prefix web run build`: passed.
- Prettier check on the four new web files: passed. The changed EntityEditor/createNode sections are formatted; unrelated Admin/api formatting is preserved from the baseline rather than rewritten. This does not claim whole-file Prettier acceptance for those two existing files.
- Strict `git apply --check --whitespace=error-all`: backend v2 passed after removing one extra EOF blank from a new test file. This is not gofmt execution.

Focused command:

```sh
npm --prefix web test -- --maxWorkers=1 \
  src/node-creation-api.test.ts src/node-creation.test.ts \
  src/admin-node-creation-outcome.dom.test.tsx \
  src/admin-user-creation-outcome.dom.test.tsx \
  src/admin-endpoint-configuration.dom.test.tsx \
  src/admin-task-lifecycle.dom.test.tsx \
  src/admin-validation-concurrent-controls.dom.test.tsx \
  src/admin-validation-keyboard.dom.test.tsx \
  src/admin-validation-order.dom.test.tsx \
  src/admin-validation-recovery.dom.test.tsx \
  src/connection.test.ts src/connection-fields.dom.test.tsx \
  src/connection-transport-current.dom.test.tsx \
  src/navigation-focus.dom.test.tsx src/user-creation-api.test.ts
```

## Required remaining acceptance

Ten new store/HTTP test functions are included but unrun. They cover encrypted persistence/reopen, typed options and canonical status, conflict/replay/later edits, separate Store handles racing, invalid header/input, unchanged legacy POST/PUT, access guards, generic storage failure, and unrelated state preservation. Required commands on an authorized native runner include:

```sh
scripts/format.sh --check
scripts/go.sh test -race -p=1 ./internal/store ./internal/httpapi \
  -run 'Test(CreateNode|NodeCreation|NodeGuarded)' -count=1
```

Then run the required broader aggregate checks and real UI/native HTTP acceptance, including narrow/desktop recovery states, focus/scroll visibility, and actual conditional-header behavior. The local `scripts/go.sh version` probe reports no Go compiler. Installed Chromium with sandbox enabled aborts before opening a page with `socket() failed: Operation not permitted` (and read-only Crash Reports/ptrace errors); no sandbox bypass or alternate-launch retry was attempted. Synthetic fetch fixtures prove UI command handling, not SQLite atomicity, Huma behavior, deployment or real connectivity.

Independent backend source review accepted v2's semantics and strict patch applicability, with native checks explicitly still pending. Frontend/full-candidate source review is requested before integration. Ticket/story verification status is not advanced by this bounded candidate.

## Coordinator integration

Frozen full v2 patch `8d9e8b4ea9af606253fba3eb85bcc14e33ef9398d98ce0ab25031faa0258c8ca` received independent source acceptance. All eleven integrated files matched its manifest before this evidence append. Integrated focused execution passed all 283 tests in 15 files (62.61 seconds), followed by typecheck and production build. Complete frontend regression is a separate pending step; no Go or native/pixel acceptance is inferred.

Complete local frontend regression subsequently passed on production frontend source `1dd98c6028542e621735a69bd73737c714f974e6`: shard 1 passed 2,353 tests in 177 files (605.30 seconds), shard 2 passed 2,177 tests in 177 files (601.33 seconds), totaling 4,530 tests in 354 files. Both serialized shards passed typecheck and production build. The native-only sampler added during the run did not alter application or frontend aggregate inputs. Backend/native-browser execution remains separate and unaccepted.

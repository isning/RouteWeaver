# Settings and subscription workspace pilot

This is a two-page pilot responding to the user's three supplied Cloudflare images, not a completed console-wide restyle. Private reference pixels and account information are not copied into the source.

## Scope and composition

- The outer workspace stays fluid beside the existing navigation. No global navigation width, font scaling, or preview safety wiring changes.
- `WorkspaceFrame` separates the primary canvas from an independent context pane. Only `PageContent` is centered and capped: settings 52rem, subscription overview 72rem. These are project candidates for pixel review, not measurements claimed from Cloudflare.
- The directory pane is 14rem including padding; the data pane is 22rem including padding. They open at content widths 54rem/70rem, respectively. The pane owns a continuous border and background; it does not share the main content cap. Its content remains in one mounted subtree.
- Basic Settings and the subscription overview opt in. Historical subscription aliases and non-basic settings tabs retain contained composition; Profile and other `ContextLayout` consumers retain their existing API and layout.
- The title/actions and body use the same centered content edges. Local tabs have a separate horizontal band. At narrow widths the section index precedes the task body; data context follows it. Sparse data remains sparse.

## Read-first settings contract

The accepted name is shown with a real edit action. Registration/timezone remain read-only and keep their registered hidden values in the complete PUT payload. The same form and Basic tab stay mounted. Cancel changes only the name back to its latest accepted baseline. A save accepted after newer input retains the newer draft and editing state. Failures retain input and error. Completion restores focus only while this editor still owns it, never after moving to the domain or Backup tab. Pending save uses the existing focusable busy action contract and still prevents a duplicate submission.

Origin revision, draft, verification, expiry, activation and confirmation workflows are unchanged. Their necessary consequences remain adjacent to decisions.

## Evidence and remaining gate

- New read-first tests failed before implementation because there was no explicit edit entry. Focused DOM tests now cover the full payload, cancellation, accepted baseline, failure, newer pending input and focus ownership.
- Real subscription overview/alias tests preserve the same expanded usage node and an open configuration draft. Synthetic frame tests additionally check same-node preservation through contained presentation.
- Browser acceptance is updated, not weakened, for the new composition: content centered within its primary canvas, title/action alignment, independent full-height pane at the shell edge, original navigation/draft/zero-write invariants, and sparse/expanded states. Old context consumers retain their prior geometry assertions.
- Browser checks also cover module loading → GET loading → ready and a held save with further input. Desktop/ultrawide and narrow captures must be reviewed before claiming visual acceptance. No local browser was launched.

Route/capture matrix: `#settings` default read rows, name edit, dirty name+domain navigation, Backup return; `#subscriptions` sparse one-profile/one-link overview and expanded real usage/routes; current widths 320,390,1024,1280,1366,1440,1536,1920,2304,2560,2880,3440. The 320 case uses a short 480px viewport. Existing Profile/Backup/security checks remain as non-pilot regression coverage.

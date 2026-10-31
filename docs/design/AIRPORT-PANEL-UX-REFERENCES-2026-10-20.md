# Established panel patterns to reuse

## Evidence reviewed

- [Remnawave users workflow](https://docs.rw/learn-en/users/): official documentation and its user-form/table screenshots. Data limits and reset strategy are grouped; expiry and access assignment form a separate group. User-list actions lead directly to editing, usage and subscription access; detailed technical information is secondary.
- [3x-ui](https://github.com/MHSanaei/3x-ui): official current README and [client form](https://github.com/MHSanaei/3x-ui/raw/main/media/03-add-client-light.png), [inbound form](https://github.com/MHSanaei/3x-ui/raw/main/media/02-add-inbound-light.png). Basic settings are separate from credentials, links and advanced transport/security controls. Quota is entered in human units and dates use a calendar-style control.
- [Marzban](https://github.com/Gozargah/Marzban): official feature inventory confirms user traffic/expiry management, periodic limits and subscription/QR delivery as core tasks. Its actual dashboard was not opened in this pass, so no visual-layout claim is made.
- [Xboard](https://github.com/cedar2025/Xboard): official project README checked for scope and frontend separation; no authenticated demo or actual user/admin screen was inspected in this pass.

These are interaction references, not a source-code import. Their licenses are not assumed interchangeable. No external panel was installed, authenticated to, modified or connected to the user's infrastructure.

## Decisions for RouteWeaver

1. Organize ordinary work around a user, service plan, access grant and subscription. Runtime identities, principal versions, manifests and generation details stay in contextual advanced sections. Keep our distinct server and client IRs rather than copying another core's resource model.
2. Keep traffic allowance beside reset policy; put route access beside validity. Support clear unlimited/never-expire choices. Avoid exposing byte arithmetic or requiring ISO timestamps for routine administration.
3. Separate a grant from a usable/deployed entry. Do not label a granted-but-undeployed route “available”. User entry creation must link to authorization prerequisites, not pretend to grant them.
4. Keep the subscription-copy/download task short. Keep regeneration, token rotation, usage reset and other consequential operations separate, named by consequence and defaulting to preservation.
5. The full converter needs editing width, not a permanently empty explanatory sidebar. Open generated configuration on demand; retain the unsaved draft and preserve diagnostics.
6. Do not copy billing, HWID tracking, broad automatic failover or an inbound-centric navigation merely because another panel has it. Our confirmed online-IP policy, multi-core model, explicit route graph and personal external sources remain authoritative.

## Next bounded slices

- Group service-plan allowance and reset controls together, with route authorization in its own clearly named section. Preserve existing API payloads and cycle semantics.
- Use a timezone-explicit date/time control that preserves original stored values unless deliberately edited; retain invalid-value repair and zero-sentinel handling. Do not silently re-anchor cycles or truncate existing precision on save.
- Introduce human-unit editing for personal quota/rate overrides without changing integer-byte storage, units or rounding rules. Keep exact-byte access for exceptional existing values.
- Improve user-list effective expiry/usage visibility only with authoritative effective-policy data. Do not mislabel account fallback quota as final service quota or introduce an unbounded per-row request pattern.

Post-reference changes must have user-task tests and browser verification. This document is a design basis, not evidence that these next slices are already implemented.

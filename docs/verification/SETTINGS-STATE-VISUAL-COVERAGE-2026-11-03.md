# Settings state visual coverage

Baseline: 918818e. This follow-up closes screenshot omissions, not a claim that
all settings states have already passed visual review.

- Extend the full context-layout/task matrix with 768px, retaining all assertions.
- Add 390/768/1440 screenshots of saved verified, expired, and failed origin
  states at the existing synthetic GET-boundary visual seam. Assert unchanged
  effective link, separate proposed link, pending status, enabled verification,
  activation eligibility, recovery text, and absence of writes/external requests.
- Freeze browser Date at 12:03 UTC: verified proof spans 12:00–12:05, expired
  proof spans 11:55–12:00, and failed proof has no success timestamps.
- Verified fixtures open the real review dialog, preserve old-link consequences,
  require acknowledgement before activation, and cancel back to the opener.
- Extend the real normal-CLI authenticated HTTP E13 browser flow to 768px and
  capture invalid draft, saved unverified draft, default-address review and
  activated default state. Existing HTTP 400/409/200, revisions, preserved draft,
  mutation transcript and token invariants remain unchanged.

The synthetic verified/expired/failed responses establish rendering and action
eligibility only. They do not establish a successful DNS/TLS/instance probe,
network reachability, or real expiry. The real E13 suite deliberately saves
reserved domains without running a network probe; default activation is exempt
from verification, not evidence of successful TLS verification.

Local application and browser-spec TypeScript checks passed. No local browser
was launched. Screenshots and runtime results remain pending CI; no production
code was changed and no visual defect is asserted before inspecting the new
pixels.

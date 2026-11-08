# Route and server UX acceptance checkpoints

## First checkpoint

Commit `c4f79fb47362c8c03c61f28ea3e586b2fd2b218d` on `acceptance-checkpoint-20261108-route-node-cache-guard` passed all 18 jobs in [run 42457080930](https://github.com/isning/RouteWeaver/actions/runs/42457080930), including Required repository gates. Frontend verification passed 268 files and 3246 tests, type checking and the production build. All four Chrome task shards passed, along with the backend, API, native, package, static and secret-scan gates.

This checkpoint covers the entry/intermediate/final-exit route workspace, first-server/core/listener continuation, matching listener prefill, context-preserving return and exact cached-inventory ownership protection. It does not establish completion of the broader configuration redesign.

Actual desktop (1440px) and narrow (390px) screenshots from the new route and onboarding journeys were independently reviewed in earlier runs on the same first-checkpoint implementation lineage. Eight route screenshots and ten onboarding screenshots showed no blocking clipping or occlusion. The final checkpoint reran the real browser journeys after the cache guard and disclosure-test corrections. A narrow screenshot cannot show the entire long path at once; a pair of onboarding path screenshots also captured the same viewport rather than separate lower controls. These are limits of the recorded pixels, not evidence that off-screen controls were visually reviewed.

All data used by these journeys was synthetic and isolated. A passing registration form is not proof of a live Agent connection, saved intent is not applied configuration, and these runs did not change production machines or deploy a preview.

## Continuing increments

The next independent increments address concurrent public-line edit recovery, a durable server workspace, in-context TLS correction and structured complex-policy configuration. Their code and tests must be reported separately at their own exact commits. The first checkpoint's passing results must not be reused as proof for later edits.

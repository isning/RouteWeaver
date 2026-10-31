# RouteWeaver planning staging

These are unapproved review drafts, not active instructions, an accepted specification, or implementation tickets. No production code has been written.

## Starting state

- Empty local Git repository initialized on `main`; no remote configured by this worker.
- No existing AGENTS.md, CLAUDE.md, glossary, ADRs, app, monorepo signals, or local installed skills.
- Official Matt Pocock skills source inspected at commit `49dd158d1076134a641b33efb035946536778336` from the supplied reference checkout. Relevant skills: setup-matt-pocock-skills, wayfinder, grilling, domain-modeling, prototype, to-tickets.
- Triage is available alongside setup in that reference checkout. `gh` exists, but authentication and remote creation were not attempted by this worker.
- The parent is coordinating the private GitHub repository and user approvals. Never infer that it exists from these drafts.

## Gates

1. Setup recommendations have been approved in the parent conversation: GitHub Issues, default triage labels, AGENTS.md as the new instruction file. Single-context domain documentation follows the empty repository evidence. Detailed draft review remains pending.
2. Show all setup draft contents for review and allow edits before promoting them to active files. Keep PR request-surface flag off. Create missing approved triage labels only on a verified target repository.
3. Settle the Wayfinder destination in live conversation. Ask the independent decision frontier in numbered rounds with recommended answers. Do not answer on the user's behalf.
4. Publish a planning map and precise decision tickets only after that discussion. Wire native sub-issues and native blocking relationships after real IDs exist. Wayfinder issues have only `wayfinder:*` labels.
5. Claim the selected decision ticket before working it. Resolve no more than one non-research decision per session. Record answer in a comment, close it, then add its named link and a one-line gist to the map.
6. Prototypes are throwaway HITL evidence, not production delivery. Show three structurally different UI options and capture the user's verdict before promotion. Preserve prototype/research evidence on throwaway branches once publishing is authorized.
7. After the map is resolved, propose end-to-end tracer-bullet implementation tickets with acceptance criteria and genuine blockers. User must approve granularity and dependencies before ticket publication and implementation.

## Next interaction

The parent has received approval of setup defaults and the engineering-quality direction. Do not ask the defaults again. Show the detailed setup draft once for review; after setup, use the proposed destination and first product question in `wayfinder/first-round.md`.

## Sources

Official repository source: https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336

The setup templates are copied into `setup/` for review only. Native GitHub features must be checked through the available tracker tools; body-only fallback is for genuinely unavailable native relationships, not convenience.

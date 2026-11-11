# Saved unknown instance status

The instance badge now says `状态尚未确认` instead of `正在确认状态` for the persisted `unknown` phase. This is a saved observation, not proof that confirmation is underway. Actual refresh progress and failed-refresh notices remain separate. No query timing, recovery gate, deployment operation or other status changes.

The public `InstanceObservation` regression holds a refresh and returns HTTP 503. It checks the retained unknown badge, distinct progress/failure messages, recovery guidance, available read-only refresh and two GET-only requests. It also checks the initial and pending-refresh badge. The initial red run reached the failed-refresh state and failed on the expected new badge (16 passed, 1 failed); changing only the mapping made it green. Initial/pending assertions were then added as coverage strengthening.

Final focused run: 65 tests passed across instance-apply-feedback, infrastructure-model, server-overview and line-workflow, with one worker. Application TypeScript and production build passed. These synthetic HTTP/JSDOM checks establish component behavior, not live node recovery or native-browser visual acceptance. No full suite, deployment or publication was performed; independent review remains for the coordinator.

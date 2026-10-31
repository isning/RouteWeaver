# Safe default focus for policy discard

The Service Offering and individual Entitlement unsaved-change confirmation now explicitly focuses “继续编辑” using Ant Design's supported `focusable.autoFocusButton: "cancel"` option. Pressing Enter on initial dialog focus retains the draft instead of discarding it.

Evidence: the two existing edited-policy public DOM flows were extended to assert initial focus and press Enter. Both failed before the change. The final combined focused run (`npm test -- --maxWorkers=1 src/page-recovery.dom.test.tsx src/access-policy.dom.test.tsx`) passed all 24 tests, including the 19 policy tests. No timeout increases or skipped assertions were used. Typecheck and build passed. Browser verification is left to the coordinator.

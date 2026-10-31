# Collection source-action query ownership verification

24 October 2026

## Change

The collection fixture's `addSource` helper now resolves exactly one currently accessible dialog, then finds the same “添加来源” button by accessible role/name within it. It does not assume a new-collection title; renamed edit contexts are supported. Missing or ambiguous dialogs/buttons remain failures. There is no hidden-element override, arbitrary first match, fallback or element cache.

In the owned-gesture branch, **both DOM lookups remain inside the existing scenario.click resolver**, after its abort/finished guard. Connected-target and post-event guards are unchanged. Existing user events, awaits, assertions and source-field interactions are unchanged. The previously integrated fixture wave-disabled ConfigProvider is preserved byte-for-byte; production UI code is untouched.

## Native validation

A fresh private copy of the integrated wave-disabled baseline received only this helper hunk. Full web typecheck passed. The original collection file passed **16/16 tests once**, native exit0, worker1/retry0, existing native10-second/default and explicit budgets, unchanged declaration order. No profiler, retry or full-suite run was used. This includes renamed collection editing and the owned gesture-boundary case.

Canonical source/modes/dependency bindings remained unchanged during validation. Private source inputs were invariant after execution; only normal typecheck build metadata changed. The exact tested file is the integration candidate.

## Identity and limits

Target: `web/src/collection-source-task.dom.test.tsx`, mode0644.

- Integrated wave-disabled baseline SHA256: `e66d67dfe0aaa55085ab8b74f68b8fa10f8bac68c2d8e34e923cfad37d2c8c54`.
- Tested helper-only candidate SHA256: `93e103e7ee81292d587a8820b981501b9bb8770c3fc4995d208b64afdaea8eab`.
- Validation manifest SHA256: `f249b00891e8179c1caba6125bed905bf3106730d65ef1c5fb261a62c2c9e6b8`.

Removing the helper hunk restores the integrated baseline exactly. All other file bytes, including wave props, are unchanged. Integration must require this baseline and preserve unrelated files.

This is a source-ownership improvement with functional validation, **not a measured speedup, timeout fix, aggregate-suite pass or browser-latency claim**. The extra dialog query has its own cost. Earlier aggregate failures remain independent evidence. No visibility algorithm, focus trap, production motion or native test budget was changed.

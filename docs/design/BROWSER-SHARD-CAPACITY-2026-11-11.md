# Browser shard capacity, 2026-11-11

The required browser matrix increases from four to six duration-balanced, complete-file shards. The existing scheduler, test inventory, one-worker isolation, 12-minute job cap, per-test budgets, retries, sandbox verification and required aggregate gates remain unchanged. All six matrix jobs must succeed; supplemental workflows do not replace them.

## Evidence and limits

At source da66409, required jobs 130680920337 (2/4), 130680920593 (3/4) and 130680919903 (4/4) stopped during test execution at approximately 17:25:21 UTC. They completed 83/91, 157/170 and 146/150 listed tests respectively. Each reported an estimated 775 seconds of test work before setup, already longer than the 720-second whole-job cap. Upload narrowing cannot fix cancellation before uploads. The available fourth log, 130680919713, belongs to supplemental recovery, not required shard 1; it completed 70 tests with 10 failures.

List-only discovery at a712aa6 found 137 files and 552 tests. Metadata has 84 measured files and 53 new files receiving the existing positive 30-second fallback. Four-way estimates are 775–777 seconds, five-way estimates 620–621 seconds, and six-way estimates 516–518 seconds. Observed runner-start-to-test-start overhead in those three jobs was approximately 127–178 seconds. Six is the smallest count supported by those estimates within the unchanged job cap. These numbers are scheduling estimates, not guaranteed runtime or passing results; failed/truncated runs are not substituted for successful duration metadata.

Two additional runners repeat setup, approximately 4–6 additional runner-minutes total using that observed overhead, plus artifact overhead. Actual cost, queueing, and completion time remain dependent on runner conditions. Required coverage and supplemental coverage are not narrowed.

## Verification

The updated six-shard workflow contract failed before the workflow change. Focused checks pass: 16 browser scheduler/native contract tests, 10 CI gate tests, and 9 supplemental workflow contract tests. Actual list-only partition integrity also passes: six shards contain 109, 60, 92, 76, 104 and 111 tests, covering all 137 files and 552 test identities exactly once. Exact file selectors must rediscover the same test identities, and the six partitions must cover every discovered file and identity exactly once. Existing four-way CLI regression coverage is retained alongside six-way coverage.

Actual Chrome execution and exact-source required aggregate acceptance remain pending. No browser, full integration suite, or production code change is part of this scheduling slice.

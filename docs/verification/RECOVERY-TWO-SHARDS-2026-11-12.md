# Two supplemental recovery shards

The ccb428a supplemental lane reached its unchanged ten-minute test-step cap after 101 individual passes, without a complete summary. The parent separately verified the required full-browser and frontend lanes. A partial supplemental run is not described as a completed pass.

## Change

Split only the supplemental recovery job into matrix shards 1/2 and 2/2 using Playwright's actual `--shard` option. Keep all 28 configured specs, one worker in each job, zero retries, unchanged per-test configuration, the ten-minute test-step and fifteen-minute job caps. `fail-fast: false` lets the other shard finish and retain its evidence if one fails. Separate GitHub runners retain separate demo/server state; this does not parallelize workers against one mutable fixture.

The Chrome provenance/startup block is unchanged. Its existing `playwrightShard` receipt now identifies the matrix shard. Artifact names include commit SHA plus shard index/total, preventing upload collisions. Existing explicit capture/report paths, negative privacy contracts, unconditional artifact upload, retention and cleanup headroom are unchanged. The required full-browser lane and its distribution algorithm are not modified.

## Selection proof

A separate checker runs after Node dependency setup in each supplemental matrix job and calls the installed Playwright CLI with the actual recovery configuration and `--list --reporter=json`, first unsharded and then with `--shard=1/2` and `--shard=2/2`. It checks nonempty discovery, unique project/test identities, all configured spec filenames, disjoint shard identities, and exact-once multiset equality with complete discovery. It does not infer sharding from filenames or Vitest behavior, and list-only results are not execution passes.

On snapshot base2f7b5c2, actual discovery contains105 tests across28 specs, split53+52. Offline workflow/artifact/coverage-negative contracts remain independent of Node dependencies in the required static lane. The real CLI checker fails if dependencies or discovery fail; it never silently skips. The earlier expected104 total is not substituted for this measured inventory. No TypeScript application or configuration file changes; actual CLI discovery loads the unchanged Playwright configuration/specs.

## Remaining evidence

Native shard execution and aggregate completion remain pending. Count-based partitioning proves coverage, not equal duration or that both jobs will meet the existing caps. No browser launch, manual run/cancel, deployment, fixture removal, assertion relaxation or sandbox workaround is part of this proposal.

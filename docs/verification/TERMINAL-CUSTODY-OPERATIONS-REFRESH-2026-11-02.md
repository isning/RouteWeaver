# Terminal-custody operational refresh — bounded reference PASS

**14/14 required tests passed** (20 pass events including subtests), zero skips,
failures or retries. This is one operational drill run, **not another 30-minute
soak**, production SLA, automatic finalization proof, or closure of the original
unclassified reference failure.

## Exact source and execution

- Source: `b38b12b7730a964cf3b3bf0273b8991617a2b586`.
- Tree: `87555653cf140cc4405007eff73e972afa3cddf9`.
- Fresh managed Xray built using Go 1.27.3, same checked-out modules, no download.
  SHA-256: `1ff4fc4ce1b5bcc4563d0aa97c0b841aad53d41bfdb7a9bbccff141bdb69be82`.
- All 248 production/module/lock paths, 302 test files and binary digest match
  before/after. Full manifests and binary build metadata accompany this receipt.
- Parent `GOMAXPROCS=1`, `GOMEMLIMIT=256MiB`, `GOPROXY=off`; observation and provider
  drill variables unset. Native supervisor strips those Go resource variables;
  no child soft-cap or hard CPU/RSS-cap claim. Linux 6.18.57 x86_64; cgroup quota
  files were unavailable/unreadable in this view.
- Native group: 2026-11-02 **03:44:19.478393–03:46:12.598035 UTC**, 113.120s,
  existing `-race -p=1 -count=1 -timeout=180s`, exit 0.
- Recovery group: **03:46:12.601102–03:46:53.304885 UTC**, 40.704s,
  existing `-race -p=1 -count=1 -timeout=120s`, exit 0.
- Wrapper wait4 maximum RSS 1,069,224 KiB is the cumulative maximum among
  compiler/test children, **not native RSS**, summed usage or a measured limit.

## Observed operational acceptance

| Check | Result |
|---|---|
| Notification failure/retry | Visible retry and stable identity; test 0.26s; logical retry clock, synthetic delivery |
| Brief disconnect/reconnect | 253.297ms disconnected; refresh 44.030ms; stale observation retained |
| Exact running traffic/accounting | Native and CP raw/weighted checkpoint **10,694 bytes**; settlement 7.644s |
| Live encrypted backup | 88,274 bytes; export 15.893s; **200 exchanges inside export window** |
| Fresh verification/restore/reopen | 14.170s; copied DB not activated; original flow/identity remained usable |
| Genuine CP outage | Existing flow restricted after **29.839s**, within unchanged 33s guard; native still alive before legal stop |
| Legal stop/manual resolution | Driver canceled/drained; typed HTTP503 observed; owned absence and exact final validated; reconciliation 338.216ms; replay rejected |
| Durable restart/recovery | Same spool/reconciler closed and reopened; fresh generation/epoch, actual old-epoch CP custody matching full final, readmission **11.805s**, within unchanged 20s bound |
| Final obligations/cleanup | Owned absence true; no running marker; pending batches 0; two budgets closed; unresolved 0, retained reservation 0; settled/CP usage **10,894 bytes**; checked closes succeeded |
| Broker EOF | Exact 44-byte native final; reopen/replay 10.562ms; synthetic typed custody then GC, explicitly **not CP delivery**; owned absence confirmed |

The final shutdown epoch still had its valid local baseline/final pair at the
terminal check. This is **retained local evidence**, not a claim that this second
epoch already had a CP terminal custody ACK. The earlier interrupted epoch did
have actual CP custody. Successful fixture cleanup invoked temporary-state removal; filesystem deletion
was not independently asserted (the fixtures ignore RemoveAll errors). No failure
forensic directory was required.

The eleven fake recovery tests cover outstanding obligations through encrypted
restore, concurrent backup writes, counter replay/regression, notification
retry/restart, lease restriction, generation fencing, retirement crash replay
and real-baseline enforcement. Exact selectors and all durations are in the JSON
receipt; complete unfiltered JSONL is preserved, not only passing summaries.

## Evidence and boundaries

`evidence/TERMINAL-CUSTODY-OPERATIONS-REFRESH-2026-11-02.json` binds source,
commands, environment, manifests, binary and every pass duration. Companion files
contain both raw JSONL groups, pure preflight JSONL, manifests and build metadata.

- Native JSONL SHA-256: `59bf308a8102a7d4dac7101f6abf787cfa89f60e8f5c3cd5ff7eac9121c634ae`.
- Recovery JSONL SHA-256: `38df65c58f176dc0700ca197a1147a7f50d2a9ca70fc1a06d972dc602c323d96`.

No stock sing-box, browser, real node, public destination, host-setting change,
remote CI or push was used. Earlier sample-410 unclassified failure, later
30-minute diagnostic pass and failed 13/14 operational refresh remain separate
historical evidence. This successful correction/refresh does not rewrite them.

Independent read-only review verified the source/binary/manifests, complete pass
counts/durations, raw hashes and accounting/custody statements. Its correction
about unasserted temporary-directory deletion is incorporated above.

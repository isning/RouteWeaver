# Integrated gate checkpoint: 8685726

Application source: 8685726. Root harness adds `-timeout=20m` per Go package; CI timeout is 45 minutes. These changes do not skip tests or change service operation deadlines. Completed 2026-10-19 21:10 UTC.

All four retained command logs ended successfully:

- `GOMEMLIMIT=768MiB scripts/verify.sh quick`: root Go race tests, builds/vet, managed runtime race tests, web typecheck, 93 DOM/model tests in 14 files, production web build. Heavy packages: backup 595.673s, HTTP 171.578s, Store 130.154s; managed runtime 12.722s.
- Native parser gate: required pinned client/server parser, file-bundle, receiving-shape, override, template, and immutable installer fixtures.
- Native runtime gate selected Xray: actual process/fleet lifecycle and two-hop payload/no-fallback cases.
- Managed native gate: all three required actual CP/agent/native private-IPC and payload cases.

The logs are evidence for these exact sources, not later UI/API changes. This is not `verify.sh full`: real browser execution and sing-box process startup remain blocked by host restrictions. No browser pixels, external VPS deployment, GitHub publication, remote CI, or production credentials are implied. Browser tests and request-client tests are distinct. The web chunk-size warning and jsdom canvas notice remain in the unedited log.

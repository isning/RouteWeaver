# Host-owned agent verification — 2026-11-18

See [ownership decision](../design/HOST-AGENT-OWNERSHIP-2026-11-18.md) for the final model. No real VPS was enrolled or modified.

## Verified seams

- Host registration before any cores; later core creation inherits host authority; distinct child credentials cannot cross core scopes.
- Host rotation/revocation invalidates root and child credentials; administrator-only operations and cross-host denials; sanitized public state.
- First installation without listeners, exact catalog/version and generation checks, arbitrary release/URL rejection.
- Host physical-resource ingestion with zero cores, idempotent receipt and revoked-authority rejection.
- Multi-core driver ownership, partial-manifest preservation, version metadata without worker restart, bounded expiry/cancellation and shared installer cancellation.
- Actual approved Xray and sing-box archive preparation through the HTTP assignment/install/observation chain, with native checks and independent install receipts. This test deliberately asserts no observed runtime activation.
- Idle foreground signal shutdown sends no fabricated core observation when no desired state was accepted. Host CLI connects with no instance argument and no synthetic core journal.
- Server overview enrollment, host-only enrollment request body, token preservation across core movement, explicit core-install action, offline gating and installed-state feedback. Focused DOM tests exercise retained drafts and late asynchronous responses.

## Executed evidence

Ignored local logs under `bin/` retain command output:

- `host-agent-api-final.log`: focused host API tests with race detector, pass
- `host-agent-regression.log`: full agent, protocol and observability package race suites passed; the initial CLI signal assertion expected an invalid empty observation and was corrected to the idle-service contract
- `host-agent-cli-final.log`: complete CLI package race suite passed after that correction
- `host-agent-driver-final.log`: focused driver, installer cancellation and signal regressions passed
- `host-agent-web-final.log`: 76 tests across five focused DOM files passed; `host-agent-web-composed.log` passed all 142 tests across eleven server/resource regression files
- `host-agent-web-build.log`: TypeScript and production web build passed
- `host-agent-native-gate.log`: `scripts/verify.sh native` passed; required native fixtures now include `TestNativeHostAgentInstallsMultipleCores`
- `host-agent-store-final.log`: focused resource repository race tests passed
- `host-agent-last-regression.log`: final host driver, shared-installer cancellation and empty-host CLI tests passed
- `host-agent-architecture.log`: production import architecture check passed

The native gate establishes the named local parser/install contracts, not production network reachability or runtime support on every host. The restricted workspace's sing-box netlink startup limitation is unchanged. No complete repository gate, independent external review, real-server deployment or post-change desktop/narrow browser review is claimed here.

The local preview's ephemeral demo database was exported as an encrypted backup and restored into a private workspace database before updating the preview. Authentication and retained inventory were checked: seven hosts, one core, zero listeners. No fake agent connectivity or installed runtime was inserted.

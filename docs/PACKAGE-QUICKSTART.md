# RouteWeaver application package

This package contains the control-plane executable, node-agent executable, managed Xray executable and web
UI. Run it from the extracted directory so `web/dist` is found. Administration is
performed in the web UI; the shell is only used to start the application.

## Local evaluation

    ./routeweaver-control-plane --demo

Open http://127.0.0.1:8080. The process prints the synthetic local demo account.
Demo state is isolated and removed when the process exits. It is not suitable for
real nodes or private subscriptions. The UI exercises real local APIs, not a
mocked dashboard. Stop with Ctrl+C.

## Persistent operator installation

Supply a 32-byte encryption key as 64 hexadecimal characters in
`ROUTEWEAVER_MASTER_KEY`. Keep that key outside the repository and in secure
operator-controlled storage. On first setup supply
`ROUTEWEAVER_ADMIN_USERNAME` and `ROUTEWEAVER_ADMIN_PASSWORD`; remove the password
from the process environment after bootstrap on subsequent starts.

    ./routeweaver-control-plane --db /your/private/path/routeweaver.db

The default listener is loopback. Binding a remote interface requires explicit
TLS certificate/key flags. Do not expose the demo account or bypass certificate
validation. Production enrollment and external notification credentials are
operator actions, not performed merely by unpacking this application.

## HTTPS reverse proxy

When a trusted reverse proxy terminates HTTPS, keep the application listener on
loopback and set `--public-origin https://console.example.com` to the exact browser
origin. The proxy must preserve that origin's Host header. The application marks
session cookies Secure and checks mutation origins against this configured origin;
it does not trust Forwarded or X-Forwarded-* headers for authorization. Never make
the backend listener directly reachable from untrusted clients.

This browser-login origin is independent from the subscription delivery origin in
Settings. Changing a subscription origin does not change login security or rotate
subscription tokens. Subscription domain activation requires its own explicit
verification and activation steps.

## Node agent

See `NODE-AGENT.md` for explicit scope, pinned core installation, authenticated
control-plane transport and process supervision options. The package includes the separately identified managed Xray runtime, with its
source/license notices. It does not bundle stock core binaries, private keys or
a pre-enrolled node identity. Read `MANAGED-XRAY.md` for its supported Linux
capabilities; do not infer that stock adapters provide the same account effects. The core family
is selected by an extensible adapter, not a fixed dual-core mode.

## Current acceptance status

Native configuration validation, stock process liveness and an isolated traffic
fixture do not establish per-user enforcement. The separately identified managed
Xray adapter has stronger local evidence: real control-plane provisioning → scoped
agent/private pipes → native VLESS TCP/TLS payload, with selective principal
revocation, shared finite quota, group-derived policy and independent TCP/mux
stream caps. Account-global IP/stream/quota claims also have separate transactional
and real child-process tests. Stock Xray/sing-box adapters do not inherit these
managed effects. Read the exact [group/stream-cap evidence](verification/GROUP-AND-CONNECTION-LIMITS-2026-10-19.md)
and [cross-process claim review](verification/MIGRATION-RESERVATION-REVIEW-2026-10-19.md).

The [integrated 8685726 checkpoint](verification/integrated-8685726/README.md)
passed quick checks, pinned native parsing, selected Xray lifecycle/fleet tests
and the required managed CP/agent/native tests. It is not `verify.sh full`,
acceptance of later changes, or completion of all 35 stories. Browser visual/mobile
acceptance remains blocked; sing-box native `check` passes but process startup is
blocked here by netlink permission denial. No host-security bypass was attempted.
Real VPS/public network paths and production enrollment have not been performed.
The user-created private repository is isning/RouteWeaver; inspect Actions for the
exact source commit rather than treating this historical checkpoint as remote CI
evidence. Current repository and deployment gates are in
[RELEASE-GATES](verification/RELEASE-GATES.md). Cross-compiled macOS packages have not been
executed on your Mac; supervised managed runtime support is positively tested on
Linux amd64, not inferred from cross-compilation.

Finite managed quota grants do not remove crash uncertainty: there is no per-byte
native WAL, and unresolved reservations remain held for explicit reconciliation.
The supervisor's OS process-birth/descendant and storage assumptions still apply.
Warm-history admission costs have improved, but cold reconstruction, live
obligations and concurrent writer waiting remain measured limits, not a fleet
capacity promise. See the [full-scope acceptance matrix](verification/ACCEPTANCE-MATRIX-2026-10-19.md)
for current capability boundaries and remaining gates.

## Backup resource limits

Streaming backup operations retain the complete logical state, including secrets
and accounting history; they fail rather than omit records. The control-plane
flags `--backup-max-archive-mib` (default/hard maximum 1024),
`--backup-max-record-mib` (default 32, hard maximum 128), `--backup-max-rows`
(default/hard maximum 2,000,000), and `--backup-timeout` (default/hard maximum
10m) bound operator resource use. Lower them for constrained hosts. These are
finite limits, not unlimited history retention. Keep enough private disk space
for encrypted temporary staging and restore; never copy a master key into a
shared template or repository. See the backup verification record for the exact
streaming acceptance evidence and legacy import compatibility.

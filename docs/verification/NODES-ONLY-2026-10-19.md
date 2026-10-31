# Nodes-only receiving-shape acceptance

`TestNativeClientNodesOnlyConsumption` renders the real nodes-only artifact, then
merges its unchanged `proxies` (Mihomo) or `outbounds` (sing-box) into a minimal
receiving configuration with a reference to the emitted stable name. It does not
call the full-config renderer to substitute another artifact.

Both pinned native checkers accepted that receiving configuration:
Mihomo 1.19.32 and sing-box 1.14.3. A negative sensitivity check replaces the first
emitted protocol with an unknown protocol; both checkers reject it. This proves
that these checks inspect the imported node definitions rather than just a shell.
The local focused run passed both subcases, including those negative checks.
The parser harness requires the parent test to pass and rejects skips.

A separate probe found that Mihomo `-t` accepts a file proxy-provider even when
its file contains an unknown node protocol. Accordingly this test uses the merge
receiving shape; it does not claim file-provider loading or client UI import
acceptance. There is no native process/network payload, mobile client, clipboard,
or device import proof in this test.

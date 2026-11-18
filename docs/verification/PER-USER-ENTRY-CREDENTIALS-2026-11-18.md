# Per-user entry credentials

Current stock sing-box listeners support individual credentials for VLESS, VMess, Trojan, Hysteria2, AnyTLS, TUIC and SOCKS. Current stock Xray listeners support VLESS, VMess and Trojan. Managed Xray retains its existing VLESS provisioning. Existing shared listeners remain readable and can be switched explicitly. Shadowsocks 2022 on sing-box uses an endpoint key and a separate per-user key for the AES-128-GCM and AES-256-GCM methods. The endpoint key is entered in listener inventory and is included in each issued client connection alongside that user’s key. Stock Xray SOCKS has no verified per-user routing in this integration.

The stock workflow stages credentials in a revision and releases subscription content only after a matching active artifact is observed. Revocation stages removal of the individual credential. Existing clients stop authenticating with that credential after the removal is deployed. Stock listeners do not enforce managed quota or connection limits. Removing the last SOCKS or Shadowsocks user omits the inbound to prevent fallback to anonymous or shared-key access.

Focused Go tests passed for separate account grants, activation gating, revocation and SOCKS inbound removal. The pinned native parser gate, 103 focused frontend tests and the production frontend build passed. Activation gates in API tests use controlled observations. Live sing-box traffic and stock runtime enforcement were not exercised. No independent review was run.

The Shadowsocks extension exercised the two-account API lifecycle, empty-inbound rendering and pinned server and client parser fixtures. The Mihomo and sing-box client fixtures load the two-part key.

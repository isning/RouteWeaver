# Listener network options and server graph

The listener editor exposes TCP Fast Open and keepalive timing for stock Xray and sing-box. Stock Xray additionally supports incoming PROXY protocol. sing-box supports disabling keepalive and offers UDP fragmentation and NAT timeout for SOCKS, Shadowsocks, Hysteria2 and TUIC listeners. Agent policy for explicit MPTCP still applies. Network options belong to the listener snapshot and do not enter client subscriptions.

The server graph groups listeners by server. Individual handle identities remain listener IDs, including for two ports on one server. Draft route order and compilation remain endpoint based.

Focused DOM tests exercise grouping, route edits and socket option persistence. Chromium verified the annotated route at 1440 px and 390 px with both handles attached to its server node. The four pinned stock parsers accepted the generated options. Live socket performance and operating-system activation were not measured.

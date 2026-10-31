# REALITY listener/client consistency

The listener connection is also the source of subscription and next-hop parameters. The server renderer previously accepted a server REALITY private key/allowlists that did not match that connection. A configuration could pass native syntax checks yet be unusable by its advertised client.

The existing server TLS validation seam now checks mode agreement, derives the X25519 public key with Go's standard crypto/ecdh package, compares decoded public keys, requires the advertised SNI in the server name allowlist, and compares short IDs as zero-padded eight-byte values. This preserves pinned Xray/sing-box hexadecimal case/padding semantics. It neither generates credentials nor rewrites intent. Managed-Xray remains unsupported for REALITY.

## Evidence
- Red: both stock adapters accepted missing client REALITY, wrong public key, wrong short ID and wrong SNI (8 negative subtests failed).
- Green: complete render unit suite passed; focused race test passed including matching, empty and equivalent padded short IDs, exact SNI behavior, and both mode mismatch directions.
- Native/race: complete render package with pinned Xray 26.3.27 and sing-box 1.14.3 parser binaries passed (2.715s). This is parser evidence, not live traffic or deployment proof. The added edge cases then passed focused race (1.055s).
- The native server fixture initially failed the new key check: its copied arbitrary client public key did not correspond to its synthetic private key. The fixture now derives the advertised public key from that fixed synthetic key; the guard was not weakened.
- Initial audit was independent, but the final implementation was completed by the coordinator after worker quota exhaustion. No independent post-implementation review is claimed.

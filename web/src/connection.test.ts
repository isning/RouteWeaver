import { it, expect } from "vitest";
import { normalizeConnection } from "./ConnectionFields";
it("removes stale protocol fields when changing transport without mutating the source", () => {
  const value = {
    host: "example.com",
    port: 443,
    protocol: "vless",
    uuid: "fixture",
    transport: {
      type: "grpc",
      path: "/old",
      host: "old.example.com",
      serviceName: "current",
    },
  };
  expect(normalizeConnection(value).transport).toEqual({
    type: "grpc",
    serviceName: "current",
  });
  expect(value.transport.path).toBe("/old");
});
it("does not erase unsupported Hysteria2 input before validation", () => {
  const value = { host: "hy2.example", port: 443, protocol: "hysteria2", password: "synthetic", uuid: "retained", tls: { enabled: true, fingerprint: "chrome" }, transport: { type: "ws", path: "/retained" } };
  expect(normalizeConnection(value)).toEqual(value);
});

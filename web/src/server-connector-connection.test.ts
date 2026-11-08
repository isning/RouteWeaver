import { expect, it } from "vitest";
import { connectorConnectionShapeReason, prepareConnectorConnection } from "./server-connector-connection";
import type { Connection } from "./types";
const source = (): Connection => ({ protocol: "vless", host: "exit.example", port: 443, uuid: "00000000-0000-4000-8000-000000000001", tls: { enabled: true, serverName: "tls.example" }, transport: { type: "ws", path: "/path", host: "header.example", headers: { "X-Fixture": "synthetic" } } });
it("patches address and exact port while retaining all untouched credentials and unknown nested fields", () => {
  const original = source();
  const extended = { ...original, extension: { retain: true }, tls: { ...original.tls!, futureTLS: { retain: true } }, transport: { ...original.transport!, futureTransport: true } };
  const result = prepareConnectorConnection(extended, { ...extended, host: "new.example", port: "8443" });
  expect(result.connection).toEqual({ ...extended, host: "new.example", port: 8443 });
  expect(result.removedFields).toEqual([]);
  expect(original.host).toBe("exit.example");
});
it.each(["", "0", "65536", "443.00000000000001", "1e999", "-1"])("rejects invalid exact port %j", (port) => {
  const original = source();
  expect(prepareConnectorConnection(original, { ...original, port }).connection).toBeUndefined();
});
it("lists destructive protocol decisions without including credential values", () => {
  const original = source();
  const result = prepareConnectorConnection(original, { ...original, protocol: "socks", username: "fixture-user", password: "synthetic-password" });
  expect(result.connection).toEqual({ protocol: "socks", host: "exit.example", port: 443, username: "fixture-user", password: "synthetic-password" });
  expect(result.removedFields).toEqual(["UUID", "TLS 参数", "传输参数"]);
  expect(JSON.stringify(result.removedFields)).not.toContain(original.uuid);
});
it("preserves pre-existing inactive known fields when no semantic selector changes", () => {
  const original = { ...source(), vmessSecurity: "auto", transport: { type: "tcp", path: "/pre-existing-invalid" } };
  const result = prepareConnectorConnection(original, { ...original, host: "new.example" });
  expect(result.connection?.vmessSecurity).toBe("auto");
  expect(result.connection?.transport?.path).toBe("/pre-existing-invalid");
  expect(result.removedFields).toEqual([]);
});
it("protects unknown nested REALITY parameters from a destructive protocol switch", () => {
  const original = { ...source(), tls: { enabled: true, reality: { publicKey: "synthetic-public", shortId: "aa", future: true } } };
  const result = prepareConnectorConnection(original, { ...original, protocol: "socks" });
  expect(result.error).toBeTruthy();
  expect(result.connection).toBeUndefined();
});
it("preserves explicit TLS metadata on host changes and names TLS removal only after explicit disable", () => {
  const original = source();
  const result = prepareConnectorConnection(original, { ...original, tls: { ...original.tls!, enabled: false } });
  expect(result.connection?.tls).toBeUndefined();
  expect(result.removedFields).toEqual(["TLS 参数"]);
});
it("only clears incompatible transport fields after an explicit transport change", () => {
  const original = source();
  const result = prepareConnectorConnection(original, { ...original, transport: { ...original.transport!, type: "grpc", serviceName: "service" } });
  expect(result.connection?.transport).toEqual({ type: "grpc", serviceName: "service" });
  expect(result.removedFields).toEqual(["传输路径", "传输 Host", "请求头"]);
});
it("does not create headers merely by mounting the connection form", () => {
  const original = { ...source(), transport: { type: "ws", path: "/path" } };
  const draft = { ...original, transport: { ...original.transport, headerRows: [] } };
  expect(prepareConnectorConnection(original, draft).connection).toEqual(original);
});

it("restores unknown REALITY fields after an intermediate form mode roundtrip", () => {
  const original = { ...source(), tls: { enabled: true, reality: { publicKey: "synthetic-public", shortId: "aa", future: { retain: true } } } };
  const draft = { ...original, tls: { enabled: true, reality: { publicKey: "synthetic-new-public", shortId: "bb" } } };
  const result = prepareConnectorConnection(original, draft);
  expect(result.connection?.tls?.reality).toEqual({ publicKey: "synthetic-new-public", shortId: "bb", future: { retain: true } });
  expect(result.removedFields).toEqual([]);
});

it("never mutates inherited nested source objects when a draft omits optional subtrees", () => {
  const original = { ...source(), tls: { enabled: true, serverName: "tls.example", reality: { publicKey: "synthetic-public", shortId: "aa" } } };
  const before = structuredClone(original);
  const result = prepareConnectorConnection(original, { host: "new.example", port: "443", protocol: "vmess", uuid: original.uuid });
  expect(result.connection?.tls).toEqual({ enabled: true, serverName: "tls.example" });
  expect(result.connection?.transport).toEqual(before.transport);
  expect(original).toEqual(before);
  expect(result.removedFields).toEqual(["REALITY 参数"]);
});
it("preserves omitted security and transport subtrees when selectors are unchanged", () => {
  const original = source();
  const result = prepareConnectorConnection(original, { host: "new.example", port: "443", protocol: original.protocol, uuid: original.uuid });
  expect(result.connection).toEqual({ ...original, host: "new.example" });
  expect(result.removedFields).toEqual([]);
});

it("protects unknown disabled TLS and TCP subtrees from explicit structural removal", () => {
  const original = { ...source(), tls: { enabled: false, futureTLS: true }, transport: { type: "tcp", futureTransport: true } };
  expect(prepareConnectorConnection(original, { ...original, tls: undefined }).connection).toBeUndefined();
  expect(prepareConnectorConnection(original, { ...original, transport: undefined }).connection).toBeUndefined();
  expect(original.tls).toEqual({ enabled: false, futureTLS: true });
  expect(original.transport).toEqual({ type: "tcp", futureTransport: true });
});

it.each([
  { tls: "bad" }, { tls: null }, { tls: [] },
  { tls: { enabled: "false" } }, { tls: { enabled: true, alpn: "h2" } },
  { tls: { enabled: true, reality: "bad" } }, { tls: { enabled: true, reality: [] } },
  { tls: { enabled: true, reality: { publicKey: 7, shortId: "aa" } } },
  { transport: ["x"] }, { transport: null }, { transport: { type: "ws", headers: ["x"] } },
  { transport: { type: "ws", headers: { "X-Fixture": 7 } } },
  { transport: { type: "ws", headers: null } },
])("refuses malformed original security/transport shape without coercing it: %j", (fields) => {
  const original = { ...source(), ...fields } as unknown as Connection;
  const before = structuredClone(original);
  expect(connectorConnectionShapeReason(original)).toBeTruthy();
  expect(prepareConnectorConnection(original, { ...original, port: "8443" }).connection).toBeUndefined();
  expect(original).toEqual(before);
});
it("rejects malformed draft subtrees and reserved original header-row metadata without mutation", () => {
  const original = source();
  const malformed = { ...original, transport: { type: "ws", headerRows: "bad" } };
  expect(prepareConnectorConnection(original, malformed as unknown as Parameters<typeof prepareConnectorConnection>[1]).connection).toBeUndefined();
  const conflicting = { ...original, transport: { ...original.transport!, headerRows: [] } };
  expect(connectorConnectionShapeReason(conflicting)).toBeTruthy();
  expect(prepareConnectorConnection(conflicting, { ...conflicting, port: "8443" }).connection).toBeUndefined();
});

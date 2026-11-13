import { describe, expect, it } from "vitest";
import { connectorEditReason, updateServerConnector, updateServerConnectorVia } from "./server-connector-editor";
import type { ServerProgram } from "./types";

function fixture(): ServerProgram {
  return {
    instance: { id: "core", hostId: "host", adapterId: "routeweaver/sing-box", version: "1.14.4" },
    listener: { id: "entry", name: "Entry", instanceId: "core", connection: { protocol: "socks", host: "0.0.0.0", port: 1080 } },
    egress: [], rules: [], resources: [], defaultAction: { kind: "forward", ref: "exit" },
    connectors: [
      { id: "exit", connection: { protocol: "socks", host: "exit.example", port: 1080, username: "fixture", password: "synthetic-only" } },
      { id: "relay", connection: { protocol: "socks", host: "relay.example", port: 1080 } },
    ],
  } as ServerProgram;
}

describe("existing server connector editing", () => {
  it("changes only the selected endpoint and retains identity, credentials and unknown data", () => {
    const program = fixture();
    const connection = { ...program.connectors![0].connection, extension: { keep: true } };
    program.connectors![0].connection = connection;
    const result = updateServerConnector(program, "1.0", "exit", { host: "new.example", port: "443", via: "relay" });
    expect(result.error).toBeUndefined();
    expect(result.program?.connectors?.[0]).toEqual({ id: "exit", via: "relay", connection: { ...connection, host: "new.example", port: 443 } });
    expect(result.program?.defaultAction).toBe(program.defaultAction);
    expect(result.program?.connectors?.[1]).toBe(program.connectors![1]);
    expect(program.connectors![0].connection.host).toBe("exit.example");
  });
});

it.each(["", "0", "65536", "1.5", "1e3", " 443", "-1"])("rejects invalid port text %j without changing the draft", (port) => {
  const program = fixture();
  expect(updateServerConnector(program, "1.0", "exit", { host: "exit.example", port, via: "" }).program).toBeUndefined();
  expect(program.connectors![0].connection.port).toBe(1080);
});
it.each(["https://exit.example", "exit.example:443", " user.example", "user@host", "[::1]"])("rejects address %j rather than normalizing it", (host) => {
  expect(updateServerConnector(fixture(), "1.0", "exit", { host, port: "443", via: "" }).error).toBeTruthy();
});
it("keeps unbracketed IPv6 and nested TLS/transport fields verbatim", () => {
  const program = fixture();
  program.connectors![0].connection = { protocol: "vless", host: "before.example", port: 443, uuid: "00000000-0000-4000-8000-000000000001", tls: { enabled: true, serverName: "tls.example" }, transport: { type: "ws", host: "header.example", path: "/path" } };
  const result = updateServerConnector(program, "1.0", "exit", { host: "2001:db8::1", port: "443", via: "" });
  expect(result.program?.connectors?.[0].connection.host).toBe("2001:db8::1");
  expect(result.program?.connectors?.[0].connection.tls).toBe(program.connectors![0].connection.tls);
  expect(result.program?.connectors?.[0].connection.transport).toBe(program.connectors![0].connection.transport);
});
it("rejects self, missing and indirect cyclic upstream references", () => {
  const program = fixture();
  program.connectors![1].via = "exit";
  for (const via of ["exit", "missing", "relay"]) {
    expect(updateServerConnector(program, "1.0", "exit", { host: "exit.example", port: "1080", via }).error).toBeTruthy();
  }
});
it("does not upgrade a protected program into editable form", () => {
  const program = fixture();
  for (const version of ["future", ""]) {
    program.instance.version = version;
    expect(connectorEditReason(program, "1.0", "exit")).toBeTruthy();
  }
  program.instance.version = "1.14.4";
  program.listener.authentication = "principals";
  expect(connectorEditReason(program, "1.0", "exit")).toBeTruthy();
  delete program.listener.authentication;
  program.connectors![1].id = "exit";
  expect(connectorEditReason(program, "1.0", "exit")).toBeTruthy();
});
it("preserves unsupported protocols and legacy egress", () => {
  const program = fixture();
  program.connectors![0].connection.protocol = "future";
  expect(connectorEditReason(program, "1.0", "exit")).toBeTruthy();
  expect(connectorEditReason(program, "1.0", "relay")).toBeUndefined();
  program.egress = [{ host: "legacy.example", port: 1080, protocol: "socks" }];
  expect(connectorEditReason(program, "1.0", "relay")).toBeTruthy();
});

it("changes only the upstream reference even while an address is incomplete", () => {
  const program = fixture();
  program.connectors![0].connection.host = "";
  const result = updateServerConnectorVia(program, "1.0", "exit", "relay");
  expect(result.program?.connectors?.[0].connection).toBe(program.connectors![0].connection);
  expect(result.program?.connectors?.[0].via).toBe("relay");
  expect(result.program?.defaultAction).toBe(program.defaultAction);
  expect(updateServerConnectorVia(result.program!, "1.0", "relay", "exit").error).toBeTruthy();
});

it.each([7, null, undefined])("keeps malformed connector identity %j read-only", (id) => {
  const program = fixture();
  (program.connectors![0] as unknown as { id: unknown }).id = id;
  expect(connectorEditReason(program, "1.0", "relay")).toBeTruthy();
});
it.each([0, null, false])("keeps malformed upstream %j read-only", (via) => {
  const program = fixture();
  (program.connectors![0] as unknown as { via: unknown }).via = via;
  expect(connectorEditReason(program, "1.0", "exit")).toBeTruthy();
});

it.each(["hysteria2", "anytls"])("allows direct sing-box %s but rejects both directions of a connector detour", (protocol) => {
  const program = fixture();
  program.connectors![0].connection = { protocol, host: "direct.example", port: 443, password: "synthetic", tls: { enabled: true } };
  expect(connectorEditReason(program, "1.0", "exit")).toBeUndefined();
  expect(updateServerConnectorVia(program, "1.0", "exit", "relay").error).toContain("直接连接");
  expect(updateServerConnectorVia(program, "1.0", "relay", "exit").error).toContain("直接连接");
  program.instance = { ...program.instance, adapterId: "routeweaver/xray", version: "26.10.31" };
  expect(connectorEditReason(program, "1.0", "exit")).toContain("仅支持 sing-box");
});

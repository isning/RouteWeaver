import { expect, it } from "vitest";
import { addServerConnector, connectorCollectionEditReason, removeServerConnector, serverConnectorReferences } from "./server-connector-collection";
import type { ServerProgram } from "./types";
function fixture(): ServerProgram {
  return { instance: { id: "core", hostId: "host", adapterId: "routeweaver/xray", version: "26.10.31" }, listener: { id: "entry", name: "Entry", instanceId: "core", connection: { host: "0.0.0.0", port: 1080, protocol: "socks" } }, egress: [], rules: [], resources: [], defaultAction: { kind: "direct" } };
}
const connector = (id = "exit") => ({ id, connection: { protocol: "socks", host: "exit.example", port: 1080, username: "synthetic-user", password: "synthetic-password" } });
it("adds a named connector without selecting it or changing unrelated policy", () => {
  const source = fixture();
  const item = connector();
  const result = addServerConnector(source, "1.0", item);
  expect(result.error).toBeUndefined();
  expect(result.program).toEqual({ ...source, connectors: [item] });
  expect(result.program?.defaultAction).toBe(source.defaultAction);
  expect(result.program?.rules).toBe(source.rules);
  expect(source.connectors).toBeUndefined();
});
it("requires an explicit existing default and never invents a default or a secret", () => {
  const source = fixture(); delete source.defaultAction;
  expect(addServerConnector(source, "1.0", connector()).program).toBeUndefined();
  expect(source.defaultAction).toBeUndefined();
  expect(source.connectors).toBeUndefined();
});
it("rejects duplicate IDs, reserved IDs, unresolved upstreams and invalid connection addresses", () => {
  const source = fixture(); source.connectors = [connector()];
  for (const item of [connector(), connector("rw-direct"), { ...connector("relay"), via: "missing" }, { ...connector("relay"), connection: { ...connector().connection, host: "https://invalid.example" } }])
    expect(addServerConnector(source, "1.0", item).program).toBeUndefined();
});
it("lists all known references and refuses removal rather than retargeting any consumer", () => {
  const source = fixture();
  source.defaultAction = { kind: "forward", ref: "exit" };
  source.rules = [{ id: "rule", match: { op: "domain", value: "example.com" }, action: { kind: "forward", ref: "exit" } }];
  source.connectors = [connector(), { ...connector("relay"), via: "exit" }];
  expect(serverConnectorReferences(source, "exit")).toEqual(["默认去向", "规则 1", "连接器 2 的上游"]);
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
  expect(source.connectors).toHaveLength(2);
});
it("removes only an unreferenced connector while preserving surviving identities and credentials", () => {
  const source = fixture(); source.connectors = [connector(), connector("relay")];
  const result = removeServerConnector(source, "1.0", "exit");
  expect(result.program?.connectors).toEqual([connector("relay")]);
  expect(result.program?.connectors?.[0]).toBe(source.connectors[1]);
  expect(result.program?.defaultAction).toBe(source.defaultAction);
  expect(source.connectors).toHaveLength(2);
});
it("blocks destructive removal when extension fields could contain unknown references", () => {
  const source = { ...fixture(), futurePolicy: { ref: "exit" }, connectors: [connector()] };
  expect(removeServerConnector(source, "1.0", "exit").error).toBeTruthy();
  const nested = fixture(); nested.connectors = [{ ...connector(), connection: { ...connector().connection, futureDialer: "exit" } } as ReturnType<typeof connector>];
  expect(removeServerConnector(nested, "1.0", "exit").error).toBeTruthy();
});
it("keeps managed, principal, unsupported and legacy programs protected", () => {
  const source = fixture(); source.instance.adapterId = "routeweaver/managed-xray";
  expect(connectorCollectionEditReason(source, "1.0")).toBeTruthy();
  source.instance.adapterId = "routeweaver/xray"; source.listener.authentication = "principals";
  expect(connectorCollectionEditReason(source, "1.0")).toBeTruthy();
  delete source.listener.authentication; source.egress = [connector().connection];
  expect(connectorCollectionEditReason(source, "1.0")).toBeTruthy();
});
it("fails closed on unknown nested action and condition extensions", () => {
  const source = fixture(); source.connectors = [connector()];
  source.rules = [{ id: "rule", match: { op: "domain", value: "example.com" }, action: { kind: "direct", nestedAction: { kind: "forward", ref: "exit" } } as ServerProgram["rules"][number]["action"] }];
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
  source.rules[0].action = { kind: "direct" };
  source.rules[0].match = { op: "and", children: [{ op: "future-reference", value: "exit" }] };
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
});
it("counts principal references without reading or reporting principal credential values", () => {
  const source = fixture();
  source.principals = [{ subjectId: "subject", accountId: "account", routeId: "route", credentialVersion: "v1", credential: { uuid: "synthetic-principal" }, action: { kind: "forward", ref: "exit" } }];
  expect(serverConnectorReferences(source, "exit")).toEqual(["用户入口 1"]);
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
});
it("does not treat malformed or extended defaults as an explicit valid default", () => {
  const source = fixture();
  for (const action of [{ kind: "direct", ref: 0 }, { kind: "direct", futureFallback: "exit" }, { kind: "forward", ref: "missing" }]) {
    source.defaultAction = action as ServerProgram["defaultAction"];
    expect(addServerConnector(source, "1.0", connector()).program).toBeUndefined();
  }
});
it.each([false, 0, "", "invalid", {}, [null]])("retains malformed connector list %j without replacing it", (value) => {
  const source = fixture();
  (source as unknown as { connectors: unknown }).connectors = value;
  expect(connectorCollectionEditReason(source, "1.0")).toBeTruthy();
  expect(addServerConnector(source, "1.0", connector()).program).toBeUndefined();
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
  expect(source.connectors).toBe(value);
});
it.each(["rules", "resources", "principals", "egress"] as const)("rejects malformed %s safely at render/reference seams", (key) => {
  const source = fixture(); source.connectors = [connector()];
  (source as unknown as Record<string, unknown>)[key] = "invalid";
  expect(connectorCollectionEditReason(source, "1.0")).toBeTruthy();
  expect(serverConnectorReferences(source, "exit")).toHaveLength(1);
  expect(removeServerConnector(source, "1.0", "exit").program).toBeUndefined();
});
it("does not activate an unresolved default by adding its missing target", () => {
  const source = fixture(); source.defaultAction = { kind: "forward", ref: "exit" };
  expect(addServerConnector(source, "1.0", connector()).program).toBeUndefined();
  expect(source.connectors).toBeUndefined();
  expect(source.defaultAction).toEqual({ kind: "forward", ref: "exit" });
});

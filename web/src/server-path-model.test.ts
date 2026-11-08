import { describe, expect, it } from "vitest";
import { compileOrderedServerPath, orderedPathChangeReason, orderedServerHopKey, readOrderedServerPath } from "./server-path-model";
import type { OrderedServerHop } from "./server-path-model";
import type { Connection, Infrastructure, ServerDeployment, ServerProgram } from "./types";

const connection = (host: string): Connection => ({ protocol: "socks", host, port: 1080, username: "admin", password: "kept-secret" });
const managed = (endpointId: string): OrderedServerHop => ({ kind: "managed", endpointId });
const external = (programEndpointId: string, connectorId: string): OrderedServerHop => ({ kind: "connector", programEndpointId, connectorId });
function fixture() {
  const programs: ServerProgram[] = ["a", "b", "c"].map((id, i) => ({
    instance: { id: `core-${id}`, hostId: `host-${id}`, adapterId: "routeweaver/xray", version: "26.10.31" },
    listener: { id, name: id.toUpperCase(), instanceId: `core-${id}`, connection: connection(`192.0.2.${i + 1}`) },
    egress: [], rules: [], resources: [], defaultAction: { kind: "direct" },
  }));
  const [a, b] = programs;
  a.connectors = [
    { id: "y", via: "x", connection: connection("y.example") },
    { id: "to-b", via: "y", connection: { ...b.listener.connection } },
    { id: "x", connection: connection("x.example") },
    { id: "spare", connection: connection("spare.example") },
  ];
  a.defaultAction = { kind: "forward", ref: "to-b" };
  b.connectors = [{ id: "x", connection: connection("other.example") }];
  b.defaultAction = { kind: "forward", ref: "x" };
  const draft: ServerDeployment = { id: "path", name: "Path", status: "draft", diagnostics: [], ir: { schemaVersion: "1.0", id: "path", topologyRevision: "r1", programs: [a, b] } };
  const inventory: Infrastructure = {
    hosts: programs.map(p => ({ id: p.instance.hostId, name: p.instance.hostId, address: p.listener.connection.host })),
    instances: programs.map(p => p.instance), endpoints: programs.map(p => p.listener), links: [], deployments: [draft],
  };
  return { draft, inventory };
}

describe("ordered administrator path adapter", () => {
  it("reads physical Via order, hides managed bridges, and retains program-scoped external identities", () => {
    const { draft, inventory } = fixture();
    expect(readOrderedServerPath(draft, inventory)).toEqual({ editable: true,
      hops: [managed("a"), external("a", "x"), external("a", "y"), managed("b"), external("b", "x")],
      connectorChoices: [
        { programEndpointId: "a", connectorId: "y", label: "y" },
        { programEndpointId: "a", connectorId: "x", label: "x" },
        { programEndpointId: "a", connectorId: "spare", label: "spare" },
        { programEndpointId: "b", connectorId: "x", label: "x" },
      ],
    });
  });
  it("reorders only the selected scoped chain while preserving policy, unknown fields, credentials, and unused connectors", () => {
    const { draft, inventory } = fixture();
    Object.assign(draft, { futureEnvelope: { keep: true } });
    Object.assign(draft.ir, { futureIR: { keep: true } });
    Object.assign(draft.ir.programs[0], { futureProgram: { keep: "program" }, destinationPolicy: { allowCidrs: ["192.0.2.0/24"] }, resources: [{ id: "unused-policy-resource", custom: "kept" }] });
    Object.assign(draft.ir.programs[0].connectors![2], { futureConnector: { keep: "connector" } });
    Object.assign(draft.ir.programs[0].connectors![2].connection, { futureConnection: { keep: "connection" } });
    const before = structuredClone(draft);
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "y"), external("a", "x"), managed("b"), external("b", "x")], inventory);
    expect(result.ir.programs[0].connectors).toEqual([
      { id: "y", connection: connection("y.example") },
      { id: "to-b", via: "x", connection: connection("192.0.2.2") },
      { id: "x", via: "y", connection: { ...connection("x.example"), futureConnection: { keep: "connection" } }, futureConnector: { keep: "connector" } },
      { id: "spare", connection: connection("spare.example") },
    ]);
    expect({ ...result.ir.programs[0], connectors: [] }).toEqual({ ...before.ir.programs[0], connectors: [] });
    expect(result.ir.programs[1]).toEqual(before.ir.programs[1]);
    expect({ ...result, ir: null }).toEqual({ ...before, ir: null });
    expect({ ...result.ir, programs: [] }).toEqual({ ...before.ir, programs: [] });
    expect(draft).toEqual(before);
  });
  it("allows an unallocated managed ingress draft without treating it as applied or editing principals", () => {
    const { draft, inventory } = fixture();
    const ingress = draft.ir.programs[0];
    ingress.instance.adapterId = "routeweaver/managed-xray";
    ingress.instance.version = "26.3.27-rw1";
    ingress.listener.authentication = "principals";
    ingress.listener.connection = { protocol: "vless", host: "0.0.0.0", port: 443 };
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "spare"), managed("b"), external("b", "x")], inventory);
    expect(result.status).toBe("draft");
    expect(result.ir.programs[0].principals).toBeUndefined();
    expect(result.ir.programs[0].connectors!.find(c => c.id === "to-b")?.via).toBe("spare");
    expect(readOrderedServerPath(result, inventory).editable).toBe(true);
  });
  it("adds an unused administrator connector and removes a terminal hop without deleting saved connections", () => {
    const { draft, inventory } = fixture();
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "spare"), managed("b")], inventory);
    expect(readOrderedServerPath(result, inventory)).toMatchObject({ editable: true, hops: [managed("a"), external("a", "spare"), managed("b")] });
    expect(result.ir.programs[0].connectors!.find(c => c.id === "to-b")?.via).toBe("spare");
    expect(result.ir.programs[0].connectors!.filter(c => c.id !== "to-b")).toEqual(draft.ir.programs[0].connectors!.filter(c => c.id !== "to-b"));
    expect(result.ir.programs[1].connectors).toEqual(draft.ir.programs[1].connectors);
    expect(result.ir.programs[1].defaultAction).toEqual({ kind: "direct" });
  });
  it("appends a managed server after external hops with a collision-safe stable bridge", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs[1].connectors!.push({ id: "path-c", connection: connection("unrelated.example") });
    const hops = [managed("a"), external("a", "x"), external("a", "y"), managed("b"), external("b", "x"), managed("c")];
    const result = compileOrderedServerPath(draft, hops, inventory);
    expect(result.ir.programs[1].connectors).toEqual([
      { id: "x", connection: connection("other.example") },
      { id: "path-c", connection: connection("unrelated.example") },
      { id: "path-c-1", connection: connection("192.0.2.3"), via: "x" },
    ]);
    expect(result.ir.programs[1].defaultAction).toEqual({ kind: "forward", ref: "path-c-1" });
    expect(readOrderedServerPath(result, inventory)).toMatchObject({ editable: true, hops });
    expect(compileOrderedServerPath(result, hops, inventory)).toBe(result);
  });
  it("supports direct programs with unused scoped choices without pretending those connectors are active", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [draft.ir.programs[0]];
    draft.ir.programs[0].defaultAction = { kind: "direct" };
    expect(readOrderedServerPath(draft, inventory)).toMatchObject({ editable: true, hops: [managed("a")] });
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "x"), external("a", "y")], inventory);
    expect(result.ir.programs[0].defaultAction).toEqual({ kind: "forward", ref: "y" });
  });
  it.each([
    [external("a", "x"), managed("a"), managed("b")],
    [managed("a"), managed("b"), external("a", "x")],
    [managed("b"), external("a", "x")],
    [managed("a"), external("a", "x"), external("a", "x"), managed("b")],
    [managed("a"), external("a", "to-b"), managed("b")],
    [managed("a"), external("a", "private-source-node"), managed("b")],
    [managed("a"), managed("a")],
    [managed("a"), { kind: "source", connectorId: "tenant-private" } as unknown as OrderedServerHop],
  ])("refuses cross-program, duplicate, bridge, and non-administrator selections without mutating the draft (%j)", (...hops) => {
    const { draft, inventory } = fixture();
    const before = structuredClone(draft);
    expect(orderedPathChangeReason(draft, hops, inventory)).toBeTruthy();
    expect(() => compileOrderedServerPath(draft, hops, inventory)).toThrow();
    expect(draft).toEqual(before);
  });
  it("does not remove a managed anchor while it still owns saved external connections", () => {
    const { draft, inventory } = fixture();
    expect(orderedPathChangeReason(draft, [managed("a"), external("a", "x")], inventory)).toContain("仍保存连接器");
  });
  it("uses saved listener credentials and resolves wildcard hosts only for the managed bridge", () => {
    const { draft, inventory } = fixture();
    const b = draft.ir.programs[1];
    b.listener.connection = { ...b.listener.connection, host: "0.0.0.0" };
    inventory.endpoints = inventory.endpoints.map(e => e.id === "b" ? { ...e, connection: { ...e.connection, password: "new-inventory-secret" } } : e);
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "spare"), managed("b"), external("b", "x")], inventory);
    expect(result.ir.programs[1].listener.connection.password).toBe("kept-secret");
    expect(result.ir.programs[1].listener.connection.host).toBe("0.0.0.0");
    expect(result.ir.programs[0].connectors!.find(c => c.id === "to-b")?.connection).toEqual(connection("192.0.2.2"));
  });
  it("reads a one-hop legacy path even when inventory does not carry credentials", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [{ ...draft.ir.programs[0], connectors: undefined, defaultAction: { kind: "" } }];
    inventory.endpoints = inventory.endpoints.map(e => ({ ...e, connection: { protocol: "socks", host: "", port: 0 } }));
    expect(readOrderedServerPath(draft, inventory)).toEqual({ editable: true, hops: [managed("a")], connectorChoices: [] });
    expect(compileOrderedServerPath(draft, [managed("a")], inventory)).toBe(draft);
  });
  it("keeps empty and exact managed-only legacy compilation compatible", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [];
    expect(readOrderedServerPath(draft, inventory)).toEqual({ editable: true, hops: [], connectorChoices: [] });
    const result = compileOrderedServerPath(draft, [managed("a"), managed("b")], inventory);
    expect(result.ir.programs[0].egress).toEqual([connection("192.0.2.2")]);
    expect(result.ir.programs[0].connectors).toBeUndefined();
    expect(readOrderedServerPath(result, inventory)).toMatchObject({ editable: true, hops: [managed("a"), managed("b")] });
  });
  it("preserves a legacy segment when activating a connector on a later named program", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs[0] = { ...draft.ir.programs[0], connectors: undefined, defaultAction: undefined, egress: [connection("192.0.2.2")] };
    draft.ir.programs[1].defaultAction = { kind: "direct" };
    const result = compileOrderedServerPath(draft, [managed("a"), managed("b"), external("b", "x")], inventory);
    expect(result.ir.programs[0]).toBe(draft.ir.programs[0]);
    expect(result.ir.programs[1].defaultAction).toEqual({ kind: "forward", ref: "x" });
  });
  it.each([
    ["rules", (p: ServerProgram) => { p.rules = [{ id: "branch", match: { op: "domain", value: "private.example" }, action: { kind: "direct" } }]; }],
    ["principals", (p: ServerProgram) => { p.principals = [{ subjectId: "person", accountId: "account", routeId: "route", credentialVersion: "v1", credential: { uuid: "secret" }, action: { kind: "forward", ref: "x" } }]; }],
    ["unknown action policy", (p: ServerProgram) => { Object.assign(p.defaultAction!, { futurePolicy: "keep" }); }],
    ["missing default", (p: ServerProgram) => { p.defaultAction = undefined; }],
    ["reject default", (p: ServerProgram) => { p.defaultAction = { kind: "reject" }; }],
    ["missing action target", (p: ServerProgram) => { p.defaultAction = { kind: "forward", ref: "absent" }; }],
    ["dual contracts", (p: ServerProgram) => { p.egress = [connection("legacy.example")]; }],
    ["duplicate connector", (p: ServerProgram) => { p.connectors!.push({ ...p.connectors![0] }); }],
    ["missing unused Via", (p: ServerProgram) => { p.connectors![3].via = "absent"; }],
    ["unused cycle", (p: ServerProgram) => { p.connectors![3].via = "spare"; }],
    ["reserved identity", (p: ServerProgram) => { p.connectors![3].id = "rw-direct"; }],
    ["unsupported protocol", (p: ServerProgram) => { p.connectors![3].connection.protocol = "hysteria2"; }],
    ["unknown version", (p: ServerProgram) => { p.instance.version = "future"; }],
    ["ambiguous bridge", (p: ServerProgram) => { p.connectors!.push({ ...p.connectors![1], id: "also-b" }); }],
    ["wrong bridge", (p: ServerProgram) => { p.connectors![1].connection = connection("wrong.example"); }],
    ["malformed collection", (p: ServerProgram) => { p.rules = {} as ServerProgram["rules"]; }],
  ] as const)("keeps %s advanced-only without losing any original data", (_label, mutate) => {
    const { draft, inventory } = fixture();
    mutate(draft.ir.programs[0]);
    const before = structuredClone(draft);
    expect(readOrderedServerPath(draft, inventory).editable).toBe(false);
    expect(() => compileOrderedServerPath(draft, [managed("a"), managed("b")], inventory)).toThrow();
    expect(draft).toEqual(before);
  });
  it.each(["flow", "reality", "transport", "packetEncoding", "trojan"])("refuses managed ingress external %s capability before rewriting", feature => {
    const { draft, inventory } = fixture();
    const a = draft.ir.programs[0];
    a.instance.adapterId = "routeweaver/managed-xray"; a.instance.version = "26.3.27-rw1";
    a.listener.connection = { protocol: "vless", host: "0.0.0.0", port: 443 };
    const c = a.connectors![0].connection;
    if (feature === "flow") c.flow = "xtls-rprx-vision";
    if (feature === "reality") c.tls = { enabled: true, reality: { publicKey: "x", shortId: "ab" } };
    if (feature === "transport") c.transport = { type: "ws" };
    if (feature === "packetEncoding") c.packetEncoding = "xudp";
    if (feature === "trojan") c.protocol = "trojan";
    expect(readOrderedServerPath(draft, inventory).editable).toBe(false);
  });
  it("refuses managed transit both in an existing draft and when choosing a new downstream endpoint", () => {
    const { draft, inventory } = fixture();
    const b = draft.ir.programs[1];
    b.instance.adapterId = "routeweaver/managed-xray"; b.instance.version = "26.3.27-rw1";
    b.listener.connection = { protocol: "vless", host: "0.0.0.0", port: 443 };
    expect(readOrderedServerPath(draft, inventory).editable).toBe(false);
    draft.ir.programs = [draft.ir.programs[0]];
    draft.ir.programs[0].defaultAction = { kind: "direct" };
    expect(orderedPathChangeReason(draft, [managed("a"), managed("b")], inventory)).toContain("只能作为第一跳");
  });
  it("does not bypass managed transit validation when compiling an empty legacy draft", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [];
    inventory.instances[1].adapterId = "routeweaver/managed-xray";
    inventory.instances[1].version = "26.3.27-rw1";
    inventory.endpoints[1].connection = { protocol: "vless", host: "0.0.0.0", port: 443 };
    expect(orderedPathChangeReason(draft, [managed("a"), managed("b")], inventory)).toContain("只能作为第一跳");
  });
  it("does not let the legacy compatibility path discard unknown program data", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [{ ...draft.ir.programs[0], connectors: undefined, defaultAction: undefined }];
    Object.assign(draft.ir.programs[0], { futurePolicy: { target: "unrecognized" } });
    expect(orderedPathChangeReason(draft, [], inventory)).toContain("独立设置");
  });
  it("refuses an unverified core version even for a new one-hop legacy draft", () => {
    const { draft, inventory } = fixture();
    draft.ir.programs = [];
    inventory.instances[0].version = "future";
    expect(orderedPathChangeReason(draft, [managed("a")], inventory)).toContain("核心版本");
  });
  it("accepts the 64-hop backend bound and refuses a 65th hop without truncation", () => {
    const { draft, inventory } = fixture();
    const a = draft.ir.programs[0];
    draft.ir.programs = [a];
    a.connectors = Array.from({ length: 63 }, (_, i) => ({ id: `hop-${i}`, ...(i ? { via: `hop-${i - 1}` } : {}), connection: connection(`external-${i}.example`) }));
    a.defaultAction = { kind: "forward", ref: "hop-62" };
    const path = readOrderedServerPath(draft, inventory);
    expect(path.editable).toBe(true);
    if (!path.editable) throw new Error("Expected editable bound fixture");
    expect(path.hops).toHaveLength(64);
    expect(path.hops.at(-1)).toEqual(external("a", "hop-62"));
    a.connectors.push({ id: "hop-63", via: "hop-62", connection: connection("overflow.example") });
    a.defaultAction.ref = "hop-63";
    expect(readOrderedServerPath(draft, inventory)).toMatchObject({ editable: false, reason: expect.stringContaining("64") });
  });
  it("keeps sing-box physical order identical to Xray without assuming another runtime version", () => {
    const { draft, inventory } = fixture();
    for (const instance of inventory.instances) { instance.adapterId = "routeweaver/sing-box"; instance.version = "1.14.4"; }
    const result = compileOrderedServerPath(draft, [managed("a"), external("a", "y"), external("a", "x"), managed("b"), external("b", "x")], inventory);
    expect(result.ir.programs[0].connectors!.find(c => c.id === "y")?.via).toBeUndefined();
    expect(result.ir.programs[0].connectors!.find(c => c.id === "x")?.via).toBe("y");
    expect(result.ir.programs[0].connectors!.find(c => c.id === "to-b")?.via).toBe("x");
  });
  it("rejects unknown data attached to a requested hop instead of silently dropping it", () => {
    const { draft, inventory } = fixture();
    const hops = [Object.assign(managed("a"), { extraIntent: "keep" }), managed("b")];
    expect(() => compileOrderedServerPath(draft, hops, inventory)).toThrow();
  });
  it("preserves Go null collections and explicit empty Via on an unchanged round-trip", () => {
    const { draft, inventory } = fixture();
    Object.assign(draft.ir.programs[0], { egress: null, rules: null, resources: null });
    draft.ir.programs[0].connectors!.find(c => c.id === "x")!.via = "";
    const path = readOrderedServerPath(draft, inventory);
    if (!path.editable) throw new Error(path.reason);
    expect(compileOrderedServerPath(draft, path.hops, inventory)).toBe(draft);
  });
  it("gives the same connector name distinct stable keys in different programs", () => {
    expect(orderedServerHopKey(external("a", "x"))).toBe("connector:a:x");
    expect(orderedServerHopKey(external("b", "x"))).toBe("connector:b:x");
  });
});

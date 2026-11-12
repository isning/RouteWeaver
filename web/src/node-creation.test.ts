import { expect, it } from "vitest";
import { normalizeConnection } from "./ConnectionFields";
import {
  nodeCreationSnapshot,
  readNodeRecord,
  sameCreatedNode,
} from "./node-creation";
import type { NodeRecord } from "./types";
const base: NodeRecord = {
  id: "node-one",
  name: "Node",
  host: "proxy.example.invalid",
  port: 443,
  protocol: "vless",
  uuid: "00000000-0000-4000-8000-000000000001",
  status: "unregistered",
};
const advanced: NodeRecord = {
  ...base,
  region: "UK",
  tags: ["one", "two"],
  coreId: "core-one",
  coreVersion: "test",
  flow: "",
  packetEncoding: "xudp",
  tls: {
    enabled: true,
    serverName: "tls.example.invalid",
    fingerprint: "chrome",
    alpn: ["h2", "http/1.1"],
    reality: {
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      shortId: "",
    },
  },
  transport: {
    type: "ws",
    path: "/proxy",
    host: "cdn.example.invalid",
    headers: { "X-One": "1", "X-Two": "2" },
  },
};
it("snapshots only persisted Node fields after normalizing protocol, numeric port and transport intent", () => {
  const form = {
    ...base,
    port: "4.43e2",
    status: "online",
    enabled: true,
    quotaGiB: 100,
    password: "not-persisted-for-vless",
    region: "",
    tags: [],
    tls: { enabled: false },
    transport: {
      type: "grpc",
      serviceName: "service",
      authority: "grpc.example.invalid",
      path: "/inactive",
    },
  };
  const normalized = normalizeConnection(
    form as unknown as NodeRecord,
  ) as NodeRecord;
  expect(nodeCreationSnapshot(normalized)).toEqual({
    ...base,
    port: 443,
    region: "",
    tags: [],
    transport: {
      type: "grpc",
      serviceName: "service",
      authority: "grpc.example.invalid",
    },
  });
});
it("compares Go omission equivalents and header maps without depending on object insertion order", () => {
  const expected = {
    ...advanced,
    username: "",
    password: "",
    method: "",
    vmessSecurity: "",
  };
  const reordered = {
    ...advanced,
    flow: undefined,
    transport: {
      host: "cdn.example.invalid",
      path: "/proxy",
      headers: { "X-Two": "2", "X-One": "1" },
      type: "ws",
    },
  };
  expect(sameCreatedNode(expected, reordered)).toBe(true);
  expect(sameCreatedNode({ ...base, region: "", tags: [] }, base)).toBe(true);
  expect(
    sameCreatedNode(
      {
        ...base,
        tls: { enabled: true, serverName: "", alpn: [] },
        transport: { type: "ws", path: "", headers: {} },
      },
      { ...base, tls: { enabled: true }, transport: { type: "ws" } },
    ),
  ).toBe(true);
});
it.each([
  { id: "other" },
  { name: "Later" },
  { host: "other.example.invalid" },
  { port: 444 },
  { protocol: "vmess" },
  { username: "changed" },
  { password: "changed" },
  { method: "changed" },
  { region: "US" },
  { tags: ["two", "one"] },
  { uuid: "00000000-0000-4000-8000-000000000002" },
  { flow: "xtls-rprx-vision" },
  { vmessSecurity: "auto" },
  { packetEncoding: "packetaddr" },
  { coreId: "other" },
  { coreVersion: "new" },
  { status: "other" },
  { tls: undefined },
  { tls: { ...advanced.tls!, enabled: false } },
  { tls: { ...advanced.tls!, serverName: "other.example.invalid" } },
  { tls: { ...advanced.tls!, fingerprint: "firefox" } },
  { tls: { ...advanced.tls!, alpn: ["http/1.1", "h2"] } },
  {
    tls: {
      ...advanced.tls!,
      reality: {
        publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        shortId: "",
      },
    },
  },
  {
    tls: {
      ...advanced.tls!,
      reality: { publicKey: advanced.tls!.reality!.publicKey, shortId: "01" },
    },
  },
  { transport: undefined },
  { transport: { ...advanced.transport!, type: "httpupgrade" } },
  { transport: { ...advanced.transport!, path: "/later" } },
  { transport: { ...advanced.transport!, host: "other.example.invalid" } },
  { transport: { ...advanced.transport!, serviceName: "service" } },
  { transport: { ...advanced.transport!, authority: "other.example.invalid" } },
  {
    transport: {
      ...advanced.transport!,
      headers: { "X-One": "changed", "X-Two": "2" },
    },
  },
] as Partial<NodeRecord>[])(
  "compares every persisted connection field instead of stripping difference %j",
  (change) => {
    expect(sameCreatedNode(advanced, { ...advanced, ...change })).toBe(false);
  },
);
it.each([
  null,
  [],
  {},
  { ...base, id: "bad/id" },
  { ...base, name: " " },
  { ...base, protocol: "unknown" },
  { ...base, port: NaN },
  { ...base, coreId: 1 },
  { ...base, tags: null },
  { ...base, tls: null },
  { ...base, tls: { enabled: true, alpn: [1] } },
  { ...base, tls: { enabled: true, reality: { publicKey: "key" } } },
  { ...base, tls: { enabled: true, unexpected: "not-ignored" } },
  { ...base, transport: { type: "unknown" } },
  { ...base, transport: { type: "ws", headers: [] } },
  { ...base, transport: { type: "ws", headerRows: [] } },
  { ...base, $schema: {} },
  { ...base, futureField: "not-ignored" },
])("rejects malformed or unknown persisted fields %j", (value) => {
  expect(readNodeRecord(value)).toBeNull();
});
it("holds independent nested snapshots and does not mutate caller connection input", () => {
  const original = structuredClone(advanced),
    snapshot = nodeCreationSnapshot(original);
  original.tags!.push("later");
  original.tls!.alpn!.reverse();
  original.transport!.headers!["X-One"] = "later";
  expect(snapshot.tags).toEqual(["one", "two"]);
  expect(snapshot.tls!.alpn).toEqual(["h2", "http/1.1"]);
  expect(snapshot.transport!.headers!["X-One"]).toBe("1");
});

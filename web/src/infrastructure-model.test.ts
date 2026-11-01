import { describe, it, expect } from "vitest";
import {
  isUnchangedEndpointDraft,
  compilePath,
  phaseLabel,
  normalizeDeployment,
} from "./infrastructure-model";
import type {
  CoreInstance,
  ManagedEndpoint,
  Infrastructure,
  ServerDeployment,
} from "./types";
const inventory: Infrastructure = {
  hosts: [
    { id: "fra", name: "FRA", address: "fra.example.com" },
    { id: "uk", name: "UK", address: "uk.example.com" },
  ],
  instances: [
    {
      id: "f-core",
      hostId: "fra",
      adapterId: "routeweaver/sing-box",
      version: "1.14.3",
    },
    {
      id: "u-core",
      hostId: "uk",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    },
  ],
  endpoints: [
    {
      id: "entry",
      instanceId: "f-core",
      name: "入口",
      connection: {
        host: "0.0.0.0",
        port: 1080,
        protocol: "socks",
        username: "test",
        password: "test",
      },
    },
    {
      id: "exit",
      instanceId: "u-core",
      name: "出口",
      connection: {
        host: "0.0.0.0",
        port: 1081,
        protocol: "socks",
        username: "test2",
        password: "test2",
      },
    },
  ],
  links: [],
  deployments: [],
};
const draft: ServerDeployment = {
  id: "route",
  name: "FRA → UK",
  status: "draft",
  diagnostics: [],
  ir: {
    schemaVersion: "1.0",
    id: "route",
    topologyRevision: "1",
    programs: [],
  },
};
describe("administrator server path intent", () => {
  it("builds separate instance programs and connects to the actual host, never a wildcard bind address", () => {
    const result = compilePath(draft, ["entry", "exit"], inventory);
    expect(result.ir.programs).toHaveLength(2);
    expect(result.ir.programs[0].listener.connection.host).toBe("0.0.0.0");
    expect(result.ir.programs[0].egress[0].host).toBe("uk.example.com");
    expect(result.ir.programs[1].egress).toEqual([]);
    expect(inventory.endpoints[1].connection.host).toBe("0.0.0.0");
  });
  it("allows a one-endpoint direct server route", () =>
    expect(
      compilePath(draft, ["exit"], inventory).ir.programs[0].egress,
    ).toEqual([]));
  it("rejects endpoint cycles without changing a draft", () => {
    expect(() =>
      compilePath(draft, ["entry", "exit", "entry"], inventory),
    ).toThrow("同一端点");
    expect(draft.ir.programs).toHaveLength(0);
  });
  it("does not call queued configuration applied", () => {
    expect(phaseLabel("queued")).toBe("等待实例接收");
    expect(phaseLabel("observed_conformant")).toBe("已确认生效");
  });
});
it("refuses ordered rewriting of per-user principals without restoring or changing any credential", () => {
  const current = compilePath(draft, ["entry"], inventory);
  (current.ir.programs[0] as any).principals = [
    {
      subjectId: "s",
      accountId: "u",
      routeId: "public",
      credentialVersion: "v1",
      credential: { uuid: "fixture" },
      action: { kind: "direct" },
    },
  ];
  const before = JSON.stringify(current);
  expect(() => compilePath(current, ["entry"], inventory)).toThrow(/转发设置/);
  expect(JSON.stringify(current)).toBe(before);
  expect(inventory.endpoints[0].connection.password).toBe("test");
});

it("accepts Go null slice fields without dropping existing managed destination policy", () => {
  const current = compilePath(draft, ["entry"], inventory);
  const program = current.ir.programs[0];
  program.destinationPolicy = { allowCidrs: ["10.20.0.0/16"] };
  const loaded = normalizeDeployment({
    ...current,
    ir: {
      ...current.ir,
      programs: [
        { ...program, egress: null, rules: null, resources: null } as any,
      ],
    },
  });
  expect(loaded.ir.programs[0].egress).toEqual([]);
  expect(
    compilePath(loaded, ["entry"], inventory).ir.programs[0].destinationPolicy,
  ).toEqual(program.destinationPolicy);
});

describe("existing unsupported endpoint metadata allowance", () => {
  const instance: CoreInstance = {
    id: "managed",
    hostId: "host",
    adapterId: "routeweaver/managed-xray",
    version: "26.3.27-rw1",
  };
  const endpoint: ManagedEndpoint = {
    id: "legacy",
    name: "Legacy",
    instanceId: instance.id,
    connection: {
      protocol: "socks",
      host: "0.0.0.0",
      port: 1080,
      username: "existing",
      password: "secret",
    },
  };
  const original = { endpoint, instance };
  it("allows only metadata and ignores object insertion order, not values", () => {
    const reordered = Object.fromEntries(
      Object.entries(endpoint.connection).reverse(),
    ) as typeof endpoint.connection;
    expect(
      isUnchangedEndpointDraft(
        original,
        { ...endpoint, name: "Renamed", connection: reordered },
        instance,
      ),
    ).toBe(true);
  });
  it.each([
    { ...endpoint, authentication: "principals" },
    { ...endpoint, instanceId: "other" },
    { ...endpoint, connection: { ...endpoint.connection, port: 1081 } },
    {
      ...endpoint,
      connection: { ...endpoint.connection, password: "changed" },
    },
    {
      ...endpoint,
      connection: { ...endpoint.connection, transport: { type: "ws" } },
    },
  ])("rejects changed connection, authentication or instance %#", (draft) => {
    expect(isUnchangedEndpointDraft(original, draft, instance)).toBe(false);
  });
  it.each([
    { ...instance, adapterId: "routeweaver/xray" },
    { ...instance, version: "future" },
    { ...instance, hostId: "different-host" },
    undefined,
  ])("rejects changed or missing core target %#", (target) => {
    expect(isUnchangedEndpointDraft(original, endpoint, target)).toBe(false);
  });
});

it("keeps endpoint review metadata out of compiled and normalized server intent", () => {
  const endpoints = inventory.endpoints.map((endpoint) => ({
    ...endpoint,
    revisionToken: "inventory-review-only",
  }));
  const result = compilePath(draft, ["entry", "exit"], {
    ...inventory,
    endpoints,
  });
  expect(
    result.ir.programs.every(
      (program) => !("revisionToken" in program.listener),
    ),
  ).toBe(true);
  result.ir.programs[0].listener.revisionToken = "inventory-review-only";
  expect(
    normalizeDeployment(result).ir.programs[0].listener.revisionToken,
  ).toBeUndefined();
  expect(endpoints[0].revisionToken).toBe("inventory-review-only");
});

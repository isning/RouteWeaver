import { expect, it } from "vitest";
import { compilePath } from "./infrastructure-model";
import type { Infrastructure, ServerDeployment } from "./types";
const inventory: Infrastructure = {
  hosts: [
    { id: "fra", name: "FRA", address: "fra.example.invalid" },
    { id: "uk", name: "UK", address: "uk.example.invalid" },
  ],
  instances: ["fra", "uk"].map((id) => ({
    id: `${id}-core`,
    hostId: id,
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  })),
  endpoints: ["fra", "uk"].map((id) => ({
    id: `${id}-listener`,
    name: id,
    instanceId: `${id}-core`,
    connection: {
      protocol: "socks",
      host: "0.0.0.0",
      port: 1080,
      username: "fixture",
      password: "synthetic",
    },
  })),
  deployments: [],
  links: [],
};
const empty: ServerDeployment = {
  id: "path",
  name: "Path",
  status: "draft",
  diagnostics: [],
  ir: { schemaVersion: "1.0", id: "path", topologyRevision: "1", programs: [] },
};
it("refuses to reinterpret a conditional server policy as array-ordered hops, preserving its rules and default", () => {
  const branch: ServerDeployment = {
    ...empty,
    ir: {
      ...empty.ir,
      programs: inventory.instances.map((instance, i) => ({
        instance,
        listener: inventory.endpoints[i],
        egress: [],
        resources: [],
        rules:
          i === 0
            ? [
                {
                  id: "chatgpt",
                  match: { op: "domain-suffix", value: "chatgpt.com" },
                  action: { kind: "forward", ref: "uk-connector" },
                },
              ]
            : [],
        connectors:
          i === 0
            ? [
                {
                  id: "uk-connector",
                  connection: {
                    ...inventory.endpoints[1].connection,
                    host: "uk.example.invalid",
                  },
                },
              ]
            : [],
        defaultAction: { kind: "direct" },
      })),
    },
  };
  const before = JSON.stringify(branch);
  expect(() =>
    compilePath(branch, ["uk-listener", "fra-listener"], inventory),
  ).toThrow(/转发设置/);
  expect(JSON.stringify(branch)).toBe(before);
});

it("reverses a proven legacy chain by changing forwarding, not just array order, and preserves endpoint-scoped settings", () => {
  const original = compilePath(
    empty,
    ["fra-listener", "uk-listener"],
    inventory,
  );
  original.ir.programs[0].tls = {
    certificatePath: "fra.crt",
    keyPath: "fra.key",
  };
  original.ir.programs[0].destinationPolicy = { allowCidrs: ["192.0.2.0/24"] };
  const before = JSON.stringify(original);
  const result = compilePath(
    original,
    ["uk-listener", "fra-listener"],
    inventory,
  );
  expect(result.ir.programs.map((program) => program.listener.id)).toEqual([
    "uk-listener",
    "fra-listener",
  ]);
  expect(result.ir.programs[0].egress).toEqual([
    {
      protocol: "socks",
      host: "fra.example.invalid",
      port: 1080,
      username: "fixture",
      password: "synthetic",
    },
  ]);
  expect(result.ir.programs[1].egress).toEqual([]);
  expect(result.ir.programs[1].tls).toEqual({
    certificatePath: "fra.crt",
    keyPath: "fra.key",
  });
  expect(result.ir.programs[1].destinationPolicy).toEqual({
    allowCidrs: ["192.0.2.0/24"],
  });
  expect(JSON.stringify(original)).toBe(before);
});

it("allows a Go zero action round trip but rejects every explicit independent policy", () => {
  const original = compilePath(
    empty,
    ["fra-listener", "uk-listener"],
    inventory,
  );
  original.ir.programs.forEach((program) => {
    program.defaultAction = { kind: "" };
  });
  expect(
    compilePath(original, ["uk-listener", "fra-listener"], inventory).ir
      .programs[0].egress[0].host,
  ).toBe("fra.example.invalid");
  for (const patch of [
    { defaultAction: { kind: "direct" } },
    { defaultAction: { kind: "reject" } },
    { defaultAction: { kind: "", ref: "hidden" } },
    {
      connectors: [
        { id: "out", connection: inventory.endpoints[1].connection },
      ],
    },
    {
      rules: [
        {
          id: "rule",
          match: { op: "domain-suffix", value: "chatgpt.com" },
          action: { kind: "direct" },
        },
      ],
    },
    { resources: [{ id: "resource" }] },
    { principals: [{ accountId: "user", action: { kind: "direct" } }] },
  ]) {
    const draft = structuredClone(original);
    Object.assign(draft.ir.programs[0], patch);
    const before = JSON.stringify(draft);
    expect(() =>
      compilePath(draft, ["uk-listener", "fra-listener"], inventory),
    ).toThrow(/转发设置/);
    expect(JSON.stringify(draft)).toBe(before);
  }
});

it("refuses unproven connections and stale ownership rather than silently reconnecting them", () => {
  const original = compilePath(
    empty,
    ["fra-listener", "uk-listener"],
    inventory,
  );
  for (const patch of [
    { host: "different.example.invalid" },
    { port: 1081 },
    { protocol: "vless" },
    { username: "different" },
    { password: "different" },
    { tls: { enabled: true, serverName: "different.example.invalid" } },
    { transport: { type: "ws", path: "/different" } },
  ]) {
    const draft = structuredClone(original);
    Object.assign(draft.ir.programs[0].egress[0], patch);
    expect(() =>
      compilePath(draft, ["uk-listener", "fra-listener"], inventory),
    ).toThrow(/转发设置/);
  }
  const extra = structuredClone(original);
  extra.ir.programs[0].egress.push({ ...extra.ir.programs[0].egress[0] });
  expect(() =>
    compilePath(extra, ["uk-listener", "fra-listener"], inventory),
  ).toThrow(/转发设置/);
  for (const alteredInventory of [
    { ...inventory, hosts: inventory.hosts.slice(0, 1) },
    { ...inventory, endpoints: inventory.endpoints.slice(0, 1) },
    {
      ...inventory,
      endpoints: inventory.endpoints.map((endpoint) => ({
        ...endpoint,
        instanceId: "wrong",
      })),
    },
    {
      ...inventory,
      instances: inventory.instances.map((instance) => ({
        ...instance,
        hostId: "wrong",
      })),
    },
  ])
    expect(() =>
      compilePath(original, ["uk-listener", "fra-listener"], alteredInventory),
    ).toThrow(/转发设置/);
  const schema = structuredClone(original);
  schema.ir.schemaVersion = "2.0";
  expect(() =>
    compilePath(schema, ["uk-listener", "fra-listener"], inventory),
  ).toThrow(/转发设置/);
});

it("preserves retained revealed listener snapshots when catalog connections drift, and resolves only explicit replacements from inventory", () => {
  const original = compilePath(
    empty,
    ["fra-listener", "uk-listener"],
    inventory,
  );
  const drifted = structuredClone(inventory);
  drifted.endpoints[0].connection = {
    protocol: "socks",
    host: "changed.example.invalid",
    port: 2080,
    username: "changed-fixture",
    password: "changed-synthetic",
    tls: { enabled: true, serverName: "changed.example.invalid" },
  };
  const before = JSON.stringify(original);
  const reordered = compilePath(
    original,
    ["uk-listener", "fra-listener"],
    drifted,
  );
  expect(reordered.ir.programs[1].listener).toEqual(
    original.ir.programs[0].listener,
  );
  expect(reordered.ir.programs[0].egress).toEqual([
    {
      ...original.ir.programs[0].listener.connection,
      host: "fra.example.invalid",
    },
  ]);
  expect(JSON.stringify(original)).toBe(before);
  drifted.endpoints.push({
    ...drifted.endpoints[0],
    id: "fra-replacement",
    name: "Replacement",
  });
  const replaced = compilePath(
    original,
    ["fra-replacement", "uk-listener"],
    drifted,
  );
  expect(replaced.ir.programs[0].listener).toEqual(drifted.endpoints[2]);
  expect(replaced.ir.programs[1].listener).toEqual(
    original.ir.programs[1].listener,
  );
});

it("uses the registered address only for wildcard binds and refuses a changed existing chain destination", () => {
  const original = compilePath(
    empty,
    ["fra-listener", "uk-listener"],
    inventory,
  );
  const driftedHost = structuredClone(inventory);
  driftedHost.hosts[1].address = "new-uk.example.invalid";
  expect(() =>
    compilePath(original, ["uk-listener", "fra-listener"], driftedHost),
  ).toThrow(/转发设置/);
  const one = compilePath(empty, ["fra-listener"], inventory);
  const result = compilePath(one, ["uk-listener", "fra-listener"], inventory);
  expect(result.ir.programs[0].egress[0].host).toBe("fra.example.invalid");
  expect(result.ir.programs[1].listener.connection.host).toBe("0.0.0.0");
  const explicit = structuredClone(inventory);
  explicit.endpoints[0].connection.host = "explicit-fra.example.invalid";
  const direct = compilePath(empty, ["fra-listener"], explicit);
  expect(
    compilePath(direct, ["uk-listener", "fra-listener"], inventory).ir
      .programs[0].egress[0].host,
  ).toBe("explicit-fra.example.invalid");
});

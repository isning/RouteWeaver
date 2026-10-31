import { expect, it } from "vitest";
import type { Infrastructure, ServerDeployment } from "./types";
import { compilePath } from "./infrastructure-model";
import { planListenerRefresh, sameSnapshot } from "./server-listener-refresh";

function fixture() {
  const inventory: Infrastructure = {
    hosts: ["fra", "uk"].map((id) => ({
      id,
      name: id,
      address: `${id}.example.invalid`,
    })),
    instances: ["fra", "uk"].map((id) => ({
      id: `${id}-core`,
      hostId: id,
      name: `${id} core`,
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    })),
    endpoints: ["fra", "uk"].map((id) => ({
      id: `${id}-listener`,
      instanceId: `${id}-core`,
      name: id,
      connection: {
        protocol: "socks",
        host: "0.0.0.0",
        port: 1080,
        username: "fixture-user",
        password: "fixture-password",
      },
    })),
    deployments: [],
    links: [],
  };
  const empty: ServerDeployment = {
    id: "draft",
    name: "Draft",
    diagnostics: [],
    status: "draft",
    ir: {
      id: "draft",
      schemaVersion: "1.0",
      topologyRevision: "fixture-1",
      programs: [],
    },
  };
  const draft = compilePath(empty, ["fra-listener", "uk-listener"], inventory);
  const current = structuredClone(inventory.endpoints[1]);
  current.connection.port = 2080;
  current.connection.password = "changed-fixture-password";
  return { inventory, draft, current };
}

it("refreshes only the chosen listener and the exact proven legacy predecessor, retaining all non-path intent", () => {
  const { inventory, draft, current } = fixture();
  draft.ir.programs[1].tls = {
    certificatePath: "fixture.crt",
    keyPath: "fixture.key",
  };
  draft.ir.programs[1].destinationPolicy = { allowCidrs: ["192.0.2.0/24"] };
  Object.assign(draft.ir.programs[1], { futureOpaque: { retain: true } });
  const before = structuredClone(draft);
  const plan = planListenerRefresh(draft, inventory, current.id, current);
  expect(plan.status).toBe("ready");
  expect(plan.incoming?.before).toBe("uk.example.invalid:1080");
  expect(plan.incoming?.after).toBe("uk.example.invalid:2080");
  expect(sameSnapshot(plan.next?.ir.programs[1].listener, current)).toBe(true);
  expect(
    plan.next?.ir.programs[0].egress[0].password ===
      current.connection.password,
  ).toBe(true);
  expect(
    sameSnapshot(
      {
        ...plan.next!.ir.programs[1],
        listener: before.ir.programs[1].listener,
      },
      before.ir.programs[1],
    ),
  ).toBe(true);
  expect(sameSnapshot(draft, before)).toBe(true);
  expect(JSON.stringify(plan.changes).includes("fixture-password")).toBe(false);
});

it("does not rewrite independent connectors, defaults, rules, principals or resources", () => {
  const { inventory, draft, current } = fixture();
  const program = draft.ir.programs[0];
  program.connectors = [{ id: "uk-out", connection: { ...program.egress[0] } }];
  program.egress = [];
  program.defaultAction = { kind: "direct" };
  program.rules = [
    {
      id: "chatgpt",
      match: { op: "domain-suffix", value: "chatgpt.com" },
      action: { kind: "forward", ref: "uk-out" },
    },
  ];
  program.principals = [
    {
      subjectId: "fixture-subject",
      accountId: "fixture-account",
      routeId: "fixture-route",
      credentialVersion: "1",
      credential: { uuid: "00000000-0000-4000-8000-000000000000" },
      action: { kind: "forward", ref: "uk-out" },
    },
  ];
  program.resources = [
    {
      id: "fixture-resource",
      revision: "1",
      digest: "fixture-digest",
      format: "domain",
      location: "inline",
      updatePolicy: "manual",
    },
  ];
  const selected = draft.ir.programs[1];
  selected.defaultAction = { kind: "reject" };
  selected.tls = { certificatePath: "fixture.crt", keyPath: "fixture.key" };
  selected.destinationPolicy = { allowCidrs: ["192.0.2.0/24"] };
  Object.assign(selected, { futureOpaque: { retain: true } });
  const before = structuredClone(draft);
  const plan = planListenerRefresh(draft, inventory, current.id, current);
  expect(
    sameSnapshot(
      {
        ...plan.next!.ir.programs[1],
        listener: before.ir.programs[1].listener,
      },
      before.ir.programs[1],
    ),
  ).toBe(true);
  expect(plan.independent).toBe(true);
  expect(plan.incoming).toBeUndefined();
  expect(sameSnapshot(plan.next?.ir.programs[0], before.ir.programs[0])).toBe(
    true,
  );
  expect(sameSnapshot(draft, before)).toBe(true);
});

it("blocks instance name/runtime/owner, protocol and authentication-model migration without changing any snapshot", () => {
  const { inventory, draft, current } = fixture();
  const before = structuredClone(draft);
  for (const patch of [
    { name: "Renamed" },
    { hostId: "fra" },
    { adapterId: "routeweaver/sing-box" },
    { version: "other" },
  ]) {
    const changed = structuredClone(inventory);
    Object.assign(changed.instances[1], patch);
    expect(
      planListenerRefresh(draft, changed, current.id, current).status,
    ).toBe("blocked");
  }
  for (const next of [
    { ...current, instanceId: "fra-core" },
    { ...current, authentication: "principals" },
    { ...current, connection: { ...current.connection, protocol: "vless" } },
  ])
    expect(planListenerRefresh(draft, inventory, current.id, next).status).toBe(
      "blocked",
    );
  expect(sameSnapshot(draft, before)).toBe(true);
  expect(
    planListenerRefresh(draft, inventory, current.id, inventory.endpoints[1])
      .status,
  ).toBe("unchanged");
});

it("never infers a legacy dependency after the registered wildcard destination changes", () => {
  const { inventory, draft, current } = fixture();
  const changed = structuredClone(inventory);
  changed.hosts[1].address = "different.example.invalid";
  const plan = planListenerRefresh(draft, changed, current.id, current);
  expect(plan.independent).toBe(true);
  expect(plan.incoming).toBeUndefined();
  expect(sameSnapshot(plan.next?.ir.programs[0], draft.ir.programs[0])).toBe(
    true,
  );
});

it("reports private connection changes as categories without presenting their values", () => {
  const { inventory, draft, current } = fixture();
  current.connection.tls = {
    enabled: true,
    serverName: "tls-fixture.example.invalid",
  };
  current.connection.transport = { type: "ws", path: "/fixture-private-path" };
  const plan = planListenerRefresh(draft, inventory, current.id, current);
  expect(plan.changes.map((change) => change.label)).toContain(
    "TLS 连接设置已变更",
  );
  expect(plan.changes.map((change) => change.label)).toContain(
    "传输设置已变更",
  );
  expect(JSON.stringify(plan.changes).includes("tls-fixture")).toBe(false);
  expect(JSON.stringify(plan.changes).includes("fixture-private-path")).toBe(
    false,
  );
  expect(
    sameSnapshot(
      plan.next!.ir.programs[1].listener.connection.tls,
      current.connection.tls,
    ),
  ).toBe(true);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { Button } from "@/components/ui/button";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PolicySummary, usePolicyChange } from "./AccessPolicy";
import type {
  EffectivePolicy,
  NamedRecord,
  PolicyChange,
} from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const oldService = {
  id: "plan-a",
  name: "旧方案",
  quotaBytes: 53687091200,
  routeIds: ["r1"],
  cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
};
const nextService = { ...oldService, name: "新方案", quotaBytes: 107374182400 };
const before: EffectivePolicy = {
  userId: "u1",
  serviceId: "plan-a",
  service: oldService,
  groupIds: [],
  routeIds: ["r1"],
  quotaBytes: 53687091200,
  onlineIpLimit: 2,
  connectionLimit: 8,
  entryRateBps: 125000,
  status: "active",
  provenance: {
    service: "individual",
    quotaBytes: "service:plan-a",
    onlineIpLimit: "individual",
    connectionLimit: "individual",
    entryRateBps: "individual",
    routes: "service:plan-a+direct",
  },
  entitlement: {
    userId: "u1",
    startsAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-12-01T00:00:00Z",
    cycle: {
      mode: "monthly",
      day: 1,
      anchor: "2026-01-01T00:00:00Z",
      timezone: "UTC+8",
    },
  },
};
const after: EffectivePolicy = {
  ...before,
  service: nextService,
  quotaBytes: 107374182400,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  provenance: {
    ...before.provenance,
    onlineIpLimit: "service:plan-a",
    connectionLimit: "service:plan-a",
    entryRateBps: "service:plan-a",
  },
};
const effect = { userId: "u1", before, after };
const consent = "我已核对本次授权变更";

beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(owner: Owner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrap = (value: ReactNode) => (
    <QueryClientProvider client={client}>
      
        <UIProviders>{value}</UIProviders>
      
    </QueryClientProvider>
  );
  const result = render(wrap(children));
  return {
    rerender: (value: ReactNode) => {
      owner.assertActive();
      result.rerender(wrap(value));
    },
  };
}
function Caller({
  users = [{ id: "u1", name: "Alice" }],
  services = [],
  change = { service: nextService },
}: {
  users?: NamedRecord[];
  services?: NamedRecord[];
  change?: PolicyChange;
}) {
  const policy = usePolicyChange({
    mode: "legacy-replacement",
    users,
    services,
    routes: [{ id: "r1", name: "东京线路" }],
    onApplied: () => {},
  });
  return (
    <>
      <Button onClick={() => policy.propose(change)}>预览影响</Button>
      {policy.dialog}
    </>
  );
}
async function review(owner: Owner) {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const dialog = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  return within(dialog);
}
function fieldRow(table: HTMLElement, label: string) {
  return within(
    within(table).getByRole("rowheader", { name: label }).closest("tr")!,
  );
}
function expectCellAssociation(
  table: HTMLElement,
  field: string,
  column: string,
  value: string,
) {
  const row = fieldRow(table, field);
  const fieldHeader = row.getByRole("rowheader", { name: field });
  const columnHeader = within(table).getByRole("columnheader", {
    name: column,
  });
  const cell = row
    .getAllByRole("cell")
    .find((candidate) =>
      candidate.getAttribute("headers")?.split(/\s+/).includes(columnHeader.id),
    );
  expect(cell).toBeTruthy();
  expect(row.getAllByRole("cell", { name: value })).toContain(cell);
  const headers = cell!.getAttribute("headers")?.split(/\s+/);
  expect(headers).toContain(fieldHeader.id);
  expect(headers).toContain(columnHeader.id);
}

it("pairs each changed field under one label and associates both values with the field, column, and reviewed user", async () => {
  const owner = currentOwner;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ revision: "paired", affected: [effect], blockers: [] }),
    ),
  );
  mount(owner, <Caller />);
  const dialog = await review(owner);
  owner.assertActive();
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(dialog.getByRole("heading", { name: "Alice" })).toBeTruthy();
  expect(
    within(table).getAllByRole("rowheader", { name: "周期额度" }),
  ).toHaveLength(1);
  expectCellAssociation(table, "周期额度", "变更前", "50 GiB 方案：旧方案");
  expectCellAssociation(table, "周期额度", "变更后", "100 GiB 方案：新方案");
  expectCellAssociation(table, "在线 IP 上限", "变更前", "2 个 个人覆盖");
  expectCellAssociation(table, "在线 IP 上限", "变更后", "不限制 方案：新方案");
  expectCellAssociation(table, "并发逻辑流上限", "变更前", "8 条 个人覆盖");
  expectCellAssociation(table, "每个逻辑入口速率", "变更前", "1 Mbps 个人覆盖");
  expect(within(table).queryByRole("rowheader", { name: "状态" })).toBeNull();
  expect(within(table).queryByText("方案：plan-a")).toBeNull();
  expect(
    (dialog.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("keeps full-view status, routes, validity, calendar and all zero-limit values in the same paired comparison", async () => {
  const owner = currentOwner;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ revision: "full", affected: [effect], blockers: [] }),
    ),
  );
  mount(owner, <Caller />);
  const dialog = await review(owner);
  owner.assertActive();
  await owner.click(() =>
    dialog.getByRole("checkbox", { name: "显示完整授权" }),
  );
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(within(table).getAllByRole("rowheader")).toHaveLength(10);
  expectCellAssociation(table, "状态", "变更前", "平台授权有效");
  expectCellAssociation(table, "状态", "变更后", "平台授权有效");
  expectCellAssociation(
    table,
    "授权线路",
    "变更前",
    "东京线路 方案：旧方案 + 直接授权",
  );
  expectCellAssociation(
    table,
    "授权线路",
    "变更后",
    "东京线路 方案：新方案 + 直接授权",
  );
  expectCellAssociation(
    table,
    "开通 / 到期",
    "变更前",
    "2026/01/01 08:00 / 2026/12/01 08:00",
  );
  expectCellAssociation(
    table,
    "账号周期",
    "变更后",
    "每月 1 日 起点 2026/01/01 08:00 时区 UTC+8",
  );
  expectCellAssociation(
    table,
    "每个逻辑入口速率",
    "变更后",
    "不限制 方案：新方案",
  );
  expect(
    dialog.getAllByText("切换方案或续期后，保留已有用量。"),
  ).toHaveLength(1);
});

it("includes changed status, validity and calendar without requiring full authorization", async () => {
  const owner = currentOwner;
  const changed = {
    ...before,
    status: "paused",
    entitlement: {
      ...before.entitlement,
      expiresAt: undefined,
      cycle: { ...before.entitlement.cycle, mode: "fixed-days", days: 7 },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        revision: "time-and-status",
        affected: [{ userId: "u1", before, after: changed }],
        blockers: [],
      }),
    ),
  );
  mount(owner, <Caller />);
  const dialog = await review(owner);
  owner.assertActive();
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(within(table).getAllByRole("rowheader")).toHaveLength(3);
  expectCellAssociation(table, "状态", "变更后", "平台服务已暂停");
  expectCellAssociation(
    table,
    "开通 / 到期",
    "变更后",
    "2026/01/01 08:00 / 不过期",
  );
  expectCellAssociation(
    table,
    "账号周期",
    "变更后",
    "每 7 天 起点 2026/01/01 08:00 时区 UTC+8",
  );
});

it("retains an authoritative user with no projected field changes and permits the same full review", async () => {
  const owner = currentOwner;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        revision: "unchanged-projection",
        affected: [
          { userId: "u1", before, after: { ...before, groupIds: ["g1"] } },
        ],
        blockers: [],
      }),
    ),
  );
  mount(owner, <Caller />);
  const dialog = await review(owner);
  owner.assertActive();
  expect(dialog.getByText("涉及 1 位用户。")).toBeTruthy();
  expect(dialog.getByRole("heading", { name: "Alice" })).toBeTruthy();
  expect(dialog.getAllByText("当前生效授权保持不变")).toHaveLength(1);
  expect(dialog.queryByRole("table")).toBeNull();
  await owner.click(() =>
    dialog.getByRole("checkbox", { name: "显示完整授权" }),
  );
  expect(
    within(dialog.getByRole("table", { name: "Alice" })).getAllByRole(
      "rowheader",
    ),
  ).toHaveLength(10);
});

it("keeps five users per page and retains a failed review, but resets a different proposal even when its revision is equal", async () => {
  const owner = currentOwner;
  const users = Array.from({ length: 6 }, (_, index) => ({
    id: `u${index + 1}`,
    name: `User ${index + 1}`,
  }));
  const affected = users.map(({ id }) => ({
    userId: id,
    before: {
      ...before,
      userId: id,
      entitlement: { ...before.entitlement, userId: id },
    },
    after: {
      ...after,
      userId: id,
      entitlement: { ...after.entitlement, userId: id },
    },
  }));
  const proposed: PolicyChange[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/apply"))
        return json(
          { detail: "Policy was not saved; review is retained." },
          503,
        );
      const change = JSON.parse(init!.body as string) as PolicyChange;
      proposed.push(change);
      return json({
        revision: "same-server-revision",
        affected: affected.map((effect) => ({
          ...effect,
          after: { ...effect.after, service: change.service },
        })),
        blockers: [],
      });
    }),
  );
  const mounted = mount(owner, <Caller users={users} />);
  let dialog = await review(owner);
  owner.assertActive();
  expect(dialog.getAllByRole("table")).toHaveLength(5);
  expect(dialog.queryByRole("heading", { name: "User 6" })).toBeNull();
  await owner.click(() => dialog.getByRole("button", { name: "下一页" }));
  expect(dialog.getAllByRole("table")).toHaveLength(1);
  expect(dialog.getByRole("table", { name: "User 6" })).toBeTruthy();
  await owner.click(() =>
    dialog.getByRole("checkbox", { name: "显示完整授权" }),
  );
  expect(
    within(dialog.getByRole("table", { name: "User 6" })).getAllByRole(
      "rowheader",
    ),
  ).toHaveLength(10);
  await owner.click(() => dialog.getByRole("button", { name: "上一页" }));
  expect(
    within(dialog.getByRole("table", { name: "User 1" })).getAllByRole(
      "rowheader",
    ),
  ).toHaveLength(10);
  await owner.click(() => dialog.getByRole("button", { name: "下一页" }));
  await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
  await owner.click(() => dialog.getByRole("button", { name: "更新授权" }));
  await dialog.findByText("Policy was not saved; review is retained.");
  owner.assertActive();
  expect(dialog.getAllByRole("table")).toHaveLength(1);
  expect(
    within(dialog.getByRole("table", { name: "User 6" })).getAllByRole(
      "rowheader",
    ),
  ).toHaveLength(10);
  await owner.click(() => dialog.getByRole("button", { name: "返回编辑" }));
  mounted.rerender(
    <Caller
      users={users}
      change={{ service: { ...nextService, name: "另一份草稿" } }}
    />,
  );
  dialog = await review(owner);
  owner.assertActive();
  expect(dialog.getAllByRole("table")).toHaveLength(5);
  expect(dialog.getByRole("table", { name: "User 1" })).toBeTruthy();
  expect(dialog.getByText("服务方案：另一份草稿")).toBeTruthy();
  expect(proposed.map((change) => change.service?.name)).toEqual([
    "新方案",
    "另一份草稿",
  ]);
  expect(
    dialog.getByRole("checkbox", { name: "显示完整授权" }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    dialog.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
});

it("keeps the fixed five-user page size above fifty affected users without offering a size selector", async () => {
  const owner = currentOwner;
  const users = Array.from({ length: 51 }, (_, index) => ({
    id: `large-${index + 1}`,
    name: `User ${index + 1}`,
  }));
  const affected = users.map(({ id }) => ({
    userId: id,
    before: {
      ...before,
      userId: id,
      entitlement: { ...before.entitlement, userId: id },
    },
    after: {
      ...after,
      userId: id,
      entitlement: { ...after.entitlement, userId: id },
    },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ revision: "large-review", affected, blockers: [] }),
    ),
  );
  mount(owner, <Caller users={users} />);
  const dialog = await review(owner);
  owner.assertActive();
  expect(dialog.getByText("涉及 51 位用户。")).toBeTruthy();
  expect(dialog.getAllByRole("table")).toHaveLength(5);
  expect(dialog.queryByRole("combobox")).toBeNull();
  for (let page = 1; page < 11; page++) await owner.click(() => dialog.getByRole("button", { name: "下一页" }));
  expect(dialog.getAllByRole("table")).toHaveLength(1);
  expect(dialog.getByRole("table", { name: "User 51" })).toBeTruthy();
  expect(dialog.queryByRole("combobox")).toBeNull();
});

it("retains blocked paired values without a completeness claim or an apply request through consent", async () => {
  const owner = currentOwner;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      writes.push(String(url));
      return json({
        revision: "blocked-pairs",
        affected: [effect],
        blockers: ["Stop active presences", "Keep this independent blocker"],
      });
    }),
  );
  mount(owner, <Caller />);
  const dialog = await review(owner);
  owner.assertActive();
  expect(dialog.getByText("Stop active presences")).toBeTruthy();
  expect(dialog.getByText("Keep this independent blocker")).toBeTruthy();
  expect(dialog.queryByText(/涉及 \d+ 位用户/)).toBeNull();
  expect(dialog.queryByText("现有用户授权不变。")).toBeNull();
  expectCellAssociation(
    dialog.getByRole("table", { name: "Alice" }),
    "周期额度",
    "变更后",
    "100 GiB 方案：新方案",
  );
  await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
  const apply = dialog.getByRole("button", {
    name: "更新授权",
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  await owner.click(() => apply);
  expect(writes.some((url) => url.endsWith("/apply"))).toBe(false);
});

it("keeps matched snapshot labels and long unresolved referenced IDs when a live catalog changes", async () => {
  const owner = currentOwner;
  const longUser = "管理员".repeat(18);
  const unresolved = "service_" + "unresolved".repeat(15);
  // Display-contract negative fixture: the referenced name is unavailable.
  // This is not claimed to be a current backend resolver output.
  const longBefore = {
    ...before,
    serviceId: unresolved,
    service: undefined,
    entitlement: { ...before.entitlement, serviceId: unresolved },
    provenance: {
      ...before.provenance,
      quotaBytes: `service:${unresolved}`,
      onlineIpLimit: `service:${unresolved}`,
      connectionLimit: `service:${unresolved}`,
      entryRateBps: `service:${unresolved}`,
      routes: `service:${unresolved}+direct`,
    },
  };
  const longAfter = {
    ...after,
    service: { ...nextService, name: "新方案".repeat(18) },
    entitlement: { ...after.entitlement, serviceId: nextService.id },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        revision: "long-identities",
        affected: [{ userId: "u1", before: longBefore, after: longAfter }],
        blockers: [],
      }),
    ),
  );
  const mounted = mount(
    owner,
    <Caller
      users={[{ id: "u1", name: longUser }]}
      services={[{ id: "plan-a", name: "Current catalog" }]}
    />,
  );
  let dialog = await review(owner);
  owner.assertActive();
  let table = dialog.getByRole("table", { name: longUser });
  expect(within(table).getByText(unresolved)).toBeTruthy();
  expect(
    within(table).getByText(`方案：${unresolved} + 直接授权`),
  ).toBeTruthy();
  expect(within(table).getAllByText(`方案：${unresolved}`)).toHaveLength(4);
  expect(
    within(table).getAllByText(`方案：${"新方案".repeat(18)}`).length,
  ).toBeGreaterThan(0);
  mounted.rerender(
    <Caller
      users={[{ id: "u1", name: longUser }]}
      services={[{ id: "plan-a", name: "Later catalog rename" }]}
    />,
  );
  dialog = within(screen.getByRole("dialog", { name: "确认授权变更" }));
  table = dialog.getByRole("table", { name: longUser });
  expect(within(table).queryByText(/Later catalog rename/)).toBeNull();
  expect(within(table).getByText(unresolved)).toBeTruthy();
  expect(
    within(table).getAllByText(`方案：${"新方案".repeat(18)}`).length,
  ).toBeGreaterThan(0);
});

it.each([
  [
    "matched embedded",
    "plan-a",
    oldService,
    [{ id: "plan-a", name: "Catalog" }],
    "旧方案",
  ],
  [
    "mismatched embedded with catalog",
    "plan-a",
    { ...oldService, id: "other-plan", name: "Wrong name" },
    [{ id: "plan-a", name: "Catalog" }],
    "Catalog",
  ],
  [
    "mismatched embedded without catalog",
    "plan-a",
    { ...oldService, id: "other-plan", name: "Wrong name" },
    [],
    "plan-a",
  ],
  ["unresolved selected ID", "plan-a", undefined, [], "plan-a"],
  [
    "stray embedded service without a selected reference",
    undefined,
    oldService,
    [],
    "无方案",
  ],
  ["truly no service", undefined, undefined, [], "无方案"],
] as const)(
  "does not confuse %s with no service",
  (_case, serviceId, embedded, services, expected) => {
    const owner = currentOwner;
    mount(
      owner,
      <PolicySummary
        policy={{ ...before, serviceId, service: embedded }}
        services={[...services]}
        routes={[]}
        visibleFields={["service"]}
      />,
    );
    expect(screen.getByText(expected)).toBeTruthy();
    if (expected !== "无方案") expect(screen.queryByText("无方案")).toBeNull();
    expect(screen.queryByText("Wrong name")).toBeNull();
  },
);


it("keeps cycle start and timezone independently readable in the saved policy summary", () => {
  mount(
    currentOwner,
    <PolicySummary policy={before} services={[]} routes={[]} visibleFields={["cycle"]} />,
  );
  expect(screen.getByText("每月 1 日")).toBeTruthy();
  expect(screen.getByText("起点 2026/01/01 08:00")).toBeTruthy();
  expect(screen.getByText("时区 UTC+8")).toBeTruthy();
  expect(document.body.textContent).not.toContain("·");
});

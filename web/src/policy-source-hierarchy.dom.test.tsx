// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { Button } from "@/components/ui/button";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PolicySummary, usePolicyChange } from "./AccessPolicy";
import type { EffectivePolicy, NamedRecord, PolicyChange } from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const plan = {
  id: "plan-next", name: "标准方案", quotaBytes: 107374182400,
  onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, routeIds: ["r1"],
  cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
};
const before: EffectivePolicy = {
  userId: "u1", groupIds: [], routeIds: ["r1"], quotaBytes: 53687091200,
  onlineIpLimit: 2, connectionLimit: 8, entryRateBps: 125000, status: "active",
  provenance: {
    service: "none", quotaBytes: "individual", onlineIpLimit: "individual",
    connectionLimit: "individual", entryRateBps: "individual", routes: "direct",
  },
  entitlement: {
    userId: "u1", startsAt: "2026-01-01T00:00:00Z", cycle: plan.cycle,
    quotaOverride: 53687091200, onlineIpLimitOverride: 2,
    connectionLimitOverride: 8, entryRateBpsOverride: 125000,
  },
};
const after: EffectivePolicy = {
  ...before, serviceId: plan.id, service: plan, quotaBytes: plan.quotaBytes,
  onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
  provenance: {
    service: "individual", quotaBytes: `service:${plan.id}`,
    onlineIpLimit: `service:${plan.id}`, connectionLimit: `service:${plan.id}`,
    entryRateBps: `service:${plan.id}`, routes: `service:${plan.id}+direct`,
  },
  entitlement: { userId: "u1", serviceId: plan.id, startsAt: before.entitlement.startsAt, cycle: plan.cycle },
};
const effect = { userId: "u1", before, after };
const consent = "我已核对本次授权变更";
const boundary = "受管入口配置需单独应用。";

beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })),
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const wrap = (value: ReactNode) => <QueryClientProvider client={client}><UIProviders>{value}</UIProviders></QueryClientProvider>;
  const result = render(wrap(children));
  return { rerender(value: ReactNode) { owner.assertActive(); result.rerender(wrap(value)); } };
}
function Caller({ services = [], change = { service: plan }, onApplied = () => {} }: {
  services?: NamedRecord[]; change?: PolicyChange; onApplied?: () => void;
}) {
  const policy = usePolicyChange({ mode: "legacy-replacement", users: [{ id: "u1", name: "Alice" }], services, routes: [{ id: "r1", name: "东京线路" }], onApplied });
  return <><Button onClick={() => policy.propose(change)}>预览影响</Button>{policy.dialog}</>;
}
async function review(owner: Owner) {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const dialog = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  return within(dialog);
}
function preview(previous = before, next = after) {
  vi.stubGlobal("fetch", vi.fn(async () => json({ revision: "source-review", affected: [{ userId: "u1", before: previous, after: next }], blockers: [] })));
}
function row(table: HTMLElement, label: string) {
  return within(within(table).getByRole("rowheader", { name: label }).closest("tr")!);
}

it("shows one paired source change for the bounded limits group while keeping each exact numeric pair", async () => {
  const owner = currentOwner;
  preview();
  mount(owner, <Caller />);
  const dialog = await review(owner);
  const table = dialog.getByRole("table", { name: "Alice" });
  const group = within(table).getByRole("rowgroup", { name: "周期额度与访问限制" });
  const source = row(table, "来源变更");
  expect(source.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["个人覆盖", "方案：标准方案"]);
  expect(within(group).getAllByText("方案：标准方案")).toHaveLength(1);
  expect(within(group).getAllByText("个人覆盖")).toHaveLength(1);
  const expected = [
    ["周期额度", "50 GiB", "100 GiB"],
    ["在线 IP 上限", "2 个", "不限制"],
    ["并发逻辑流上限", "8 条", "不限制"],
    ["每个逻辑入口速率", "1 Mbps", "不限制"],
  ];
  for (const [label, previous, next] of expected) {
    const cells = row(table, label).getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual([previous, next]);
    for (const [index, cell] of cells.entries()) {
      const column = within(table).getByRole("columnheader", { name: index === 0 ? "变更前" : "变更后" });
      expect(cell.getAttribute("headers")?.split(/\s+/)).toContain(column.id);
      expect(cell.getAttribute("headers")?.split(/\s+/)).toContain(row(table, label).getByRole("rowheader").id);
      expect(cell.getAttribute("aria-describedby")).toBe(source.getAllByRole("cell")[index].id);
    }
  }
  expect(dialog.getByText(boundary)).toBeTruthy();
  expect(dialog.getByText("切换方案或续期后，保留已有用量。")).toBeTruthy();
  expect((dialog.getByRole("button", { name: "更新授权" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps a complete shared source context when changed-only omits the unchanged service row", async () => {
  const owner = currentOwner;
  const previous = {
    ...after, quotaBytes: 53687091200, onlineIpLimit: 2, connectionLimit: 8, entryRateBps: 125000,
    service: { ...plan, quotaBytes: 53687091200, onlineIpLimit: 2, connectionLimit: 8, entryRateBps: 125000 },
  };
  preview(previous, after);
  mount(owner, <Caller />);
  const dialog = await review(owner);
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(within(table).queryByRole("rowheader", { name: "服务方案" })).toBeNull();
  expect(row(table, "来源").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["方案：标准方案", "方案：标准方案"]);
  expect(within(table).queryByRole("rowheader", { name: "来源变更" })).toBeNull();
  expect(row(table, "周期额度").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["50 GiB", "100 GiB"]);
});

it("makes a source-only change explicit while retaining equal numeric values", async () => {
  const owner = currentOwner;
  const sameValuePlan = { ...plan, quotaBytes: 53687091200, onlineIpLimit: 2, connectionLimit: 8, entryRateBps: 125000 };
  preview(before, { ...after, quotaBytes: 53687091200, onlineIpLimit: 2, connectionLimit: 8, entryRateBps: 125000, service: sameValuePlan });
  mount(owner, <Caller change={{ service: sameValuePlan }} />);
  const dialog = await review(owner);
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(row(table, "来源变更").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["个人覆盖", "方案：标准方案"]);
  expect(row(table, "周期额度").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["50 GiB", "50 GiB"]);
  expect(row(table, "在线 IP 上限").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["2 个", "2 个"]);
  expect(row(table, "并发逻辑流上限").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["8 条", "8 条"]);
  expect(row(table, "每个逻辑入口速率").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["1 Mbps", "1 Mbps"]);
});

it("disambiguates distinct plan references with identical names only where the paired identity needs it", async () => {
  const owner = currentOwner;
  const previous = {
    ...after, serviceId: "plan-old", service: { ...plan, id: "plan-old" },
    entitlement: { ...after.entitlement, serviceId: "plan-old" },
    provenance: {
      ...after.provenance, quotaBytes: "service:plan-old", onlineIpLimit: "service:plan-old",
      connectionLimit: "service:plan-old", entryRateBps: "service:plan-old", routes: "service:plan-old+direct",
    },
  };
  preview(previous, after);
  mount(owner, <Caller />);
  const table = (await review(owner)).getByRole("table", { name: "Alice" });
  expect(row(table, "来源变更").getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "方案：标准方案（ID：plan-old）", "方案：标准方案（ID：plan-next）",
  ]);
  expect(row(table, "服务方案").getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "标准方案（ID：plan-old）个人覆盖", "标准方案（ID：plan-next）个人覆盖",
  ]);
  expect(row(table, "周期额度").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["100 GiB", "100 GiB"]);
  expect(row(table, "授权线路").getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "东京线路方案：标准方案 + 直接授权（ID：plan-old）", "东京线路方案：标准方案 + 直接授权（ID：plan-next）",
  ]);
});

it.each(["before", "after"] as const)("keeps mixed %s provenance local without a shared-source legend", async (side) => {
  const owner = currentOwner;
  const previous = side === "before" ? { ...before, provenance: { ...before.provenance, quotaBytes: "account" } } : before;
  const next = side === "after" ? { ...after, provenance: { ...after.provenance, quotaBytes: "individual" }, entitlement: { ...after.entitlement, quotaOverride: 107374182400 } } : after;
  preview(previous, next);
  mount(owner, <Caller />);
  const table = (await review(owner)).getByRole("table", { name: "Alice" });
  expect(within(table).getByRole("rowgroup", { name: "周期额度与访问限制" })).toBeTruthy();
  expect(within(table).queryByRole("rowheader", { name: /^来源/ })).toBeNull();
  expect(row(table, "周期额度").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(
    side === "before" ? ["50 GiB账号设置", "100 GiB方案：标准方案"] : ["50 GiB个人覆盖", "100 GiB个人覆盖"],
  );
  expect(row(table, "在线 IP 上限").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["2 个个人覆盖", "不限制方案：标准方案"]);
  expect(row(table, "在线 IP 上限").getAllByRole("cell").every((cell) => !cell.hasAttribute("aria-describedby"))).toBe(true);
});

it("distinguishes same-named mixed source references within one column without inventing a common source", async () => {
  const owner = currentOwner;
  // A defensive display fixture: multiple referenced plans in one policy are
  // not claimed to be produced by the current single-plan resolver.
  preview(before, { ...after, provenance: { ...after.provenance, onlineIpLimit: "service:other-plan" } });
  mount(owner, <Caller services={[{ id: "other-plan", name: "标准方案" }]} />);
  const table = (await review(owner)).getByRole("table", { name: "Alice" });
  expect(within(table).queryByRole("rowheader", { name: /^来源/ })).toBeNull();
  expect(row(table, "周期额度").getAllByRole("cell")[1].textContent).toBe("100 GiB方案：标准方案（ID：plan-next）");
  expect(row(table, "在线 IP 上限").getAllByRole("cell")[1].textContent).toBe("不限制方案：标准方案（ID：other-plan）");
  expect(row(table, "服务方案").getAllByRole("cell")[1].textContent).toBe("标准方案（ID：plan-next）个人覆盖");
});

const fallbackSources: { label: string; source?: string; embedded?: typeof plan; services: NamedRecord[]; expected: string }[] = [
  { label: "missing source", source: undefined, embedded: plan, services: [], expected: "未单独设置" },
  { label: "unknown source", source: "future-source", embedded: plan, services: [], expected: "future-source" },
  { label: "unresolved service", source: "service:plan-next", embedded: undefined, services: [], expected: "方案：plan-next" },
  { label: "mismatched snapshot", source: "service:other-plan", embedded: plan, services: [], expected: "方案：other-plan" },
  { label: "catalog-only name", source: "service:plan-next", embedded: undefined, services: [{ id: plan.id, name: "目录方案" }], expected: "方案：目录方案" },
  { label: "unnamed matching snapshot", source: "service:plan-next", embedded: { ...plan, name: "" }, services: [{ id: plan.id, name: "目录方案" }], expected: "方案：目录方案" },
  { label: "additional direct qualifier", source: "service:plan-next+direct", embedded: plan, services: [], expected: "方案：标准方案 + 直接授权" },
];
it.each(fallbackSources)("preserves the full inline fallback for $label", async ({ source, embedded, services, expected }) => {
  const owner = currentOwner;
  // Negative display-contract fixtures, not claims of current resolver output.
  const provenance = { ...after.provenance };
  for (const key of ["quotaBytes", "onlineIpLimit", "connectionLimit", "entryRateBps"]) {
    if (source === undefined) delete provenance[key];
    else provenance[key] = source;
  }
  preview(before, { ...after, service: embedded, provenance });
  mount(owner, <Caller services={services} />);
  const table = (await review(owner)).getByRole("table", { name: "Alice" });
  const group = within(table).getByRole("rowgroup", { name: "周期额度与访问限制" });
  expect(within(group).queryByRole("rowheader", { name: /^来源/ })).toBeNull();
  expect(within(group).getAllByText(expected)).toHaveLength(4);
  expect(row(table, "周期额度").getAllByRole("cell")[1].textContent).toBe(`100 GiB${expected}`);
  expect(row(table, "在线 IP 上限").getAllByRole("cell")[1].textContent).toBe(`不限制${expected}`);
  expect(row(table, "并发逻辑流上限").getAllByRole("cell")[1].textContent).toBe(`不限制${expected}`);
  expect(row(table, "每个逻辑入口速率").getAllByRole("cell")[1].textContent).toBe(`不限制${expected}`);
});

it("retains a single changed limit with its full inline source pair", async () => {
  const owner = currentOwner;
  preview(after, { ...after, provenance: { ...after.provenance, quotaBytes: "individual" }, entitlement: { ...after.entitlement, quotaOverride: 107374182400 } });
  mount(owner, <Caller />);
  const table = (await review(owner)).getByRole("table", { name: "Alice" });
  expect(within(table).queryByRole("rowgroup", { name: "周期额度与访问限制" })).toBeNull();
  expect(within(table).getAllByRole("rowheader")).toHaveLength(1);
  expect(row(table, "周期额度").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["100 GiB方案：标准方案", "100 GiB个人覆盖"]);
});

it("keeps non-limit fields outside the shared source and leaves standalone summaries unchanged", async () => {
  const owner = currentOwner;
  preview();
  mount(owner, <><Caller /><section aria-label="独立授权摘要"><PolicySummary policy={after} services={[]} routes={[{ id: "r1", name: "东京线路" }]} /></section></>);
  const dialog = await review(owner);
  await owner.click(() => dialog.getByRole("checkbox", { name: "显示完整授权" }));
  const table = dialog.getByRole("table", { name: "Alice" });
  const group = within(table).getByRole("rowgroup", { name: "周期额度与访问限制" });
  expect(within(group).getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
    "周期额度与访问限制", "来源变更", "周期额度", "在线 IP 上限", "并发逻辑流上限", "每个逻辑入口速率",
  ]);
  for (const label of ["状态", "服务方案", "授权线路", "开通 / 到期", "账号周期"]) {
    expect(within(group).queryByRole("rowheader", { name: label })).toBeNull();
    expect(row(table, label).getAllByRole("cell").every((cell) => !cell.hasAttribute("aria-describedby"))).toBe(true);
  }
  expect(row(table, "授权线路").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["东京线路直接授权", "东京线路方案：标准方案 + 直接授权"]);
  expect(row(table, "开通 / 到期").getAllByRole("cell")[1].textContent).toBe("2026/01/01 08:00 / 不过期");
  expect(row(table, "账号周期").getAllByRole("cell")[1].textContent).toBe("不自动重置起点 2026/01/01 08:00 · UTC+8");
  await owner.click(() => dialog.getByRole("button", { name: "返回编辑" }));
  const summary = within(screen.getByRole("region", { name: "独立授权摘要" }));
  expect(summary.getAllByText("方案：标准方案")).toHaveLength(4);
  expect(summary.getByText("方案：标准方案 + 直接授权")).toBeTruthy();
  expect(summary.queryByText("周期额度与访问限制")).toBeNull();
  expect(summary.queryByText(/ID：/)).toBeNull();
});

it("uses the exact long reviewed source name once per group despite a later catalog rename", async () => {
  const owner = currentOwner;
  const longPlan = { ...plan, name: "跨地区成员共享的长期服务方案与访问限制".repeat(4) };
  preview(before, { ...after, service: longPlan });
  const mounted = mount(owner, <Caller change={{ service: longPlan }} services={[{ id: plan.id, name: "目录原名" }]} />);
  const dialog = await review(owner);
  const table = dialog.getByRole("table", { name: "Alice" });
  expect(within(table).getAllByText(`方案：${longPlan.name}`)).toHaveLength(1);
  mounted.rerender(<Caller change={{ service: longPlan }} services={[{ id: plan.id, name: "目录新名" }]} />);
  const current = within(screen.getByRole("dialog", { name: "确认授权变更" }));
  expect(current.getByText(`服务方案：${longPlan.name}`)).toBeTruthy();
  expect(current.queryByText(/目录新名/)).toBeNull();
  expect(row(current.getByRole("table", { name: "Alice" }), "来源变更").getAllByRole("cell")[1].textContent).toBe(`方案：${longPlan.name}`);
});

it.each(["service", "group", "entitlement"] as const)("keeps explicit neutral consent and truthful update feedback for a zero-row %s review", async (kind) => {
  const owner = currentOwner;
  const changes: Record<typeof kind, PolicyChange> = {
    service: { service: plan },
    group: { group: { id: "g1", name: "Family", serviceId: plan.id, priority: 1, memberIds: [] } },
    entitlement: { entitlement: after.entitlement },
  };
  const change = changes[kind];
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    writes.push({ url: String(url), body: JSON.parse(init.body) });
    return json({ revision: "zero-review", affected: [], blockers: [] });
  }));
  const onApplied = vi.fn();
  mount(owner, <Caller change={change} onApplied={onApplied} />);
  const dialog = await review(owner);
  expect(dialog.getByText("现有用户授权不变。")).toBeTruthy();
  expect(dialog.getByText(boundary)).toBeTruthy();
  expect(dialog.queryByRole("table")).toBeNull();
  expect(dialog.queryByText("周期额度与访问限制")).toBeNull();
  const update = dialog.getByRole("button", { name: "更新授权" }) as HTMLButtonElement;
  expect(update.disabled).toBe(true);
  expect(update.getAttribute("aria-label")).toBe("更新授权");
  expect(update.getAttribute("aria-busy")).not.toBe("true");
  expect(writes).toEqual([{ url: "/api/access-policy/preview", body: change }]);
  await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
  await owner.click(() => update);
  await screen.findAllByText("平台授权已更新");
  owner.assertActive();
  expect(writes).toEqual([
    { url: "/api/access-policy/preview", body: change },
    { url: "/api/access-policy/apply", body: { change, revision: "zero-review" } },
  ]);
  expect(onApplied).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

it("keeps shared-source comparisons and every blocker without permitting a blocked update", async () => {
  const owner = currentOwner;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    writes.push(String(url));
    return json({ revision: "blocked-source", affected: [effect], blockers: ["Stop active presences", "Retain independent blocker"] });
  }));
  mount(owner, <Caller />);
  const dialog = await review(owner);
  expect(dialog.getByText("暂时无法更新授权")).toBeTruthy();
  expect(dialog.getByText("Stop active presences")).toBeTruthy();
  expect(dialog.getByText("Retain independent blocker")).toBeTruthy();
  expect(dialog.queryByText(/涉及 \d+ 位用户/)).toBeNull();
  expect(dialog.queryByText("现有用户授权不变。")).toBeNull();
  expect(row(dialog.getByRole("table", { name: "Alice" }), "来源变更").getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["个人覆盖", "方案：标准方案"]);
  await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
  const update = dialog.getByRole("button", { name: "更新授权" }) as HTMLButtonElement;
  expect(update.disabled).toBe(true);
  await owner.click(() => update);
  expect(writes).toEqual(["/api/access-policy/preview"]);
});

// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ServicePolicyComparison } from "./ServicePolicyComparison";
import type { Service } from "./types";

afterEach(cleanup);

const plan = (cycle: Service["cycle"]): Service => ({
  id: "standard", name: "标准方案", quotaBytes: 50 * 1024 ** 3, routeIds: [],
  onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, cycle,
});
const cycle = (mode: string, day = 31, days = 17): Service["cycle"] => ({
  mode, day, days, anchor: "2026-01-31T10:20:30.123456789+08:00", timezone: "Asia/Shanghai",
});
function compare(before: Service | null, after: Service, showAll = false) {
  render(<ServicePolicyComparison resource={{
    target: { kind: "service", id: after.id }, before: before ? { service: before } : null,
    after: { service: after },
  }} showAll={showAll} />);
  return screen.getByRole("table", { name: "方案变更" });
}
function values(table: HTMLElement, label: string) {
  const heading = within(table).getByRole("rowheader", { name: label });
  return within(heading.closest("tr")!).getAllByRole("cell").map((cell) => cell.textContent);
}

it.each([
  {
    name: "monthly to fixed-days", before: cycle("monthly"), after: cycle("fixed-days", 31, 28),
    day: ["31 日", "未启用（保存值：31 日）"], days: ["未启用（保存值：17 天）", "28 天"],
  },
  {
    name: "fixed-days to monthly", before: cycle("fixed-days", 31, 28), after: cycle("monthly", 31, 28),
    day: ["未启用（保存值：31 日）", "31 日"], days: ["28 天", "未启用（保存值：28 天）"],
  },
])("qualifies each side of a $name rule change without treating stored values as active", ({ before, after, day, days }) => {
  const table = compare(plan(before), plan(after));
  expect(values(table, "每月重置日")).toEqual(day);
  expect(values(table, "周期天数")).toEqual(days);
  expect(within(table).queryByRole("rowheader", { name: "每月重置日（方案保存值）" })).toBeNull();
  expect(within(table).queryByRole("rowheader", { name: "周期天数（方案保存值）" })).toBeNull();
  expect(screen.getByText("首次设置账号周期时使用的默认规则；已有账号继续沿用各自的周期。")).toBeTruthy();
});

it("still exposes changed stored parameters when neither side uses them", () => {
  const table = compare(plan(cycle("none", 1, 17)), plan(cycle("anniversary", 31, 28)));
  expect(values(table, "每月重置日")).toEqual(["未启用（保存值：1 日）", "未启用（保存值：31 日）"]);
  expect(values(table, "周期天数")).toEqual(["未启用（保存值：17 天）", "未启用（保存值：28 天）"]);
  expect(values(table, "账号周期默认规则")).toEqual(["不自动重置", "按周期起点日每月重置"]);
});

it.each([
  { mode: "monthly", day: "31 日", days: "未启用（保存值：17 天）" },
  { mode: "fixed-days", day: "未启用（保存值：31 日）", days: "17 天" },
  { mode: "anniversary", day: "未启用（保存值：31 日）", days: "未启用（保存值：17 天）" },
  { mode: "none", day: "未启用（保存值：31 日）", days: "未启用（保存值：17 天）" },
])("keeps per-side relevance in an unchanged showAll $mode snapshot", ({ mode, day, days }) => {
  const saved = plan(cycle(mode));
  const table = compare(saved, structuredClone(saved), true);
  expect(values(table, "每月重置日")).toEqual([day, day]);
  expect(values(table, "周期天数")).toEqual([days, days]);
  expect(values(table, "周期起点（方案保存值）")).toEqual([saved.cycle.anchor, saved.cycle.anchor]);
  expect(values(table, "周期时区（方案保存值）")).toEqual(["Asia/Shanghai", "Asia/Shanghai"]);
});

it("distinguishes absent stored parameters from explicit zero without normalizing either snapshot", () => {
  const before = plan({ mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "" });
  const after = plan({ ...before.cycle, day: 0, days: 0 });
  const original = structuredClone({ before, after });
  const table = compare(before, after);
  expect(values(table, "每月重置日")).toEqual(["未启用（保存值：未设置）", "未启用（保存值：0 日）"]);
  expect(values(table, "周期天数")).toEqual(["未启用（保存值：未设置）", "未启用（保存值：0 天）"]);
  expect({ before, after }).toEqual(original);
  expect(Object.hasOwn(before.cycle, "day")).toBe(false);
  expect(Object.hasOwn(before.cycle, "days")).toBe(false);
});

it("retains raw-difference disambiguation when inactive display values coincide", () => {
  const before = plan({ mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" });
  // Deliberately exercise the display fallback for an incomplete retained draft, not an accepted server context.
  const after = plan({ ...before.cycle, day: "" as unknown as number });
  const table = compare(before, after);
  expect(values(table, "每月重置日")).toEqual([
    "未启用（保存值：未设置）（保存值：未设置）",
    '未启用（保存值：未设置）（保存值：""）',
  ]);
});

it("marks an unknown rule's parameter applicability unknown instead of claiming inactivity", () => {
  const table = compare(plan(cycle("future-rule")), plan(cycle("fixed-days", 15, 17)));
  expect(values(table, "账号周期默认规则")).toEqual(["未支持的规则：future-rule", "固定天数周期"]);
  expect(values(table, "每月重置日")).toEqual(["适用性未知（保存值：31 日）", "未启用（保存值：15 日）"]);
  expect(values(table, "周期天数")).toEqual(["适用性未知（保存值：17 天）", "17 天"]);
});

it("does not add unchanged inactive parameter rows to an unrelated name change", () => {
  const before = plan(cycle("none"));
  const table = compare(before, { ...before, name: "新名称" });
  expect(values(table, "方案名称")).toEqual(["标准方案", "新名称"]);
  expect(within(table).getAllByRole("rowheader")).toHaveLength(1);
  expect(within(table).queryByRole("rowheader", { name: "每月重置日" })).toBeNull();
  expect(within(table).queryByRole("rowheader", { name: "周期天数" })).toBeNull();
});

it("keeps a new plan's absent baseline distinct from its inactive saved parameters", () => {
  const table = compare(null, plan(cycle("none")));
  expect(values(table, "每月重置日")).toEqual(["尚未创建", "未启用（保存值：31 日）"]);
  expect(values(table, "周期天数")).toEqual(["尚未创建", "未启用（保存值：17 天）"]);
});

it("keeps a narrow comparison width-bounded with wrapping headings without losing long values", () => {
  const before = { ...plan(cycle("none")), name: "原方案名称" };
  const after = { ...before, name: "这是用于窄屏检查的完整服务方案名称不能被截断", routeIds: ["a-long-stable-route-identity-that-must-remain-readable"] };
  const table = compare(before, after);
  expect(table.classList.contains("table-fixed")).toBe(true);
  expect(table.classList.contains("[&_th]:whitespace-normal")).toBe(true);
  expect(table.classList.contains("[&_th]:[overflow-wrap:anywhere]")).toBe(true);
  expect(table.classList.contains("[&_td]:[overflow-wrap:anywhere]")).toBe(true);
  expect(values(table, "方案名称")).toEqual([before.name, after.name]);
  expect(values(table, "授权线路（ID）")).toEqual(["无", after.routeIds[0]]);
  expect(within(table).getByRole("columnheader", { name: "当前保存" })).toBeTruthy();
  expect(within(table).getByRole("columnheader", { name: "本次保存" })).toBeTruthy();
});


it("labels retained raw sub-byte intent as needing correction instead of unlimited", () => {
  const saved = plan(cycle("none"));
  render(<ServicePolicyComparison resource={{ target: { kind: "service", id: saved.id }, before: { service: saved }, after: { service: saved } }} showAll draftQuota={{ value: "1e-999" }} />);
  const table = screen.getByRole("table", { name: "方案变更" });
  expect(values(table, "周期额度")[1]).toBe("1e-999 GiB（待修正）");
});

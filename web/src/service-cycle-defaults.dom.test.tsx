// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UserPolicyForm } from "./UserPolicyEditor";
import { PolicySummary } from "./AccessPolicy";
import type { Service } from "./types";
import type { EffectivePolicy } from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const plan = (cycle: Service["cycle"]): Service => ({
  id: "standard",
  name: "标准方案",
  quotaBytes: 107374182400,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle,
});
function mount(owner: Owner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
async function mountPlan(owner: Owner, initial: Service | null) {
  const view = mount(
    owner,
    <ServicePolicyEditor
      initial={initial}
      users={[]}
      services={initial ? [initial] : []}
      routes={[]}
      onClose={() => {}}
    />,
  );
  await screen.findByLabelText("服务方案名称");
  owner.assertActive();
  return view;
}
function captureEntitlementPolicyRequests(
  fixture: ReturnType<typeof entitlementEditFixture>,
) {
  const writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      fixture.transport(async (url, init) => {
        const path = String(url);
        if (
          !path.endsWith("/access-policy/preview") &&
          !path.endsWith("/access-policy/apply")
        )
          throw new Error(`Unexpected request: ${path}`);
        writes.push({ url: path, body: JSON.parse(init.body) });
        return json({ revision: "cycle-reviewed", affected: [], blockers: [] });
      }),
    ),
  );
  return writes;
}
const openingContext = (
  saved: Service | null,
  id: string,
  revision: string,
) => ({
  target: { kind: "service" as const, id },
  record: saved ? { service: structuredClone(saved) } : null,
  precondition: { exists: !!saved, revision },
});
const guardedReview = (
  before: Service | null,
  submitted: Service,
  revision = "cycle-reviewed",
) => ({
  revision,
  affected: [],
  blockers: [],
  guard: "opened-record",
  resource: {
    target: { kind: "service", id: submitted.id },
    before: before ? { service: structuredClone(before) } : null,
    after: { service: structuredClone(submitted) },
  },
});
function capturePlanRequests(initial: Service | null) {
  const writes: { url: string; body: any }[] = [];
  const fixture = initial ? serviceEditFixture(initial, "cycle-opening") : null;
  let createdID: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.startsWith("/api/access-policy/edit-context/service/")) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        if (initial && id !== initial.id)
          throw new Error(`Unexpected edit target: ${id}`);
        if (!initial && createdID && id !== createdID)
          throw new Error(`Unexpected creation target: ${id}`);
        createdID = id;
        return json(
          fixture
            ? fixture.context()
            : openingContext(null, id, "cycle-absence"),
        );
      }
      if (
        !path.endsWith("/access-policy/preview") &&
        !path.endsWith("/access-policy/apply")
      )
        throw new Error(`Unexpected request: ${path}`);
      const body = JSON.parse(init.body);
      writes.push({ url: path, body });
      if (path.endsWith("/access-policy/apply")) return json({});
      expect(body.precondition).toEqual({
        exists: !!initial,
        revision: initial ? "cycle-opening" : "cycle-absence",
      });
      expect(body.change.service.id).toBe(initial?.id || createdID);
      return json(
        fixture
          ? fixture.preview(body.change.service, {
              revision: "cycle-reviewed",
              affected: [],
              blockers: [],
            })
          : guardedReview(null, body.change.service),
      );
    }),
  );
  return writes;
}
async function preview(owner: Owner) {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const dialog = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  return dialog;
}
async function chooseRule(owner: Owner, label: string) {
  await owner.click(() => screen.getByLabelText("默认重置规则"));
  await owner.click(() =>
    screen.findByRole("option", { name: label }),
  );
}
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("shows only monthly plan-default choices, with fixed timezone context instead of an anchor or timezone question", async (context) => {
  const owner = ownedClickScenario(context);
  const initial = plan({
    mode: "monthly",
    day: 31,
    days: 17,
    anchor: "2026-10-25T04:33:05.066Z",
    timezone: "UTC+8",
  });
  capturePlanRequests(initial);
  await mountPlan(owner, initial);
  const traffic = screen.getByRole("group", { name: "流量与重置" });
  const rule = within(traffic).getByLabelText("默认重置规则");
  expect(rule).toBeTruthy();
  expect(
    (within(traffic).getByLabelText("每月几号") as HTMLInputElement).value,
  ).toBe("31");
  expect(within(traffic).queryByLabelText("每周期天数")).toBeNull();
  expect(within(traffic).queryByLabelText("周期起点")).toBeNull();
  expect(within(traffic).queryByLabelText("周期时区")).toBeNull();
  expect(
    within(traffic).getByText(
      "每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。",
    ),
  ).toBeTruthy();
  expect(
    (rule.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .some((id) =>
        document.getElementById(id)?.textContent?.includes("00:00（UTC+8）"),
      ),
  ).toBe(true);
  expect(
    within(traffic).getByText(
      "用户组首次设置账号周期时使用；已有周期和用量保留，额度不叠加。",
    ),
  ).toBeTruthy();
});

const retainedCycles: { name: string; cycle: Service["cycle"] }[] = [
  {
    name: "monthly hidden fields and nanoseconds",
    cycle: {
      mode: "monthly",
      day: 31,
      days: 17,
      anchor: "2026-02-03T04:05:06.123456789+05:30",
      timezone: "Asia/Shanghai",
    },
  },
  {
    name: "anniversary below-millisecond precision and empty timezone",
    cycle: {
      mode: "anniversary",
      day: 7,
      days: 29,
      anchor: "2026-02-03T04:05:06.000000001Z",
      timezone: "",
    },
  },
  {
    name: "fixed days with hidden monthly day",
    cycle: {
      mode: "fixed-days",
      day: 31,
      days: 3660,
      anchor: "2026-10-25T12:33:05.066+08:00",
      timezone: "UTC+8",
    },
  },
  {
    name: "no reset zero sentinel",
    cycle: {
      mode: "none",
      day: 11,
      days: 23,
      anchor: "0001-01-01T00:00:00Z",
      timezone: "Asia/Shanghai",
    },
  },
  {
    name: "absent optional day and days",
    cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "" },
  },
  {
    name: "no reset nonzero accounting start",
    cycle: {
      mode: "none",
      anchor: "2024-01-31T03:00:00.1-04:00",
      timezone: "",
    },
  },
];
it.each(retainedCycles)(
  "retains the complete $name cycle through an unrelated edit, preview and explicit apply",
  async ({ cycle }) => {
    const owner = currentOwner;
    const expected = structuredClone(cycle);
    const initial = plan(structuredClone(cycle));
    const writes = capturePlanRequests(initial);
    await mountPlan(owner, initial);
    expect(screen.queryByLabelText("修正周期起点")).toBeNull();
    expect(screen.queryByLabelText("修正周期时区")).toBeNull();
    owner.change(() => screen.getByLabelText("服务方案名称"), {
      target: { value: "更名方案" },
    });
    const dialog = await preview(owner);
    expect(writes[0].body.change.service.cycle).toEqual(expected);
    expect(Object.keys(writes[0].body.change.service.cycle).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    await owner.click(() =>
      within(dialog).getByRole("checkbox", { name: "我已核对本次授权变更" }),
    );
    await owner.click(() =>
      within(dialog).getByRole("button", { name: "更新授权" }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    owner.assertActive();
    expect(writes[1].body).toEqual({
      change: writes[0].body.change,
      revision: "cycle-reviewed",
    });
    expect(writes[1].body.change.service.name).toBe("更名方案");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).endsWith("/reset")),
    ).toBe(false);
  },
);

it("makes plan fields relevant to each selected rule without erasing hidden draft values", async (context) => {
  const owner = ownedClickScenario(context);
  const cycle = {
    mode: "monthly",
    day: 31,
    days: 17,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  };
  const initial = plan(structuredClone(cycle));
  const writes = capturePlanRequests(initial);
  await mountPlan(owner, initial);
  await chooseRule(owner, "固定天数周期");
  expect(screen.queryByLabelText("每月几号")).toBeNull();
  const days = screen.getByLabelText("每周期天数") as HTMLInputElement;
  expect(days.value).toBe("17");
  expect(days.getAttribute("aria-valuemin")).toBe("1");
  expect(days.getAttribute("aria-valuemax")).toBe("3660");
  await chooseRule(owner, "按周期起点日每月重置");
  expect(screen.queryByLabelText("每周期天数")).toBeNull();
  expect(screen.queryByLabelText("每月几号")).toBeNull();
  expect(
    screen.getByText("每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。"),
  ).toBeTruthy();
  await chooseRule(owner, "不自动重置");
  expect(screen.queryByLabelText("每周期天数")).toBeNull();
  expect(screen.queryByLabelText("每月几号")).toBeNull();
  expect(screen.queryByLabelText("周期起点")).toBeNull();
  expect(screen.queryByLabelText("周期时区")).toBeNull();
  await chooseRule(owner, "每月固定日");
  expect((screen.getByLabelText("每月几号") as HTMLInputElement).value).toBe(
    "31",
  );
  await preview(owner);
  expect(writes[0].body.change.service.cycle).toEqual(cycle);
});

it("changes only the chosen plan rule fields while retaining the inactive day, anchor and timezone", async (context) => {
  const owner = ownedClickScenario(context);
  const initial = plan({
    mode: "monthly",
    day: 31,
    days: 17,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  });
  const writes = capturePlanRequests(initial);
  await mountPlan(owner, initial);
  await chooseRule(owner, "固定天数周期");
  owner.change(() => screen.getByLabelText("每周期天数"), {
    target: { value: "28" },
  });
  await preview(owner);
  expect(writes[0].body.change.service.cycle).toEqual({
    mode: "fixed-days",
    day: 31,
    days: 28,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  });
});

it("retains the new-plan anchor across later edits and another preview instead of regenerating now", async (context) => {
  const owner = ownedClickScenario(context);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T04:33:05.066Z"));
  const writes = capturePlanRequests(null);
  await mountPlan(owner, null);
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "新方案" },
  });
  let dialog = await preview(owner);
  expect(writes[0].body.change.service.cycle).toEqual({
    mode: "monthly",
    day: 1,
    timezone: "UTC+8",
    anchor: "2026-10-25T04:33:05.066Z",
  });
  await owner.click(() =>
    within(dialog).getByRole("button", { name: "返回编辑" }),
  );
  vi.setSystemTime(new Date("2026-10-27T19:02:03.004Z"));
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "重新命名" },
  });
  dialog = await preview(owner);
  expect(dialog).toBeTruthy();
  expect(writes[1].body.change.service.cycle).toEqual(
    writes[0].body.change.service.cycle,
  );
});

it("keeps an invalid retained anchor reachable for deliberate repair without normalizing it or the timezone", async (context) => {
  const owner = ownedClickScenario(context);
  // Defensive UI repair: the real Go decoder cannot emit this impossible date.
  const initial = plan({
    mode: "monthly",
    day: 15,
    days: 19,
    anchor: "2026-02-30T08:00:00+08:00",
    timezone: "Asia/Shanghai",
  });
  const writes = capturePlanRequests(initial);
  await mountPlan(owner, initial);
  const anchor = screen.getByLabelText("修正周期起点") as HTMLInputElement;
  expect(anchor.value).toBe("2026-02-30T08:00:00+08:00");
  expect(screen.queryByLabelText("修正周期时区")).toBeNull();
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText(
    "请输入有效的完整时间并包含时区，例如 2026-10-25T08:00:00+08:00",
  );
  owner.assertActive();
  expect(writes).toHaveLength(0);
  expect(anchor.value).toBe("2026-02-30T08:00:00+08:00");
  owner.change(() => screen.getByLabelText("修正周期起点"), {
    target: { value: "2026-02-28T08:00:00.123456789+08:00" },
  });
  await preview(owner);
  expect(writes[0].body.change.service.cycle).toEqual({
    mode: "monthly",
    day: 15,
    days: 19,
    anchor: "2026-02-28T08:00:00.123456789+08:00",
    timezone: "Asia/Shanghai",
  });
});

it("retains the complete hidden cycle after failed preview and retries without replacing its anchor", async (context) => {
  const owner = ownedClickScenario(context);
  const writes: any[] = [];
  const cycle = {
    mode: "none",
    day: 31,
    days: 3660,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "",
  };
  const initial = plan(structuredClone(cycle));
  const fixture = serviceEditFixture(initial, "retry-opening");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/access-policy/edit-context/service/standard")
        return json(fixture.context());
      if (!String(url).endsWith("/access-policy/preview"))
        throw new Error(`Unexpected request: ${String(url)}`);
      const body = JSON.parse(init.body);
      writes.push(body);
      return writes.length === 1
        ? json({ error: "暂时无法预览此方案" }, 503)
        : json(
            fixture.preview(body.change.service, {
              revision: "retry-cycle",
              affected: [],
              blockers: [],
            }),
          );
    }),
  );
  await mountPlan(owner, initial);
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText("暂时无法预览此方案");
  owner.assertActive();
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "重试方案" },
  });
  await preview(owner);
  expect(writes).toHaveLength(2);
  expect(writes[0].change.service.cycle).toEqual(cycle);
  expect(writes[1].change.service.cycle).toEqual(cycle);
  expect(writes[1].change.service.name).toBe("重试方案");
  expect(writes.map((write) => write.precondition)).toEqual([
    { exists: true, revision: "retry-opening" },
    { exists: true, revision: "retry-opening" },
  ]);
});

it.each(["none", "monthly"] as const)(
  "keeps an unsupported %s timezone visible and requires deliberate repair rather than silently selecting UTC+8",
  async (mode) => {
    const owner = currentOwner;
    const initial = plan({
      mode,
      day: 15,
      days: 19,
      anchor: "0001-01-01T00:00:00Z",
      timezone: "Europe/London",
    });
    const writes = capturePlanRequests(initial);
    await mountPlan(owner, initial);
    const timezone = screen.getByLabelText("修正周期时区") as HTMLInputElement;
    expect(timezone.value).toBe("Europe/London");
    expect(
      screen.getByText("先修正周期时区；规则支持的时区为 UTC+8。"),
    ).toBeTruthy();
    expect(screen.queryByText("周期时区：UTC+8")).toBeNull();
    expect(
      screen.queryByText(
        "每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。",
      ),
    ).toBeNull();
    expect(screen.queryByLabelText("修正周期起点")).toBeNull();
    await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
    await screen.findByText("周期时区仅支持 UTC+8 或 Asia/Shanghai");
    owner.assertActive();
    expect(writes).toHaveLength(0);
    expect(timezone.value).toBe("Europe/London");
    owner.change(() => screen.getByLabelText("修正周期时区"), {
      target: { value: "" },
    });
    expect(
      await screen.findByText(
        mode === "monthly"
          ? "每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。"
          : "周期时区：UTC+8",
      ),
    ).toBeTruthy();
    owner.assertActive();
    expect(
      screen.queryByText("先修正周期时区；规则支持的时区为 UTC+8。"),
    ).toBeNull();
    expect(screen.getByLabelText("修正周期时区")).toBe(timezone);
    await preview(owner);
    expect(writes[0].body.change.service.cycle).toEqual({
      mode,
      day: 15,
      days: 19,
      anchor: "0001-01-01T00:00:00Z",
      timezone: "",
    });
  },
);

const accountPolicy = (cycle: Service["cycle"]): EffectivePolicy => ({
  userId: "account",
  groupIds: [],
  routeIds: [],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: { service: "none", cycle: "account" },
  entitlement: { userId: "account", startsAt: "0001-01-01T00:00:00Z", cycle },
});
it("leaves the account's no-reset anchor, timezone control and implicit start unchanged", async (context) => {
  const owner = ownedClickScenario(context);
  const cycle = {
    mode: "none",
    anchor: "0001-01-01T00:00:00Z",
    timezone: "UTC+8",
  };
  const fixture = entitlementEditFixture(accountPolicy(structuredClone(cycle)));
  const writes = captureEntitlementPolicyRequests(fixture);
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "account",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={fixture.context()}
      services={[]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  await owner.click(() =>
    screen.getByRole("button", { name: "高级：账号流量周期" }),
  );
  await screen.findByLabelText("流量重置规则");
  owner.assertActive();
  expect(screen.getByLabelText("流量重置规则")).toBeTruthy();
  expect(screen.queryByLabelText("默认重置规则")).toBeNull();
  expect((screen.getByLabelText("周期起点") as HTMLInputElement).value).toBe(
    "0001-01-01T00:00:00Z",
  );
  expect(screen.getByLabelText("周期时区")).toBeTruthy();
  expect((screen.getByLabelText("开通时间") as HTMLInputElement).value).toBe(
    "",
  );
  await owner.click(() => screen.getByRole("switch", { name: "暂停平台服务" }));
  await preview(owner);
  expect(writes[0].body.entitlement.cycle).toEqual(cycle);
  expect(writes[0].body.entitlement.startsAt).toBe("0001-01-01T00:00:00Z");
});

it("describes the account anniversary rule as monthly anchor-day rather than start-date or yearly recurrence", async (context) => {
  const owner = ownedClickScenario(context);
  const policy = accountPolicy({
    mode: "anniversary",
    anchor: "2024-01-31T03:00:00Z",
    timezone: "UTC+8",
  });
  mount(
    owner,
    <>
      <section aria-label="账号周期摘要">
        <PolicySummary
          policy={policy}
          services={[]}
          routes={[]}
          visibleFields={["cycle"]}
        />
      </section>
      <section aria-label="账号周期编辑">
        <UserPolicyForm
          user={{
            id: "account",
            name: "Alice",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          }}
          initial={entitlementEditFixture(policy).context()}
          services={[]}
          routes={[]}
          onClose={() => {}}
        />
      </section>
    </>,
  );
  expect(
    within(screen.getByRole("region", { name: "账号周期摘要" })).getByText(
      "按周期起点日每月重置",
    ),
  ).toBeTruthy();
  await owner.click(() =>
    screen.getByRole("button", { name: "高级：账号流量周期" }),
  );
  await screen.findByLabelText("流量重置规则");
  owner.assertActive();
  expect(
    within(screen.getByRole("region", { name: "账号周期编辑" })).getByText(
      "按周期起点日每月重置",
    ),
  ).toBeTruthy();
  expect((screen.getByLabelText("周期起点") as HTMLInputElement).value).toBe(
    "2024-01-31T03:00:00Z",
  );
  expect(screen.queryByText("开通日历月周年")).toBeNull();
});

it("uses the same monthly anchor-day wording in the service list without changing its edit action", async (context) => {
  const owner = ownedClickScenario(context);
  const { AdminPage } = await import("./Admin");
  owner.assertActive();
  const initial = plan({
    mode: "anniversary",
    anchor: "2024-01-31T03:00:00Z",
    timezone: "UTC+8",
  });
  const fixture = serviceEditFixture(initial);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method && init.method !== "GET")
        throw new Error(`Unexpected write: ${String(url)}`);
      if (url === "/api/access-policy/edit-context/service/standard")
        return json(fixture.context());
      if (url === "/api/state")
        return json({
          nodes: [],
          users: [],
          routes: [],
          revisions: [],
          capabilities: [],
        });
      if (url === "/api/services") return json([initial]);
      if (url === "/api/settings")
        return json({ timezone: "UTC+8", registration: "invite" });
      if (url === "/api/published-routes") return json([]);
      if (url === "/api/rates") return json([]);
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  mount(owner, <AdminPage page="services" />);
  const rule = await screen.findByText("按周期起点日每月重置");
  owner.assertActive();
  expect(rule).toBeTruthy();
  expect(screen.queryByText("开通日每月")).toBeNull();
  await owner.click(() => screen.getByRole("button", { name: /编\s*辑/ }));
  expect(
    await screen.findByRole("dialog", { name: "编辑 标准方案" }),
  ).toBeTruthy();
  owner.assertActive();
  expect(await screen.findByLabelText("默认重置规则")).toBeTruthy();
  owner.assertActive();
});

const staleDetail = "服务方案已更新。当前草稿尚未保存，请查看最新版本。";
const retainedConsent =
  "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本";
function rowValues(table: HTMLElement, label: string) {
  const header = within(table).getByRole("rowheader", { name: label });
  return within(header.closest("tr")!)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}
async function acceptLatest(owner: Owner) {
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本" }),
  );
}

it("preserves hidden precise cycles across stale preview, explicit latest acceptance and a failed apply", async (context) => {
  const owner = ownedClickScenario(context);
  const original = plan({
    mode: "monthly",
    day: 1,
    days: 17,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  });
  const latest = {
    ...structuredClone(original),
    name: "最新方案",
    cycle: {
      ...original.cycle,
      day: 15,
      days: 29,
      anchor: "2026-04-05T06:07:08.987654321-04:00",
      timezone: "",
    },
  };
  const expectedOld = structuredClone(original.cycle),
    expectedLatest = structuredClone(latest.cycle);
  let saved = original,
    opening = "opened-old";
  const previews: any[] = [],
    applies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/access-policy/edit-context/service/standard")
        return json(openingContext(saved, saved.id, opening));
      const body = JSON.parse(init.body);
      if (path === "/api/access-policy/preview") {
        previews.push(body);
        return body.precondition.revision === "opened-old"
          ? json(
              { code: "POLICY_EDIT_BASELINE_CHANGED", detail: staleDetail },
              409,
            )
          : json(guardedReview(latest, body.change.service));
      }
      if (path === "/api/access-policy/apply") {
        applies.push(body);
        return json({ detail: "暂时无法保存方案" }, 503);
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  await mountPlan(owner, original);
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "我的旧草稿" },
  });
  saved = latest;
  opening = "opened-latest";
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText(staleDetail);
  owner.assertActive();
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await waitFor(() => expect(previews).toHaveLength(2));
  owner.assertActive();
  expect(previews.map((write) => write.precondition)).toEqual([
    { exists: true, revision: "opened-old" },
    { exists: true, revision: "opened-old" },
  ]);
  expect(previews.map((write) => write.change.service.cycle)).toEqual([
    expectedOld,
    expectedOld,
  ]);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "查看最新版本",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await screen.findByRole("button", { name: "使用最新版本重新编辑" });
  owner.assertActive();
  expect(
    (screen.getByLabelText("服务方案名称") as HTMLInputElement).value,
  ).toBe("我的旧草稿");
  expect((screen.getByLabelText("每月几号") as HTMLInputElement).value).toBe(
    "1",
  );
  const savedChanges = screen.getByRole("table", { name: "已保存的方案变化" });
  expect(rowValues(savedChanges, "周期起点（方案保存值）")).toEqual([
    expectedOld.anchor,
    expectedLatest.anchor,
  ]);
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("服务方案名称") as HTMLInputElement).value,
    ).toBe("最新方案"),
  );
  owner.assertActive();
  expect((screen.getByLabelText("每月几号") as HTMLInputElement).value).toBe(
    "15",
  );
  expect(screen.queryByLabelText("周期起点")).toBeNull();
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const retained = await screen.findByRole("table", { name: "保留的草稿" });
  owner.assertActive();
  expect(rowValues(retained, "每月重置日")).toEqual(["1 日", "1 日"]);
  expect(rowValues(retained, "周期天数")).toEqual([
    "未启用（保存值：17 天）",
    "未启用（保存值：17 天）",
  ]);
  expect(rowValues(retained, "周期起点（方案保存值）")).toEqual([
    expectedOld.anchor,
    expectedOld.anchor,
  ]);
  expect(rowValues(retained, "周期时区（方案保存值）")).toEqual([
    "Asia/Shanghai",
    "Asia/Shanghai",
  ]);
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "重新命名最新方案" },
  });
  let dialog = await preview(owner);
  expect(previews[2].precondition).toEqual({
    exists: true,
    revision: "opened-latest",
  });
  expect(previews[2].change.service.cycle).toEqual(expectedLatest);
  expect(
    (
      within(dialog).getByRole("button", {
        name: "更新授权",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await owner.click(() =>
    within(dialog).getByRole("checkbox", { name: retainedConsent }),
  );
  await owner.click(() =>
    within(dialog).getByRole("button", { name: "更新授权" }),
  );
  await screen.findByText("暂时无法保存方案");
  owner.assertActive();
  expect(applies).toEqual([
    { change: previews[2].change, revision: "cycle-reviewed" },
  ]);
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
  await owner.click(() =>
    within(dialog).getByRole("button", { name: "返回编辑" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
  );
  owner.assertActive();
  dialog = await preview(owner);
  expect(previews[3].precondition).toEqual({
    exists: true,
    revision: "opened-latest",
  });
  expect(previews[3].change.service.cycle).toEqual(expectedLatest);
  expect(
    (
      within(dialog).getByRole("checkbox", {
        name: retainedConsent,
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "更新授权",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("reinitializes deliberate timezone repair only after accepting a latest context and keeps the prior exact draft", async (context) => {
  const owner = ownedClickScenario(context);
  const original = plan({
    mode: "none",
    day: 31,
    days: 17,
    anchor: "0001-01-01T00:00:00Z",
    timezone: "Asia/Shanghai",
  });
  const latest = {
    ...structuredClone(original),
    name: "待修正方案",
    cycle: {
      mode: "monthly",
      day: 15,
      days: 29,
      anchor: "2026-04-05T06:07:08.987654321-04:00",
      timezone: "Europe/London",
    },
  };
  const expectedOriginal = structuredClone(original.cycle);
  const expectedRepaired = { ...structuredClone(latest.cycle), timezone: "" };
  let saved = original,
    opening = "repair-old";
  const previews: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/access-policy/edit-context/service/standard")
        return json(openingContext(saved, saved.id, opening));
      if (path !== "/api/access-policy/preview")
        throw new Error(`Unexpected request: ${path}`);
      const body = JSON.parse(init.body);
      previews.push(body);
      return body.precondition.revision === "repair-old"
        ? json(
            { code: "POLICY_EDIT_BASELINE_CHANGED", detail: staleDetail },
            409,
          )
        : json(guardedReview(latest, body.change.service));
    }),
  );
  await mountPlan(owner, original);
  expect(screen.queryByLabelText("修正周期时区")).toBeNull();
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "保留原草稿" },
  });
  saved = latest;
  opening = "repair-latest";
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText(staleDetail);
  owner.assertActive();
  expect(previews[0].change.service.cycle).toEqual(expectedOriginal);
  await acceptLatest(owner);
  const timezone = (await screen.findByLabelText(
    "修正周期时区",
  )) as HTMLInputElement;
  owner.assertActive();
  expect(timezone.value).toBe("Europe/London");
  expect(
    screen.getByText("先修正周期时区；规则支持的时区为 UTC+8。"),
  ).toBeTruthy();
  expect(
    screen.queryByText("每月在对应日期的 00:00（UTC+8）重置；无该日时取月末。"),
  ).toBeNull();
  expect(screen.queryByLabelText("修正周期起点")).toBeNull();
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const retained = await screen.findByRole("table", { name: "保留的草稿" });
  owner.assertActive();
  expect(rowValues(retained, "周期起点（方案保存值）")).toEqual([
    expectedOriginal.anchor,
    expectedOriginal.anchor,
  ]);
  expect(rowValues(retained, "周期时区（方案保存值）")).toEqual([
    "Asia/Shanghai",
    "Asia/Shanghai",
  ]);
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText("周期时区仅支持 UTC+8 或 Asia/Shanghai");
  owner.assertActive();
  expect(previews).toHaveLength(1);
  owner.change(() => screen.getByLabelText("修正周期时区"), {
    target: { value: "" },
  });
  expect(screen.getByLabelText("修正周期时区")).toBe(timezone);
  const dialog = await preview(owner);
  expect(previews[1].precondition).toEqual({
    exists: true,
    revision: "repair-latest",
  });
  expect(previews[1].change.service.cycle).toEqual(expectedRepaired);
  const review = within(dialog).getByRole("table", { name: "方案变更" });
  expect(rowValues(review, "周期时区（方案保存值）")).toEqual([
    "Europe/London",
    "未设置",
  ]);
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
});

it("carries a new plan's original anchor and hidden fields through explicit collision restart with a new absence token", async (context) => {
  const owner = ownedClickScenario(context);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T04:33:05.066Z"));
  let originalID: string | undefined,
    newID: string | undefined,
    collided = false;
  const previews: any[] = [],
    reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.startsWith("/api/access-policy/edit-context/service/")) {
        const id = decodeURIComponent(path.split("/").at(-1)!);
        reads.push(id);
        if (!originalID) originalID = id;
        if (id === originalID) {
          if (!collided)
            return json(openingContext(null, id, "absent-original"));
          return json(
            openingContext(
              {
                ...plan({
                  mode: "monthly",
                  day: 15,
                  anchor: "2024-01-01T00:00:00Z",
                  timezone: "UTC+8",
                }),
                id,
                name: "他人方案",
              },
              id,
              "occupied-original",
            ),
          );
        }
        if (newID && newID !== id)
          throw new Error(`Unexpected third target: ${id}`);
        newID = id;
        return json(openingContext(null, id, "absent-new"));
      }
      if (path !== "/api/access-policy/preview")
        throw new Error(`Unexpected request: ${path}`);
      const body = JSON.parse(init.body);
      previews.push(body);
      if (body.precondition.revision === "absent-original") {
        collided = true;
        return json(
          { code: "POLICY_EDIT_BASELINE_CHANGED", detail: staleDetail },
          409,
        );
      }
      return json(guardedReview(null, body.change.service));
    }),
  );
  await mountPlan(owner, null);
  owner.change(() => screen.getByLabelText("服务方案名称"), {
    target: { value: "我的新方案" },
  });
  owner.change(() => screen.getByLabelText("每月几号"), {
    target: { value: "31" },
  });
  await chooseRule(owner, "固定天数周期");
  owner.change(() => screen.getByLabelText("每周期天数"), {
    target: { value: "17" },
  });
  await chooseRule(owner, "不自动重置");
  const expected = {
    mode: "none",
    day: 31,
    days: 17,
    timezone: "UTC+8",
    anchor: "2026-10-25T04:33:05.066Z",
  };
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText(staleDetail);
  owner.assertActive();
  expect(previews[0].change.service.cycle).toEqual(expected);
  expect(previews[0].precondition).toEqual({
    exists: false,
    revision: "absent-original",
  });
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await screen.findByRole("button", { name: "使用新标识另建方案" });
  owner.assertActive();
  expect(previews).toHaveLength(1);
  expect(
    (screen.getByLabelText("服务方案名称") as HTMLInputElement).value,
  ).toBe("我的新方案");
  vi.setSystemTime(new Date("2026-10-28T19:20:21.987Z"));
  await owner.click(() =>
    screen.getByRole("button", { name: "使用新标识另建方案" }),
  );
  await screen.findByLabelText("服务方案名称");
  owner.assertActive();
  expect(newID).toBeTruthy();
  expect(newID).not.toBe(originalID);
  expect(reads).toEqual([originalID, originalID, newID]);
  expect(
    (screen.getByLabelText("服务方案名称") as HTMLInputElement).value,
  ).toBe("我的新方案");
  expect(screen.queryByLabelText("周期起点")).toBeNull();
  expect(screen.queryByLabelText("每月几号")).toBeNull();
  expect(screen.queryByLabelText("每周期天数")).toBeNull();
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const retained = await screen.findByRole("table", { name: "保留的草稿" });
  owner.assertActive();
  expect(rowValues(retained, "周期起点（方案保存值）")).toEqual([
    "尚未创建",
    expected.anchor,
  ]);
  expect(rowValues(retained, "每月重置日")).toEqual([
    "尚未创建",
    "未启用（保存值：31 日）",
  ]);
  expect(rowValues(retained, "周期天数")).toEqual([
    "尚未创建",
    "未启用（保存值：17 天）",
  ]);
  const dialog = await preview(owner);
  expect(previews[1].change.service.id).toBe(newID);
  expect(previews[1].precondition).toEqual({
    exists: false,
    revision: "absent-new",
  });
  expect(previews[1].change.service.cycle).toEqual(expected);
  expect(
    (
      within(dialog).getByRole("checkbox", {
        name: retainedConsent,
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "更新授权",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { EntitlementPolicyComparison } from "./EntitlementPolicyComparison";
import { UserPolicyEditor } from "./UserPolicyEditor";
import type {
  EffectivePolicy,
  EntitlementPolicyEditContext,
} from "./access-policy-model";
import type { Entitlement } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const user = {
  id: "u1",
  name: "Alice",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const original: Entitlement = {
  userId: "u1",
  startsAt: "2026-02-03T04:05:06.123456789+05:30",
  paused: false,
  cycle: {
    mode: "monthly",
    day: 1,
    days: 23,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  },
  quotaOverride: 50 * 1024 ** 3,
  onlineIpLimitOverride: 17,
};
const effective = (ent: Entitlement): EffectivePolicy => ({
  userId: "u1",
  groupIds: [],
  routeIds: [],
  quotaBytes: ent.quotaOverride ?? 0,
  onlineIpLimit: ent.onlineIpLimitOverride ?? 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: {},
  entitlement: ent,
});
const context = (
  record: Entitlement | null,
  revision = "opened-1",
  seed = original,
): EntitlementPolicyEditContext => ({
  target: { kind: "entitlement", id: "u1" },
  record: record ? { entitlement: record } : null,
  precondition: { exists: !!record, revision },
  effective: effective(record ?? seed),
});
const reviewed = (before: Entitlement | null, after: Entitlement) => ({
  guard: "opened-record",
  revision: "preview-1",
  affected: [
    {
      userId: "u1",
      before: effective(before ?? original),
      after: effective(after),
    },
  ],
  blockers: [],
  resource: {
    target: { kind: "entitlement", id: "u1" },
    before: before ? { entitlement: before } : null,
    after: { entitlement: after },
  },
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const conflict = () =>
  json(
    {
      code: "POLICY_EDIT_BASELINE_CHANGED",
      detail: "个人授权已更新。当前草稿尚未保存，请查看最新版本。",
    },
    409,
  );
beforeEach((test) => {
  owner = ownedClickScenario(test);
  // rc-util otherwise assigns every Drawer/Modal the same test-only aria ID.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(close = () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <UIProviders>
          <UserPolicyEditor
            user={user}
            services={[]}
            routes={[]}
            onClose={close}
          />
        </UIProviders>
      </QueryClientProvider>
    </StrictMode>,
  );
}
const change = (label: string, value: string) =>
  owner.change(() => screen.getByLabelText(label), { target: { value } });
async function preview() {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
}
async function openLimits() {
  await screen.findByLabelText("开通时间");
  owner.assertActive();
  await owner.click(() =>
    screen.getByRole("button", { name: "个人额度与限制" }),
  );
  await screen.findByLabelText("个人周期额度（GiB）");
  owner.assertActive();
}

it("keeps A's complete draft until explicit reconciliation and saves quota100 with B's day15", async () => {
  let saved = original;
  const newer = { ...original, cycle: { ...original.cycle, day: 15 } };
  const writes: any[] = [],
    close = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/"))
        return json(
          context(saved, saved === original ? "opened-1" : "opened-2"),
        );
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      if (String(url).endsWith("/preview"))
        return body.precondition.revision === "opened-1"
          ? conflict()
          : json(reviewed(newer, body.change.entitlement));
      return json({});
    }),
  );
  mount(close);
  await openLimits();
  change("个人周期额度（GiB）", "100");
  await owner.click(() =>
    screen.getByRole("checkbox", { name: "覆盖个人在线 IP 数上限" }),
  );
  saved = newer;
  await preview();
  await screen.findByText("个人授权已更新。当前草稿尚未保存，请查看最新版本。");
  expect(
    (screen.getByLabelText("个人周期额度（GiB）") as HTMLInputElement).value,
  ).toBe("100");
  expect(writes[0]).toMatchObject({
    precondition: { exists: true, revision: "opened-1" },
    change: {
      entitlement: {
        quotaOverride: 100 * 1024 ** 3,
        onlineIpLimitOverride: null,
        cycle: { day: 1, days: 23, timezone: "Asia/Shanghai" },
        startsAt: original.startsAt,
      },
    },
  });
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const comparison = within(
    await screen.findByRole("table", { name: "已保存的个人授权变化" }),
  );
  expect(comparison.getByRole("row", { name: "每月几号 1 15" })).toBeTruthy();
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  const adoption = within(
    await screen.findByRole("alertdialog", { name: "使用最新版本重新编辑？" }),
  );
  await owner.click(() =>
    adoption.getByRole("button", { name: "使用最新版本" }),
  );
  await screen.findByRole("button", { name: "保留的草稿 1（未保存）" });
  await openLimits();
  expect(
    (screen.getByLabelText("个人周期额度（GiB）") as HTMLInputElement).value,
  ).toBe("50");
  await owner.click(() =>
    screen.getByRole("button", { name: "保留的草稿 1（未保存）" }),
  );
  const retained = within(
    await screen.findByRole("region", { name: "保留的个人授权草稿" }),
  );
  owner.assertActive();
  expect(
    retained.getByText("个人在线 IP 数上限（表单保存值）").nextElementSibling
      ?.textContent,
  ).toBe("17");
  expect(
    retained.getByText("覆盖个人在线 IP 数上限").nextElementSibling
      ?.textContent,
  ).toBe("false");
  change("个人周期额度（GiB）", "100");
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(writes[1]).toMatchObject({
    precondition: { revision: "opened-2" },
    change: {
      entitlement: { cycle: { day: 15 }, quotaOverride: 100 * 1024 ** 3 },
    },
  });
  expect(review.queryByText(/之后加入用户组不会/)).toBeNull();
  // Review starts with effective account changes; stored values remain available
  // without making the user read a second comparison before the decision.
  expect(review.getByRole("table", { name: "Alice" })).toBeTruthy();
  expect(review.queryByRole("table", { name: "个人授权变更" })).toBeNull();
  await owner.click(() => review.getByRole("button", { name: "查看个人设置变更" }));
  expect(review.getByRole("table", { name: "个人授权变更" })).toBeTruthy();
  await owner.click(() =>
    review.getByRole("checkbox", {
      name: "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本",
    }),
  );
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(writes[2]).toEqual({
    change: writes[1].change,
    revision: "preview-1",
  });
});

it("rejects the pointer gesture that dismisses a pending date, then previews the unchanged exact timestamp", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/"))
        return json(context(original));
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      return json(reviewed(original, body.change.entitlement));
    }),
  );
  mount();
  const field = await screen.findByLabelText("开通时间");
  await owner.click(() => field);
  const day = await waitFor(() => {
    owner.assertActive();
    const cells = screen.getAllByRole("button", { name: "2026年2月4日" });
    expect(cells).toHaveLength(1);
    return cells[0];
  });
  await owner.click(() => day);
  await preview();
  expect(writes).toHaveLength(0);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  await waitFor(() =>
    expect(
      screen.queryByText("请先确认或取消日期选择，再预览或重新编辑。"),
    ).toBeNull(),
  );
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  expect(writes[0].change.entitlement.startsAt).toBe(original.startsAt);
});

it("keeps incomplete numeric input pending through blur and Enter, including hidden cycle controls", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/"))
        return json(context(original));
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      return json(reviewed(original, body.change.entitlement));
    }),
  );
  mount();
  await openLimits();
  change("个人在线 IP 数上限", "-");
  const command = screen.getByRole("button", {
    name: "预览影响",
  }) as HTMLButtonElement;
  expect(command.getAttribute("aria-disabled")).toBe("true");
  expect(command.disabled).toBe(false);
  expect(command.classList.contains("cursor-not-allowed")).toBe(true);
  expect(command.classList.contains("opacity-50")).toBe(true);
  expect(command.getAttribute("aria-disabled")).toBe("true");
  expect(command.style.pointerEvents).toBe("");
  await preview();
  expect(writes).toHaveLength(0);
  expect(
    screen.getByText(/个人在线 IP 数上限的输入「-」尚未完成/),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "覆盖个人在线 IP 数上限",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  const number = screen.getByLabelText("个人在线 IP 数上限");
  await owner.click(() => number);
  owner.assertActive();
  expect(number.isConnected && document.activeElement === number).toBe(true);
  await userEvent.keyboard("{Enter}");
  owner.assertActive();
  expect(writes).toHaveLength(0);
  await owner.click(() =>
    screen.getByRole("button", { name: "放弃未完成输入，保留当前数值" }),
  );
  expect(
    (screen.getByLabelText("个人在线 IP 数上限") as HTMLInputElement).value,
  ).toBe("17");
  expect(command.getAttribute("aria-disabled")).not.toBe("true");
  expect(command.classList.contains("cursor-not-allowed")).toBe(false);
  expect(command.classList.contains("opacity-50")).toBe(false);
  await owner.click(() =>
    screen.getByRole("button", { name: "高级：账号流量周期" }),
  );
  await screen.findByLabelText("每月几号");
  owner.assertActive();
  change("每月几号", "-");
  expect(
    (screen.getByLabelText("流量重置规则") as HTMLInputElement).disabled,
  ).toBe(true);
  await preview();
  expect(writes).toHaveLength(0);
  await owner.click(() =>
    screen.getByRole("button", { name: "放弃未完成输入，保留当前数值" }),
  );
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement).toMatchObject({
    onlineIpLimitOverride: 17,
    cycle: { day: 1, days: 23 },
  });
});

it("discloses absent-row calendar adoption despite unchanged effective values and never creates on read", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/")) return json(context(null));
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      return json(reviewed(null, body.change.entitlement));
    }),
  );
  mount();
  await screen.findByLabelText("开通时间");
  expect(writes).toHaveLength(0);
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.queryByText("新建个人授权设置")).toBeNull();
  expect(
    review.getByText(
      "保存后将使用此账号周期；之后加入用户组时，继续沿用此周期。",
    ),
  ).toBeTruthy();
  expect(writes).toHaveLength(1);
  expect(writes[0].precondition.exists).toBe(false);
});

it.each(["-", "17.0000000000000001"])("does not install a late latest context over newer raw input %s", async (raw) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  let latestRead = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/"))
        return latestRead
          ? held.then(() =>
              json(
                context(
                  { ...original, cycle: { ...original.cycle, day: 15 } },
                  "opened-2",
                ),
              ),
            )
          : json(context(original));
      latestRead = true;
      return conflict();
    }),
  );
  mount();
  await openLimits();
  await preview();
  await screen.findByText("个人授权已更新。当前草稿尚未保存，请查看最新版本。");
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  change("个人在线 IP 数上限", raw);
  await act(async () => release());
  expect(
    screen.queryByRole("button", { name: "使用最新版本重新编辑" }),
  ).toBeNull();
  expect(
    screen.getByText(`个人在线 IP 数上限的输入「${raw}」尚未完成；当前数值为 17。`),
  ).toBeTruthy();
});

it.each(["missing guard", "wrong target", "unknown field"])(
  "fails closed on %s without replacing the retained personal draft",
  async (fault) => {
    const writes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/admission-status"))
          return json({
            asOf: original.startsAt,
            maxLeaseSeconds: 30,
            onlineIps: [],
            activeStreams: 0,
            entries: [],
          });
        if (String(url).includes("/edit-context/"))
          return json(context(original));
        const body = JSON.parse(init!.body as string);
        writes.push(body);
        const result: any = reviewed(original, body.change.entitlement);
        if (fault === "missing guard") delete result.guard;
        if (fault === "wrong target") result.resource.target.id = "other-user";
        if (fault === "unknown field")
          result.resource.after.entitlement.futureOverride = true;
        return json(result);
      }),
    );
    mount();
    await openLimits();
    change("个人周期额度（GiB）", "100");
    await preview();
    await screen.findByText(
      "服务未返回完整的个人授权变更核对结果。当前草稿已保留，请重试。",
    );
    expect(
      (screen.getByLabelText("个人周期额度（GiB）") as HTMLInputElement).value,
    ).toBe("100");
    expect(writes).toHaveLength(1);
    expect(writes[0].precondition.revision).toBe("opened-1");
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  },
);

// A mode change activates stored parameters even when those numbers did not change.
it("reviews operative cycle parameters and exact changed limits without hiding them behind rounded labels", () => {
  const before = {
    ...original,
    quotaOverride: 1024 ** 3,
    entryRateBpsOverride: 9007199254740989,
    cycle: { ...original.cycle, day: 15, days: 7 },
  };
  const after = {
    ...before,
    quotaOverride: 1024 ** 3 + 1,
    entryRateBpsOverride: 9007199254740990,
    cycle: { ...before.cycle, mode: "fixed-days" as const },
  };
  const view = render(
    <EntitlementPolicyComparison
      resource={{
        target: { kind: "entitlement", id: "u1" },
        before: { entitlement: before },
        after: { entitlement: after },
      }}
    />,
  );
  const table = within(screen.getByRole("table", { name: "个人授权变更" }));
  expect(
    table.getByRole("row", { name: "每月几号 15 未启用，保存值：15" }),
  ).toBeTruthy();
  expect(
    table.getByRole("row", { name: "每周期天数 未启用，保存值：7 7" }),
  ).toBeTruthy();
  expect(table.getByText(/保存值：1073741824 字节/)).toBeTruthy();
  expect(table.getByText(/保存值：1073741825 字节/)).toBeTruthy();
  expect(table.getByText(/保存值：9007199254740989 字节\/秒/)).toBeTruthy();
  expect(table.getByText(/保存值：9007199254740990 字节\/秒/)).toBeTruthy();
  view.rerender(
    <EntitlementPolicyComparison
      resource={{
        target: { kind: "entitlement", id: "u1" },
        before: { entitlement: before },
        after: {
          entitlement: {
            ...after,
            cycle: {
              ...after.cycle,
              mode: "future-cycle" as Entitlement["cycle"]["mode"],
            },
          },
        },
      }}
    />,
  );
  expect(
    screen.getByRole("row", { name: "每月几号 15 适用性未知，保存值：15" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("row", {
      name: "每周期天数 未启用，保存值：7 适用性未知，保存值：7",
    }),
  ).toBeTruthy();
});

it("previews the edited hidden cycle parameter rather than restoring its opening value", async () => {
  const saved: Entitlement = {
    ...original,
    cycle: { ...original.cycle, mode: "fixed-days", day: 15, days: 17 },
  };
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/")) return json(context(saved));
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      return json(reviewed(saved, body.change.entitlement));
    }),
  );
  mount();
  await screen.findByLabelText("开通时间");
  owner.assertActive();
  await owner.click(() =>
    screen.getByRole("button", { name: "高级：账号流量周期" }),
  );
  await screen.findByLabelText("每周期天数");
  owner.assertActive();
  change("每周期天数", "28");
  await owner.click(() => screen.getByLabelText("流量重置规则"));
  await owner.click(() =>
    screen.findByRole("option", { name: "每月固定日" }),
  );
  await screen.findByLabelText("每月几号");
  owner.assertActive();
  expect(screen.queryByLabelText("每周期天数")).toBeNull();
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  expect(writes).toHaveLength(1);
  expect(writes[0].change.entitlement.cycle).toEqual({
    mode: "monthly",
    day: 15,
    days: 28,
    anchor: original.cycle.anchor,
    timezone: "Asia/Shanghai",
  });
  expect(writes[0].precondition).toEqual({
    exists: true,
    revision: "opened-1",
  });
});

it("summarizes creation once while preserving explicit zero, operative cycle and full saved values", async () => {
  const seed: Entitlement = {
    ...original,
    startsAt: "0001-01-01T00:00:00Z",
    quotaOverride: undefined,
    onlineIpLimitOverride: undefined,
    cycle: {
      mode: "none",
      day: 15,
      days: 23,
      anchor: "0001-01-01T00:00:00Z",
      timezone: "UTC+8",
    },
  };
  const resource = (entitlement: Entitlement) => ({
    target: { kind: "entitlement" as const, id: "u1" },
    before: null,
    after: { entitlement },
  });
  const view = render(
    <EntitlementPolicyComparison resource={resource(seed)} />,
  );
  const table = () =>
    within(screen.getByRole("table", { name: "个人授权变更" }));
  expect(
    screen
      .getByRole("table", { name: "个人授权变更" })
      .classList.contains("policy-creation-summary"),
  ).toBe(true);
  expect(screen.getAllByText("新建个人授权设置")).toHaveLength(1);
  expect(
    table()
      .getAllByRole("columnheader")
      .map((node) => node.textContent),
  ).toEqual(["个人设置", "本次保存"]);
  expect(
    table()
      .getAllByRole("rowheader")
      .map((node) => node.textContent),
  ).toEqual([
    "个人指定方案",
    "个人线路授权（ID）",
    "个人额度与限制",
    "开通时间",
    "到期时间",
    "账号流量周期",
  ]);
  expect(
    table().getByRole("row", { name: "个人额度与限制 未单独覆盖" }),
  ).toBeTruthy();
  expect(
    table().getByRole("row", { name: "开通时间 未单独设置" }),
  ).toBeTruthy();
  expect(table().queryByText("尚未创建")).toBeNull();
  expect(table().queryByText("0001-01-01T00:00:00Z")).toBeNull();
  const summary = screen.getByText("账号标识与完整保存值", {
    selector: "summary",
  });
  await owner.click(() => summary);
  expect(summary.parentElement?.hasAttribute("open")).toBe(true);
  expect(
    JSON.parse(summary.parentElement!.querySelector("pre")!.textContent!),
  ).toEqual(
    JSON.parse(JSON.stringify({ before: null, after: { entitlement: seed } })),
  );
  const explicit: Entitlement = {
    ...seed,
    quotaOverride: 0,
    paused: true,
    cycle: {
      ...seed.cycle,
      mode: "fixed-days",
      days: 7,
      anchor: original.cycle.anchor,
    },
  };
  view.rerender(<EntitlementPolicyComparison resource={resource(explicit)} />);
  expect(
    table().getByRole("row", { name: "个人周期额度 明确不限制（0）" }),
  ).toBeTruthy();
  expect(
    table().getByRole("row", { name: "其余个人额度与限制 未单独覆盖" }),
  ).toBeTruthy();
  expect(table().getByRole("row", { name: "每周期天数 7" })).toBeTruthy();
  expect(table().queryByRole("rowheader", { name: "每月几号" })).toBeNull();
  expect(
    table().getByRole("row", { name: `账号周期起点 ${original.cycle.anchor}` }),
  ).toBeTruthy();
  expect(table().getByRole("row", { name: "暂停平台服务 暂停" })).toBeTruthy();
  const anchorCell = table().getByRole("row", {
    name: `账号周期起点 ${original.cycle.anchor}`,
  });
  const labelId = within(anchorCell).getByRole("rowheader").id;
  expect(within(anchorCell).getByRole("cell").getAttribute("headers")).toBe(
    `${labelId} ${table().getByRole("columnheader", { name: "本次保存" }).id}`,
  );
  view.rerender(
    <EntitlementPolicyComparison
      resource={resource({
        ...explicit,
        cycle: { ...explicit.cycle, mode: "none" },
      })}
    />,
  );
  expect(
    table().getByRole("row", { name: `账号周期起点 ${original.cycle.anchor}` }),
  ).toBeTruthy();
  expect(table().queryByRole("rowheader", { name: "每周期天数" })).toBeNull();
  view.rerender(
    <EntitlementPolicyComparison
      resource={resource({
        ...seed,
        cycle: {
          ...seed.cycle,
          mode: "future-cycle" as Entitlement["cycle"]["mode"],
        },
      })}
    />,
  );
  expect(
    table().getByRole("row", { name: "每月几号 适用性未知，保存值：15" }),
  ).toBeTruthy();
  expect(
    table().getByRole("row", { name: "每周期天数 适用性未知，保存值：23" }),
  ).toBeTruthy();
  expect(
    table().getByRole("row", { name: "账号周期起点 未设置" }),
  ).toBeTruthy();
});

it("reveals the owned reset reason without taking portal focus or resetting usage", async () => {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/admission-status"))
        return json({
          asOf: original.startsAt,
          maxLeaseSeconds: 30,
          onlineIps: [],
          activeStreams: 0,
          entries: [],
        });
      if (String(url).includes("/edit-context/"))
        return json(context(original));
      writes.push(`${init?.method ?? "GET"} ${url}`);
      return json({});
    }),
  );
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mount();
  const reason = await screen.findByRole("textbox", { name: "重置原因" });
  owner.assertActive();
  const section = reason.closest<HTMLElement>("[data-policy-usage-reset]")!;
  const body = reason.closest<HTMLElement>("[data-task-overlay-body]")!;
  expect(section).not.toBeNull();
  expect(reason.closest("form")).toBeNull();
  // jsdom supplies no layout: this checks the real editor wiring against explicit
  // geometry; natural reverse-Tab/paint visibility remains the actual browser gate.
  const rect = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON() {
      return {};
    },
  });
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
    rect(0, 100, 500, 400),
  );
  for (const [key, value] of Object.entries({
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 500,
    clientHeight: 400,
  }))
    vi.spyOn(body, key as "clientLeft", "get").mockReturnValue(value);
  vi.spyOn(reason, "getBoundingClientRect").mockReturnValue(
    rect(20, 600.25, 300, 60),
  );
  body.scrollTop = 0;
  body.scrollLeft = 0;
  await owner.click(() => reason);
  expect(document.activeElement).toBe(reason);
  expect(body.scrollTop).toBe(161);
  expect(body.scrollLeft).toBe(0);
  expect(writes).toEqual([]);
  owner.change(() => reason, { target: { value: "Audit reason" } });
  await userEvent.keyboard("{Enter}");
  owner.assertActive();
  expect((reason as HTMLTextAreaElement).value).toContain("Audit reason");
  expect(writes).toEqual([]);
  const reset = within(section).getByRole("button", { name: "重置本周期用量" });
  expect((reset as HTMLButtonElement).disabled).toBe(false);
  await owner.click(() => reset);
  const confirmation = await screen.findByText("重置「Alice」的本周期用量？");
  owner.assertActive();
  const popup = confirmation.closest<HTMLElement>('[role="alertdialog"]')!;
  expect(popup).not.toBeNull();
  const cancel = within(popup).getByRole("button", { name: /^取\s*消$/ });
  expect(section.contains(cancel)).toBe(false);
  vi.spyOn(cancel, "getBoundingClientRect").mockReturnValue(
    rect(20, 600.25, 100, 30),
  );
  const priorScroll = body.scrollTop;
  await owner.click(() => cancel);
  expect(body.scrollTop).toBe(priorScroll);
  expect(writes).toEqual([]);
  section.setAttribute("inert", "");
  reason.blur();
  body.scrollTop = 0;
  act(() => reason.focus({ preventScroll: true }));
  expect(document.activeElement).toBe(reason);
  expect(body.scrollTop).toBe(0);
  expect(writes).toEqual([]);
});


it("blocks hidden fractional IP precision until corrected before the preview fetch", async () => {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/admission-status")) return json({ asOf: original.startsAt, maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] });
    if (String(url).includes("/edit-context/")) return json(context(original));
    const body = JSON.parse(init!.body as string);
    writes.push(body);
    return json(reviewed(original, body.change.entitlement));
  }));
  mount();
  await openLimits();
  change("个人在线 IP 数上限", "17.0000000000000001");
  await preview();
  expect(writes).toHaveLength(0);
  expect((screen.getByLabelText("个人在线 IP 数上限") as HTMLInputElement).value).toBe("17.0000000000000001");
  change("个人在线 IP 数上限", "18");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.onlineIpLimitOverride).toBe(18);
});


// Public seam: real editor/controls/validation/review, fake HTTP only.
function captureNumericPreview(seed: Entitlement = original) {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/admission-status")) return json({ asOf: seed.startsAt, maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] });
    if (String(url).includes("/edit-context/")) return json(context(seed));
    const body = JSON.parse(init!.body as string);
    writes.push(body);
    return json(reviewed(seed, body.change.entitlement));
  }));
  return writes;
}

it.each([
  ["个人周期额度（GiB）", "50.000000000000000001", "1", "quotaOverride", 1073741824],
  ["个人周期额度（GiB）", "0.0000000001", "0.000000000931322574615478515625", "quotaOverride", 1],
  ["个人入口限速（Mbps）", "1.000000000000000001", "0.000232", "entryRateBpsOverride", 29],
  ["个人入口限速（Mbps）", "0.00000001", "0.000008", "entryRateBpsOverride", 1],
  ["个人并发逻辑流数上限", "3.0000000000000001", "4e0", "connectionLimitOverride", 4],
  ["个人在线 IP 数上限", "9007199254740993", "9007199254740991", "onlineIpLimitOverride", 9007199254740991],
  ["个人周期额度（GiB）", "1e999999999999999999999999", "0e999999999999999999999999", "quotaOverride", 0],
] as const)("preserves %s raw %s until exact correction", async (label, raw, correction, key, expected) => {
  const writes = captureNumericPreview({ ...original, entryRateBpsOverride: 125000, connectionLimitOverride: 3 });
  mount();
  await openLimits();
  change(label, raw);
  await preview();
  expect(writes).toHaveLength(0);
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
  expect(screen.getByRole("button", { name: "预览影响" }).getAttribute("aria-disabled")).toBe("true");
  change(label, correction);
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement[key]).toBe(expected);
});

it.each([
  ["monthly", "每月几号", "1.0000000000000001", "2", "day", 2],
  ["fixed-days", "每周期天数", "23.0000000000000001", "24", "days", 24],
] as const)("blocks hidden precision in %s cycle without discarding other cycle fields", async (mode, label, raw, correction, key, expected) => {
  const writes = captureNumericPreview({ ...original, cycle: { ...original.cycle, mode } });
  mount();
  await screen.findByLabelText("开通时间");
  await owner.click(() => screen.getByRole("button", { name: "高级：账号流量周期" }));
  change(label, raw);
  await preview();
  expect(writes).toHaveLength(0);
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
  change(label, correction);
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.cycle).toEqual({ ...original.cycle, mode, [key]: expected });
});

it("keeps hidden precision after canceling discard, then explicitly discards only that raw edit", async () => {
  const writes = captureNumericPreview();
  const close = vi.fn();
  mount(close);
  await openLimits();
  change("个人在线 IP 数上限", "17.0000000000000001");
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const discard = within(await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" }));
  await owner.click(() => discard.getByRole("button", { name: "继续编辑" }));
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByLabelText("个人在线 IP 数上限") as HTMLInputElement).value).toBe("17.0000000000000001");
  await preview();
  expect(writes).toHaveLength(0);
  await owner.click(() => screen.getByRole("button", { name: "放弃未完成输入，保留当前数值" }));
  expect((screen.getByLabelText("个人在线 IP 数上限") as HTMLInputElement).value).toBe("17");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.onlineIpLimitOverride).toBe(17);
});

it("preserves untouched stored bytes even when the Mbps display cannot reproduce them exactly", async () => {
  const seed = { ...original, quotaOverride: 9007199254740991, entryRateBpsOverride: 9007199254740991 };
  const writes = captureNumericPreview(seed);
  mount();
  await openLimits();
  change("个人在线 IP 数上限", "18");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement).toMatchObject({ quotaOverride: 9007199254740991, entryRateBpsOverride: 9007199254740991, onlineIpLimitOverride: 18 });
});

it("keeps clear, stepping, zero as unlimited and disabled inheritance distinct", async () => {
  const writes = captureNumericPreview({ ...original, entryRateBpsOverride: 125000, connectionLimitOverride: 3 });
  mount();
  await openLimits();
  change("个人入口限速（Mbps）", "");
  await preview();
  expect(writes).toHaveLength(0);
  change("个人入口限速（Mbps）", "0");
  change("个人在线 IP 数上限", "0");
  await owner.click(() => screen.getByLabelText("个人并发逻辑流数上限"));
  await userEvent.keyboard("{ArrowUp}");
  owner.assertActive();
  expect((screen.getByLabelText("个人并发逻辑流数上限") as HTMLInputElement).value).toBe("4");
  await owner.click(() => screen.getByRole("checkbox", { name: "覆盖个人周期额度（GiB）" }));
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement).toMatchObject({ quotaOverride: null, entryRateBpsOverride: 0, onlineIpLimitOverride: 0, connectionLimitOverride: 4 });
});


it("settles exact Mbps residue and allows its displayed spelling to normalize", async () => {
  const writes = captureNumericPreview({ ...original, entryRateBpsOverride: 125000 });
  mount();
  await openLimits();
  change("个人入口限速（Mbps）", "0.00098400");
  // The exact form value differs from the control's float emission, so the
  // existing controlled effect renders 123 / 125000, not the original zeros.
  await waitFor(() => expect((screen.getByLabelText("个人入口限速（Mbps）") as HTMLInputElement).value).toBe("0.000984"));
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.entryRateBpsOverride).toBe(123);
});

it("keeps oversized pasted input pending without losing the editor", async () => {
  const writes = captureNumericPreview();
  mount();
  await openLimits();
  const raw = "1".repeat(4097);
  change("个人在线 IP 数上限", raw);
  await preview();
  expect(writes).toHaveLength(0);
  expect((screen.getByLabelText("个人在线 IP 数上限") as HTMLInputElement).value).toBe(raw);
  change("个人在线 IP 数上限", "18");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.onlineIpLimitOverride).toBe(18);
});

it("explicit raw discard keeps the visibly reported current value, not necessarily the opening value", async () => {
  const writes = captureNumericPreview();
  mount();
  await openLimits();
  change("个人在线 IP 数上限", "18.0000000000000001");
  expect(screen.getByText("个人在线 IP 数上限的输入「18.0000000000000001」尚未完成；当前数值为 18。")).toBeTruthy();
  await preview();
  expect(writes).toHaveLength(0);
  await owner.click(() => screen.getByRole("button", { name: "放弃未完成输入，保留当前数值" }));
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes[0].change.entitlement.onlineIpLimitOverride).toBe(18);
});

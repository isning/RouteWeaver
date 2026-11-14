// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";

const clients: QueryClient[] = [];
const unexpectedRequests: string[] = [];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

function mountWorkspace(
  status: string | undefined,
  inventory: { profiles: Profile[]; outputs: Output[] } = {
    profiles: [],
    outputs: [],
  },
) {
  const responses: Record<string, unknown> = {
    "/api/me/overview": {
      status,
      accountingPending: status === "accounting-pending",
      quotaBytes: 0,
      user: { id: "ordinary-user", name: "个人账号" },
      usage: { rawBytes: 0, weightedBytes: 0 },
      routes: [],
    },
    "/api/me/profiles": inventory.profiles,
    "/api/me/outputs": inventory.outputs,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if ((init?.method || "GET") === "GET" && Object.hasOwn(responses, path))
        return json(responses[path]);
      unexpectedRequests.push(`${init?.method || "GET"} ${path}`);
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}

async function usageCard() {
  const heading = await screen.findByRole("heading", { name: "平台服务用量" });
  const section = heading.closest<HTMLElement>('[data-slot="card"]');
  expect(section).not.toBeNull();
  return within(section!);
}

beforeEach(() => {
  unexpectedRequests.length = 0;
  history.replaceState(null, "", "#subscriptions");
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  expect(unexpectedRequests).toEqual([]);
});

it.each([
  ["active", "已开通"],
  ["paused", "平台服务已暂停"],
  ["disabled", "账号已停用"],
  ["expired", "已到期"],
  ["not-started", "未到开通时间"],
  ["ambiguous", "用户组方案冲突"],
  ["service-missing", "服务方案不存在"],
  ["exhausted", "额度已用尽"],
  ["accounting-pending", "等待统计同步"],
])("names the ordinary account's %s policy state", async (status, label) => {
  mountWorkspace(status);
  const card = await usageCard();
  expect(card.getByText(label, { exact: true, selector: '[data-slot="badge"]' })).toBeTruthy();
  expect(card.queryByText(status, { exact: true })).toBeNull();
  if (status !== "active") expect(card.queryByText("已开通")).toBeNull();
});

it.each<{ status: string | undefined; label: string }>([
  { status: "future-policy-state", label: "future-policy-state" },
  { status: "", label: "未设置" },
  { status: undefined, label: "未设置" },
])("preserves the existing fallback for $status", async ({ status, label }) => {
  mountWorkspace(status);
  const card = await usageCard();
  expect(card.getByText(label, { exact: true, selector: '[data-slot="badge"]' })).toBeTruthy();
  expect(card.queryByText("已开通")).toBeNull();
});

it("names an opened service even with no assigned routes, without claiming connection readiness", async () => {
  mountWorkspace("active");
  const card = await usageCard();
  expect(card.getByText("已开通")).toBeTruthy();
  expect(card.getAllByText("不限额")).toHaveLength(2);
  expect(card.getByRole("heading", { name: "本周期剩余额度" })).toBeTruthy();
  expect(card.getByText("总额度")).toBeTruthy();
  expect(card.queryByText("生效中")).toBeNull();
  expect(card.queryByText(/线路可用|连接正常|已连接/)).toBeNull();
  expect(screen.queryByText(/平台提供的线路/)).toBeNull();
});

it("keeps published and revoked client subscription states separate from account policy", async () => {
  const profile = { ...emptyProfile(), id: "personal", name: "日常分流" };
  const outputs: Output[] = [
    {
      id: "laptop",
      name: "电脑订阅",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    },
    {
      id: "phone",
      name: "手机订阅",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "revoked",
    },
  ];
  mountWorkspace("paused", { profiles: [profile], outputs });
  const card = await usageCard();
  expect(card.getByText("平台服务已暂停")).toBeTruthy();
  const published = within(
    await screen.findByRole("group", { name: "客户端订阅 电脑订阅" }),
  );
  const revoked = within(
    await screen.findByRole("group", { name: "客户端订阅 手机订阅" }),
  );
  expect(published.getByText("已发布", { exact: true })).toBeTruthy();
  expect(revoked.getByText("已撤销", { exact: true })).toBeTruthy();
  expect(published.getByRole("button", { name: "获取订阅" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(revoked.getByRole("button", { name: "获取订阅" })).toHaveProperty(
    "disabled",
    true,
  );
});

it("gives paused platform service a next step without granting restoration or changing personal subscriptions", async () => {
  mountWorkspace("paused");
  const card = await usageCard();
  expect(
    card.getByText("如需恢复平台服务，请联系管理员检查服务授权。", {
      exact: true,
    }),
  ).toBeTruthy();
  expect(
    card.queryByRole("button", { name: /恢复平台服务|自动恢复/ }),
  ).toBeNull();
});

it.each([
  "active",
  "disabled",
  "expired",
  "exhausted",
  "future-policy-state",
  undefined,
])("does not invent paused-service recovery for %s", async (status) => {
  mountWorkspace(status);
  const card = await usageCard();
  expect(
    card.queryByText("如需恢复平台服务，请联系管理员检查服务授权。", {
      exact: true,
    }),
  ).toBeNull();
});


for (const role of ["user", "admin"]) {
  it.each(["subscriptions", "profiles", "outputs"])(`allows ${role} #%s inventory entry without converting a failed read into empty`, async (hash) => {
    history.replaceState(null, "", `#${hash}`);
    const endpoint = hash === "outputs" ? "/api/me/outputs" : "/api/me/profiles";
    const failure = hash === "outputs" ? "暂时无法加载客户端订阅" : "暂时无法加载分流配置";
    const retry = hash === "outputs" ? "重新核对订阅" : "重试配置";
    let reads = 0;
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") throw new Error("Read-only inventory case");
      if (url === "/api/auth/me") return json({ user: { id: "inventory-reader", name: "Reader", role }, csrfToken: "synthetic" });
      if (url === endpoint) {
        reads++;
        if (reads === 1) return new Promise<Response>((resolve) => { release = resolve; });
        return json([]);
      }
      if (url === "/api/me/overview") return json({ user: { id: "inventory-reader", name: "Reader" }, status: "active", quotaBytes: 0, usage: { rawBytes: 0, weightedBytes: 0 }, routes: [] });
      if (["/api/me/profiles", "/api/me/outputs"].includes(url)) return json([]);
      unexpectedRequests.push(url); throw new Error(`Unexpected inventory request ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
    render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
    const main = await screen.findByRole("main");
    await within(main).findByRole("heading", { name: "我的订阅", level: 1 });
    await within(main).findByRole("status", { name: "正在加载配置与客户端订阅" });
    expect(within(main).queryByText("暂无订阅")).toBeNull();
    await act(async () => { release(new Response(JSON.stringify({ message: "Inventory unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } })); });
    await within(main).findByText(failure);
    expect(within(main).queryByText("暂无订阅")).toBeNull();
    await userEvent.click(within(main).getByRole("button", { name: retry }));
    await within(main).findByText("暂无订阅");
    expect(within(main).queryByText(failure)).toBeNull();
    expect(location.hash).toBe(`#${hash}`);
    expect(reads).toBe(2);
  });
}

it("keeps one platform usage context and its visible details when the layout width changes", async () => {
  mountWorkspace("paused");
  const heading = await screen.findByRole("heading", { name: "平台服务用量" });
  const context = heading.closest("aside");
  expect(context).not.toBeNull();
  expect(within(context!).queryByRole("button", { name: "用量与周期明细" })).toBeNull();
  const details = within(context!).getByRole("region", { name: "用量与周期明细" });
  expect(within(context!).getByText("本周期实际流量")).toBeTruthy();
  fireEvent(window, new Event("resize"));
  expect(screen.getAllByRole("heading", { name: "平台服务用量" })).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "平台服务用量" })).toBe(heading);
  expect(within(context!).getByRole("region", { name: "用量与周期明细" })).toBe(details);
  expect(within(context!).getByText("如需恢复平台服务，请联系管理员检查服务授权。")).toBeTruthy();
  expect(unexpectedRequests).toEqual([]);
});

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import Workspace from "./App";
import { SubscriptionsPage } from "./Subscriptions";
import { CollectionsPage, SourcesPage } from "./Sources";

beforeAll(async () => {
  // This shell-labeling contract is not a cold Vite compilation deadline.
  // Actual pending server-module delivery and inventory ordering are covered
  // separately in server-route-import.dom.test.tsx; keep RTL waits unchanged.
  await import("./Infrastructure");
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(children: ReactNode) {
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
function viewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: narrow && query === "(max-width: 1023px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
beforeEach(() => {
  // Ant Design test-mode UUIDs collide across nested dialog overlays.
  // Use production-style unique IDs, as in the public-onboarding tests.
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#subscriptions");
  viewport(false);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/auth/me")
        ? json({
            user: { id: "user", name: "User", role: "member" },
            csrfToken: "csrf",
          })
        : String(url).endsWith("/me/overview")
          ? json({
              status: "active",
              quotaBytes: 1073741824,
              user: { id: "user", name: "User" },
              usage: { rawBytes: 0, weightedBytes: 0 },
              routes: [],
            })
          : json([]),
    ),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("opens narrow-screen navigation as a dismissible dialog rather than exposing hidden navigation", async () => {
  viewport(true);
  mount(<Workspace />);
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "我的订阅" });
  expect(screen.queryByRole("navigation")).toBeNull();
  const trigger = screen.getByRole("button", { name: "打开导航" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "导航" });
  expect(
    within(dialog).getByRole("navigation", { name: "工作空间导航" }),
  ).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("groups subscription materials in one navigation and opens the current destination", async () => {
  mount(<Workspace />);
  const user = userEvent.setup();
  const navigation = await screen.findByRole("navigation", {
    name: "工作空间导航",
  });
  expect(
    within(navigation).getByRole("button", { name: "我的订阅" }),
  ).toBeTruthy();
  expect(
    within(navigation).queryByRole("button", { name: "客户端配置" }),
  ).toBeNull();
  expect(
    within(navigation).queryByRole("button", { name: "发布管理" }),
  ).toBeNull();
  expect(
    screen.getByRole("region", { name: "分流配置与客户端订阅" }),
  ).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  const materials = screen.getByRole("button", { name: "订阅素材" });
  expect(materials.getAttribute("aria-expanded")).toBe("false");
  await user.click(screen.getByText("订阅素材", { exact: true }));
  await user.click(screen.getByRole("button", { name: "规则资源" }));
  await screen.findByRole("heading", { name: "规则资源" });
  expect(location.hash).toBe("#resources");
  expect(
    screen
      .getByRole("button", { name: "规则资源" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it("gives first-time users an actionable setup instead of a disabled subscription action", async () => {
  const navigate = vi.fn();
  mount(<SubscriptionsPage navigate={navigate} />);
  const user = userEvent.setup();
  const setup = await screen.findByRole("button", { name: "新建分流配置" });
  expect(screen.queryByRole("button", { name: "获取订阅" })).toBeNull();
  await user.click(setup);
  await screen.findByRole("heading", { name: "新建分流配置" });
  expect(screen.getByRole("tab", { name: "分流规则" })).toBeTruthy();
  const name = screen.getByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "My continuing draft" } });
  await user.click(screen.getByRole("button", { name: "添加来源" }));
  const dialog = await screen.findByRole("dialog", {
    name: "添加订阅来源",
  });
  expect(within(dialog).getByLabelText("来源名称")).toBeTruthy();
  expect(within(dialog).getByLabelText("节点链接或配置内容")).toBeTruthy();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect((name as HTMLInputElement).value).toBe("My continuing draft");
  expect(navigate).not.toHaveBeenCalled();
});

it("does not offer a cached subscription link when the current access check rejects it", async () => {
  const errors = vi.spyOn(console, "error");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url) === "/api/me/profiles") return json([]);
      if (/^\/api\/me\/outputs\/[^/]+\/status$/.test(String(url)))
        return json({ draftComparison: { state: "unavailable" } });
      if (String(url).endsWith("/access"))
        return json(
          {
            detail:
              "This subscription is currently unavailable. Please check your access.",
          },
          409,
        );
      if (String(url).endsWith("/outputs"))
        return json([
          {
            id: "out",
            profileId: "unavailable-profile",
            name: "Work",
            status: "published",
            target: { adapterId: "mihomo", version: "1.19.32" },
            mode: "full",
            feedPath: "/feed/stale-credential",
          },
        ]);
      return json({
        status: "active",
        quotaBytes: 1073741824,
        user: { id: "user", name: "User" },
        usage: { rawBytes: 0, weightedBytes: 0 },
        routes: [],
      });
    }),
  );
  mount(<SubscriptionsPage navigate={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(
    (await screen.findAllByRole("button", { name: "获取订阅" }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "获取「Work」" });
  await within(dialog).findByText("暂时无法获取此订阅，请稍后重试。");
  expect(dialog.textContent).not.toContain(
    "This subscription is currently unavailable. Please check your access.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "复制订阅链接" }),
  ).toBeNull();
  expect(within(dialog).queryByRole("link", { name: "下载配置" })).toBeNull();
  expect(within(dialog).queryByLabelText("订阅链接")).toBeNull();
  expect(within(dialog).getByRole("button", { name: /重\s*试/ })).toBeTruthy();
  expect(dialog.textContent).not.toContain("stale-credential");
  expect(errors.mock.calls.flat().join(" ")).not.toContain(
    'unique "key" prop',
  );
});

it("keeps source deletion under More and names references that must be removed first", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      requests.push(`${init?.method || "GET"} ${url}`);
      if (String(url).endsWith("/collections"))
        return json([
          {
            id: "collection",
            name: "Daily collection",
            sources: [{ sourceId: "source" }],
            steps: [],
          },
        ]);
      if (String(url).endsWith("/profiles"))
        return json([
          { id: "profile", name: "Work profile", sourceIds: ["source"] },
        ]);
      return json([
        { id: "source", name: "My airport", kind: "url", enabled: true },
      ]);
    }),
  );
  mount(<SourcesPage />);
  const user = userEvent.setup();
  const sourceMenu = await screen.findByRole("button", { name: "更多操作 My airport" });
  expect(screen.queryByRole("button", { name: "删除 My airport" })).toBeNull();
  await user.click(sourceMenu);
  expect(screen.getByRole("menuitem", { name: "刷新来源 My airport" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "编辑来源 My airport" })).toBeTruthy();
  await user.click(await screen.findByRole("menuitem", { name: "删除来源" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("「My airport」仍在使用");
  expect(within(dialog).getByText("集合：Daily collection")).toBeTruthy();
  expect(within(dialog).getByText("客户端配置：Work profile")).toBeTruthy();
  expect(dialog.textContent).toContain("先从以下位置移除此来源，再删除");
  expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
});

it("puts published subscriptions before usage and retrieves the explicitly selected subscription", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url) === "/api/me/profiles") return json([]);
      if (/^\/api\/me\/outputs\/[^/]+\/status$/.test(String(url)))
        return json({ draftComparison: { state: "unavailable" } });
      requests.push(String(url));
      if (String(url).endsWith("/outputs"))
        return json([
          {
            id: "work",
            profileId: "unavailable-profile",
            name: "Work",
            status: "published",
            target: { adapterId: "mihomo" },
            mode: "full",
          },
          {
            id: "travel",
            profileId: "unavailable-profile",
            name: "Travel",
            status: "published",
            target: { adapterId: "sing-box" },
            mode: "full",
          },
        ]);
      if (String(url).endsWith("/access"))
        return json({
          feedURL: "https://subscriptions.example.com/feed/current-travel",
          feedPath: "/feed/current-travel",
        });
      return json({
        status: "active",
        quotaBytes: 1073741824,
        user: { id: "user", name: "User" },
        usage: { rawBytes: 0, weightedBytes: 0 },
        routes: [],
      });
    }),
  );
  mount(<SubscriptionsPage navigate={vi.fn()} />);
  const user = userEvent.setup();
  const subscriptionHeading = await screen.findByRole("region", {
    name: "分流配置与客户端订阅",
  });
  const usageHeading = await screen.findByRole("heading", {
    name: "平台服务用量",
  });
  expect(
    subscriptionHeading.compareDocumentPosition(usageHeading) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const travel = await screen.findByRole("group", {
    name: "客户端订阅 Travel",
  });
  await user.click(within(travel).getByRole("button", { name: "获取订阅" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("获取「Travel」")).toBeTruthy();
  expect(
    ((await screen.findByLabelText("订阅链接")) as HTMLInputElement).value,
  ).toBe("https://subscriptions.example.com/feed/current-travel");
  expect(requests).toContain("/api/me/outputs/travel/access");
  expect(requests).not.toContain("/api/me/outputs/work/access");
});

it("retains collection edits when a user cancels closing the processing drawer", async () => {
  mount(<CollectionsPage />);
  const user = userEvent.setup();
  await user.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  await user.type(screen.getByLabelText("集合名称"), "Keep collection edits");
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await screen.findAllByText("放弃尚未保存的集合修改？");
  await user.click(screen.getByRole("button", { name: "继续编辑" }));
  expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
    "Keep collection edits",
  );
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getAllByRole("button", { name: "新建集合" })[0]);
  expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
    "",
  );
});

it("labels route grants as authorization rather than claiming runtime availability", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url) === "/api/me/profiles") return json([]);
      if (/^\/api\/me\/outputs\/[^/]+\/status$/.test(String(url)))
        return json({ draftComparison: { state: "unavailable" } });
      if (String(url).endsWith("/outputs")) return json([]);
      return json({
        status: "active",
        user: { id: "user", name: "User" },
        usage: { rawBytes: 0, weightedBytes: 0 },
        cycle: { nextReset: "2099-12-01T00:00:00+08:00", timezone: "UTC+8" },
        routes: [
          { id: "draft-route", name: "Draft route", rateMicros: 1500000 },
          { id: "long-route", name: "跨区域协作线路 LongRemoteWorkspaceConnection", rateMicros: 1000000 },
          { id: "backup-route", name: "备用线路 BackupInternationalRemoteWorkspaceConnection", rateMicros: 500000 },
        ],
      });
    }),
  );
  mount(<SubscriptionsPage navigate={vi.fn()} />);
  await screen.findByRole("region", {
    name: "平台提供的线路 3 条",
  });
  expect(screen.queryByRole("button", { name: "可用平台线路 · 1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "平台提供的线路 3 条" })).toBeNull();
  for (const name of ["Draft route", "跨区域协作线路 LongRemoteWorkspaceConnection", "备用线路 BackupInternationalRemoteWorkspaceConnection"]) {
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  }
  for (const multiplier of ["1.5×", "1×", "0.5×"]) {
    expect(screen.getByText(multiplier, { exact: true })).toBeTruthy();
  }
  const resetValue = screen.getByText("下次重置", { exact: true }).parentElement!;
  expect(resetValue.querySelector(".usage-reset-date")?.textContent).toContain("2099");
  expect(resetValue.querySelector(".usage-reset-countdown")?.textContent).toMatch(/还有 .+/);
  expect(screen.getByText("已为你的账号开通", { exact: true })).toBeTruthy();
  expect(screen.queryByText(/当前使用|当前已选|线路在线/)).toBeNull();
});

it("shows the converted collection result first and keeps original stages available", async () => {
  const original = {
    id: "node",
    name: "Original UK",
    connection: { protocol: "vless" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/collections/preview"))
        return json({
          endpoints: [{ ...original, name: "Airport · Original UK" }],
          stages: [
            { scope: "raw", sourceId: "airport", endpoints: [original] },
          ],
        });
      if (String(url).endsWith("/sources"))
        return json([
          {
            id: "airport",
            name: "Airport",
            kind: "text",
            enabled: true,
            endpoints: [original],
            snapshot: { endpoints: [original] },
          },
        ]);
      if (String(url).endsWith("/collections"))
        return json([
          {
            id: "daily",
            name: "Daily",
            sources: [{ sourceId: "airport", steps: [] }],
            steps: [],
          },
        ]);
      return json([]);
    }),
  );
  mount(<CollectionsPage />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /Daily.*编辑集合/ }),
  );
  await user.click(screen.getByRole("button", { name: "预览处理结果" }));
  expect(
    (await screen.findByRole("tab", { name: "最终结果" })).getAttribute(
      "aria-selected",
    ),
  ).toBe("true");
  expect(
    screen.getByRole("cell", { name: "Airport · Original UK" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "原始输入 Airport" }));
  expect(screen.getByRole("cell", { name: "Original UK" })).toBeTruthy();
});

it("distinguishes same-name connections and identifies each processing stage", async () => {
  const nodes = [
    {
      id: "one",
      name: "Same UK",
      connection: { protocol: "socks", host: "198.51.100.50", port: 1080 },
    },
    {
      id: "two",
      name: "Same UK",
      connection: { protocol: "socks", host: "2001:db8::51", port: 1081 },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/collections/preview"))
        return json({
          endpoints: nodes,
          stages: [
            { scope: "aggregate", stepId: "rename", endpoints: nodes },
            { scope: "aggregate", stepId: "dedup", endpoints: nodes },
          ],
        });
      if (String(url).endsWith("/collections"))
        return json([
          {
            id: "daily",
            name: "Daily",
            sources: [],
            steps: [
              {
                id: "rename",
                kind: "rename",
                enabled: true,
                template: "{name}",
              },
              { id: "dedup", kind: "deduplicate", enabled: true },
            ],
          },
        ]);
      return json([]);
    }),
  );
  mount(<CollectionsPage />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /Daily.*编辑集合/ }),
  );
  await user.click(screen.getByRole("button", { name: "预览处理结果" }));
  expect(
    await screen.findByRole("cell", { name: "198.51.100.50:1080" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("cell", { name: "[2001:db8::51]:1081" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "合并后 第 1 步：重新命名" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "合并后 第 2 步：去除重复连接" }),
  ).toBeTruthy();
});

it("does not label platform administration as a private workspace", async () => {
  history.replaceState(null, "", "#servers");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/auth/me")
        ? json({
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "csrf",
          })
        : json([]),
    ),
  );
  mount(<Workspace />);
  expect(
    await screen.findByRole("heading", { name: "服务器", level: 1 }),
  ).toBeTruthy();
  expect(screen.queryByText("私人工作空间")).toBeNull();
  expect(screen.getByRole("navigation", { name: "工作空间导航" })).toBeTruthy();
});

it("keeps collection identity associated with its keyboard-operable edit task", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) =>
    String(url).endsWith("/collections")
      ? json([{ id: "daily", name: "Daily long collection name", sources: [], steps: [] }])
      : json([]),
  ));
  mount(<CollectionsPage />);
  const tile = await screen.findByRole("button", { name: /Daily long collection name.*0 个来源.*0 个聚合步骤.*编辑集合/ });
  expect(tile.querySelector("button, a, input")).toBeNull();
  expect(within(screen.getByRole("article", { name: "Daily long collection name" })).getByRole("heading", { name: "Daily long collection name" })).toBeTruthy();
  tile.focus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Daily long collection name" });
  expect(within(dialog).getByLabelText("集合名称")).toHaveProperty("value", "Daily long collection name");
});

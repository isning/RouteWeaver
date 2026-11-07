// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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
import { AdminPage } from "./Admin";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(children: ReactNode = <Workspace />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 15000 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#nodes");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
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
const nodes = [
  {
    id: "a",
    name: "Alpha endpoint",
    host: "a.example.test",
    port: 1080,
    protocol: "socks",
  },
  {
    id: "b",
    name: "Beta endpoint",
    host: "b.example.test",
    port: 1080,
    protocol: "socks",
  },
];
function fixture(
  write?: (url: string, values: Record<string, unknown>) => Promise<Response>,
  readSettings?: (
    count: number,
    values: Record<string, unknown>,
  ) => Promise<Response>,
  quotaBytes = 0,
) {
  let settings = {
    name: "RouteWeaver",
    timezone: "UTC+8",
    registration: "invite",
  };
  let settingsReads = 0;
  const writes: { url: string; values: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" || init?.method === "POST") {
        const values = JSON.parse(String(init.body));
        writes.push({ url, values });
        const response = write ? await write(url, values) : json(values);
        if (url === "/api/settings" && response.ok)
          settings = await response.clone().json();
        return response;
      }
      if (url === "/api/auth/me")
        return json({
          user: { id: "admin", name: "Admin", role: "admin" },
          csrfToken: "admin-csrf",
        });
      if (url === "/api/state")
        return json({
          nodes,
          users: [
            {
              id: "user",
              name: "Example user",
              enabled: true,
              quotaBytes,
              usedBytes: 0,
            },
          ],
          routes: [
            {
              id: "route",
              name: "Example legacy route",
              engine: "sing-box",
              hops: ["a"],
              userIds: [],
            },
          ],
          capabilities: [{ id: "sing-box", name: "sing-box", maxHops: 2 }],
          revisions: [],
        });
      if (url === "/api/settings") {
        settingsReads++;
        return readSettings
          ? readSettings(settingsReads, settings)
          : json(settings);
      }
      if (url === "/api/admin/subscription-origin")
        return json({
          revision: 1,
          configuredRevision: 1,
          draftOrigin: "",
          effectiveRevision: 1,
          effectiveOrigin: "",
          defaultOrigin: "",
          currentLinkExample: "/feed/{existing-token}",
          proposedLinkExample: "/feed/{existing-token}",
          verificationStatus: "not-required",
          tokensUnchanged: true,
        });
      return json([]);
    }),
  );
  return {
    writes,
    get settingsReads() {
      return settingsReads;
    },
  };
}
const cancel = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /^取\s*消$/ });
const save = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: /^保\s*存$/ });
async function openNode(name = "Alpha endpoint") {
  await userEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^${name}`) }),
  );
  return screen.findByRole("dialog", { name: "编辑端点" });
}
async function nav(group: string, name: string) {
  if (screen.queryByRole("dialog")) {
    // Radix correctly makes sidebar interaction inert. Exercise the existing
    // external hash-navigation guard while the asynchronous editor is pending.
    const pages: Record<string, string> = { 用户: "users", 连接端点: "nodes" };
    if (!pages[name])
      throw new Error(`Missing external navigation target: ${name}`);
    await act(async () => {
      window.location.hash = pages[name];
    });
    return;
  }
  const summary = screen.getByRole("button", { name: group });
  if (summary.getAttribute("aria-expanded") === "false")
    await userEvent.click(summary);
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "工作空间导航" })).getByRole(
      "button",
      { name },
    ),
  );
}

it("retains edited endpoint Cancel and discards only after explicit confirmation, then reopens cleanly", async () => {
  fixture();
  mount(<AdminPage page="nodes" />);
  let dialog = await openNode();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "端点名称" }), {
    target: { value: "Unsaved Alpha" },
  });
  await userEvent.click(cancel(dialog));
  let review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
    ).toBeNull(),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "端点名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Unsaved Alpha");
  await userEvent.click(cancel(dialog));
  review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑端点" })).toBeNull(),
  );
  dialog = await openNode();
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "端点名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Alpha endpoint");
  await userEvent.click(cancel(dialog));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑端点" })).toBeNull(),
  );
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
});

it("protects user edits from Escape dismissal", async () => {
  fixture();
  mount(<AdminPage page="users" />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Example user" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "编辑用户" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Unsaved user" },
  });
  await userEvent.click(
    within(dialog).getByRole("textbox", { name: "用户名称" }),
  );
  await userEvent.keyboard("{Escape}");
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "用户名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Unsaved user");
});

it("protects legacy route edits on drawer close", async () => {
  fixture();
  mount(<AdminPage page="legacy-routes" />);
  await userEvent.click(
    await screen.findByRole("button", { name: /^Example legacy route/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "编辑链路配置 Example legacy route",
  });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "链路配置名称" }),
    {
      target: { value: "Unsaved route" },
    },
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: /close|关闭/i }),
  );
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的链路配置修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "链路配置名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Unsaved route");
});

it("locks endpoint dismissal while saving, preserves failed input and allows a successful retry", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  const state = fixture(async (_url, values) =>
    ++attempt === 1 ? pending : json(values),
  );
  mount(<AdminPage page="nodes" />);
  const dialog = await openNode();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "端点名称" }), {
    target: { value: "Saved Alpha" },
  });
  await userEvent.click(save(dialog));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(cancel(dialog).hasAttribute("disabled")).toBe(true);
  expect(
    within(dialog)
      .getByRole("textbox", { name: "端点名称" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(cancel(dialog));
  expect(screen.getByRole("dialog", { name: "编辑端点" })).toBeTruthy();
  await act(async () => {
    release(json({ error: "save temporarily unavailable" }, 503));
    await pending;
  });
  await waitFor(() =>
    expect(save(dialog).hasAttribute("disabled")).toBe(false),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "端点名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Saved Alpha");
  await userEvent.click(save(dialog));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑端点" })).toBeNull(),
  );
  expect(state.writes).toHaveLength(2);
});

it("does not let an older endpoint save dismiss a new editor after explicit navigation", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const state = fixture(() => pending);
  mount();
  const first = await openNode();
  fireEvent.change(within(first).getByRole("textbox", { name: "端点名称" }), {
    target: { value: "Saved Alpha" },
  });
  await userEvent.click(save(first));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  await nav("用户与权限", "用户");
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "放弃修改并离开" }),
  );
  await screen.findByRole("heading", { name: "用户" });
  await nav("网络资源", "连接端点");
  const second = await openNode("Beta endpoint");
  fireEvent.change(within(second).getByRole("textbox", { name: "端点名称" }), {
    target: { value: "Unsaved Beta" },
  });
  await act(async () => {
    release(json({ ...nodes[0], name: "Saved Alpha" }));
    await pending;
  });
  await waitFor(() =>
    expect(
      (
        within(screen.getByRole("dialog", { name: "编辑端点" })).getByRole(
          "textbox",
          { name: "端点名称" },
        ) as HTMLInputElement
      ).value,
    ).toBe("Unsaved Beta"),
  );
});

it("shows fixed platform policies as values and saves their complete payload with the edited name", async () => {
  const state = fixture();
  mount(<AdminPage page="settings" />);
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const name = await screen.findByRole("textbox", { name: "平台名称" });
  expect(screen.queryByRole("combobox", { name: "账号注册" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "默认时区" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "基本设置" })).toBeNull();
  const settings = screen.getByRole("form", { name: "平台基本设置" });
  expect(within(settings).getByText("账号注册").tagName).toBe("DT");
  expect(within(settings).getByText("仅受邀用户").tagName).toBe("DD");
  expect(within(settings).getByText("默认时区").tagName).toBe("DT");
  expect(within(settings).getByText("UTC+8").tagName).toBe("DD");
  for (const policy of [
    { label: "账号注册", help: "新账号须由管理员生成邀请后创建。", value: "仅受邀用户" },
    { label: "默认时区", help: "流量周期按 UTC+8 计算；具体重置方式在服务方案或用户授权中设置。", value: "UTC+8" },
  ]) {
    const term = within(settings).getByText(policy.label, { exact: true });
    expect(term.tagName).toBe("DT");
    expect(term.textContent?.trim()).toBe(policy.label);
    const value = term.nextElementSibling!;
    const help = value.nextElementSibling!;
    expect(value.tagName).toBe("DD");
    expect(value.textContent?.trim()).toBe(policy.value);
    expect(help.tagName).toBe("DD");
    expect(help.textContent?.trim().replace(/\s+/g, " ")).toBe(policy.help);
  }
  expect(state.writes).toEqual([]);
  fireEvent.change(name, { target: { value: "Clear platform" } });
  await userEvent.click(within(settings).getByRole("button", { name: "保存设置" }));
  await screen.findAllByText("平台设置已保存");
  expect(state.writes).toEqual([{ url: "/api/settings", values: {
    name: "Clear platform", registration: "invite", timezone: "UTC+8",
  } }]);
  expect((name as HTMLInputElement).value).toBe("Clear platform");
  expect(within(settings).getByText("仅受邀用户")).toBeTruthy();
  expect(within(settings).getByText("UTC+8")).toBeTruthy();
});

it("navigates settings sections without leaving or saving either dirty draft", async () => {
  const state = fixture();
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const name = await screen.findByRole("textbox", { name: "平台名称" });
  fireEvent.change(name, { target: { value: "Retained local name" } });
  const domain = await screen.findByRole("textbox", { name: "订阅域名草稿" });
  fireEvent.change(domain, { target: { value: "https://draft.example.test" } });
  const before = { hash: location.hash, length: history.length };
  const index = screen.getByRole("navigation", { name: "本页设置" });
  const go = within(index).getByRole("button", { name: "前往订阅域名" });
  go.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("订阅域名设置");
  expect(location.hash).toBe(before.hash);
  expect(history.length).toBe(before.length);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect((name as HTMLInputElement).value).toBe("Retained local name");
  expect((domain as HTMLInputElement).value).toBe("https://draft.example.test");
  expect(state.writes).toEqual([]);
  expect(screen.queryByText("用于记录此控制平面的名称。")).toBeNull();
  expect(screen.getByText("新账号须由管理员生成邀请后创建。")).toBeTruthy();
  expect(screen.getByText("流量周期按 UTC+8 计算；具体重置方式在服务方案或用户授权中设置。")).toBeTruthy();
});

it("protects unsaved basic settings through real workspace navigation", async () => {
  fixture();
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const field = await screen.findByRole("textbox", { name: "平台名称" });
  fireEvent.change(field, { target: { value: "Unsaved platform" } });
  await nav("用户与权限", "用户");
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  expect(
    (screen.getByRole("textbox", { name: "平台名称" }) as HTMLInputElement)
      .value,
  ).toBe("Unsaved platform");
});

it("returns to the authoritative saved settings without a stale cached name", async () => {
  const state = fixture();
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "平台名称" }), {
    target: { value: "Accepted platform" },
  });
  await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findAllByText("平台设置已保存");
  await nav("用户与权限", "用户");
  await screen.findByRole("heading", { name: "用户" });
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
  await nav("运维与设置", "平台设置");
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "平台名称",
      })) as HTMLInputElement
    ).value,
  ).toBe("Accepted platform");
  expect(state.settingsReads).toBe(1);
});

it("keeps newer settings edits dirty when an older save succeeds", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const state = fixture(() => pending);
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const field = await screen.findByRole("textbox", { name: "平台名称" });
  fireEvent.change(field, { target: { value: "Saved platform" } });
  await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  fireEvent.change(field, { target: { value: "Newer unsaved platform" } });
  await act(async () => {
    release(
      json({
        name: "Saved platform",
        timezone: "UTC+8",
        registration: "invite",
      }),
    );
    await pending;
  });
  await screen.findAllByText("提交的设置已保存，当前修改尚未保存");
  expect((field as HTMLInputElement).value).toBe("Newer unsaved platform");
  await nav("用户与权限", "用户");
  expect(
    await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeTruthy();
});

it("distinguishes no matching users and clears the search without creating another user", async () => {
  const state = fixture();
  mount(<AdminPage page="users" />);
  await screen.findByRole("button", { name: "Example user" });
  fireEvent.change(screen.getByRole("textbox", { name: "搜索用户" }), {
    target: { value: "not a user" },
  });
  expect(await screen.findByText("没有匹配的用户")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(screen.getByRole("button", { name: "Example user" })).toBeTruthy();
  expect(state.writes).toHaveLength(0);
});

it("fences a pre-save settings read so its late result cannot replace accepted settings", async () => {
  let release!: (response: Response) => void;
  const oldRead = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const state = fixture(undefined, async (count, values) =>
    count === 2 ? oldRead : json(values),
  );
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const field = await screen.findByRole("textbox", { name: "平台名称" });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(state.settingsReads).toBe(2));
  fireEvent.change(field, { target: { value: "Accepted after refresh" } });
  await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findAllByText("平台设置已保存");
  await act(async () => {
    release(
      json({ name: "RouteWeaver", timezone: "UTC+8", registration: "invite" }),
    );
    await oldRead;
  });
  await nav("用户与权限", "用户");
  await screen.findByRole("heading", { name: "用户" });
  await nav("运维与设置", "平台设置");
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "平台名称",
      })) as HTMLInputElement
    ).value,
  ).toBe("Accepted after refresh");
});

it("distinguishes editable link configuration from published network routes in navigation", async () => {
  const state = fixture();
  mount();
  await screen.findByRole("heading", { name: "连接端点" });
  const navigation = screen.getByRole("navigation", { name: "工作空间导航" });
  expect(
    within(navigation).getByRole("button", { name: "连接端点" }),
  ).toBeTruthy();
  expect(
    within(navigation).queryByRole("button", { name: "链路配置预览" }),
  ).toBeNull();
  await nav("连接诊断", "链路配置");
  await screen.findByRole("heading", { name: "链路配置" });
  await userEvent.click(screen.getByRole("button", { name: "新建链路配置" }));
  const editor = await screen.findByRole("dialog", { name: "新建链路配置" });
  expect(
    within(editor).getByRole("textbox", { name: "链路配置名称" }),
  ).toBeTruthy();
  await userEvent.click(within(editor).getByRole("button", { name: "关闭" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新建链路配置" })).toBeNull(),
  );
  await nav("网络资源", "线路");
  await screen.findByRole("heading", { name: "线路" });
  expect(screen.queryByRole("heading", { name: "链路配置" })).toBeNull();
  expect(state.writes).toHaveLength(0);
});

it.each(["user", "invitation"] as const)(
  "keeps the normal %s task's button boundaries and clean Escape return without submitting",
  async (kind) => {
    const state = fixture();
    mount(<AdminPage page="users" />);
    const opener = await screen.findByRole("button", {
      name: kind === "user" ? "Example user" : "邀请用户",
    });
    await userEvent.click(opener);
    const title = kind === "user" ? "编辑用户" : "邀请用户";
    const dialog = await screen.findByRole("dialog", { name: title });
    await waitFor(() => {
      expect(dialog.className).not.toMatch(/-(?:appear|enter)(?:-|\s|$)/);
      expect(getComputedStyle(dialog).opacity).not.toBe("0");
    });
    const first = within(dialog).getByRole("button", { name: "关闭" });
    const last = within(dialog).getByRole("button", {
      name: kind === "user" ? /^保\s*存$/ : "生成邀请",
    });
    const wrap = dialog.querySelector<HTMLElement>("[data-task-overlay-body]")!;
    // jsdom has no paint boxes. Supply only this rendered-layout seam; actual
    // natural Tab, document focus, short-screen visibility and pixels are separate.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const shown = !this.closest('[hidden], [aria-hidden="true"]');
        const y = this === wrap ? 0 : this === last ? 400 : 100;
        const width = shown ? (this === wrap ? 640 : 100) : 0;
        const height = shown ? (this === wrap ? 320 : 38) : 0;
        return {
          x: 0,
          y,
          left: 0,
          top: y,
          right: width,
          bottom: y + height,
          width,
          height,
          toJSON() {
            return {};
          },
        };
      },
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(wrap, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(wrap, "clientHeight", "get").mockReturnValue(320);
    // Focusing a submit control is not activation. No user/credential values are changed.
    last.focus();
    expect(document.activeElement).toBe(last);
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);
    wrap.scrollTop = 0;
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    expect(document.activeElement).toBe(last);
    // Fixed footer actions are outside the scroll body.
    expect(wrap.scrollTop).toBe(kind === "user" ? 0 : 118);
    expect(state.writes).toEqual([]);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
    expect(state.writes).toEqual([]);
  },
);

it("keeps an existing user's name-only save focusable and single-write through held failure and retry", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  const state = fixture(async (_url, values) =>
    ++attempt === 1 ? pending : json(values),
  );
  mount(<AdminPage page="users" />);
  const opener = await screen.findByRole("button", { name: "Example user" });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "编辑用户" });
  await waitFor(() =>
    expect(dialog.className).not.toMatch(/-(?:appear|enter)(?:-|\s|$)/),
  );
  const name = within(dialog).getByRole("textbox", { name: "用户名称" });
  const submit = save(dialog);
  fireEvent.change(name, { target: { value: "Updated display name" } });
  await userEvent.click(name);
  // user-event does not implement implicit submit through an external form-associated
  // footer button. Assert native association, then test the lifecycle submit seam;
  // the browser gate separately exercises physical Enter from this input.
  expect((submit as HTMLButtonElement).form).toBe(name.closest("form"));
  fireEvent.submit((submit as HTMLButtonElement).form!);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(document.activeElement).toBe(submit);
  expect(within(dialog).getByRole("button", { name: /^保存$/ })).toBe(submit);
  expect(submit.hasAttribute("disabled")).toBe(false);
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect(name.hasAttribute("disabled")).toBe(true);
  expect(
    within(dialog)
      .getByRole("switch", { name: "启用账号" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(cancel(dialog).hasAttribute("disabled")).toBe(true);
  expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
  // jsdom has no rendered boxes; this seam only exercises the normal wrapper's
  // button boundary. Native focus/scroll visibility remains an actual-browser gate.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const shown = !this.closest('[hidden], [aria-hidden="true"]');
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: shown ? 100 : 0,
        bottom: shown ? 38 : 0,
        width: shown ? 100 : 0,
        height: shown ? 38 : 0,
        toJSON() {
          return {};
        },
      };
    },
  );
  expect(fireEvent.keyDown(submit, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(submit);
  expect(fireEvent.keyDown(submit, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(submit);
  await userEvent.keyboard("{Enter}{Space}{Escape}");
  await userEvent.click(submit);
  fireEvent.submit((submit as HTMLButtonElement).form!);
  expect(screen.getByRole("dialog", { name: "编辑用户" })).toBe(dialog);
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0]).toEqual({
    url: "/api/users/user",
    values: {
      id: "user",
      name: "Updated display name",
      enabled: true,
      quotaBytes: 0,
      usedBytes: 0,
    },
  });
  await act(async () => {
    release(json({ error: "name save temporarily unavailable" }, 503));
    await pending;
  });
  await screen.findByText("name save temporarily unavailable");
  await waitFor(() => expect(name.hasAttribute("disabled")).toBe(false));
  expect((name as HTMLInputElement).value).toBe("Updated display name");
  expect(submit.getAttribute("aria-busy")).not.toBe("true");
  expect(document.activeElement).toBe(submit);
  await userEvent.click(name);
  // user-event does not implement implicit submit through an external form-associated
  // footer button. Assert native association, then test the lifecycle submit seam;
  // the browser gate separately exercises physical Enter from this input.
  expect((submit as HTMLButtonElement).form).toBe(name.closest("form"));
  fireEvent.submit((submit as HTMLButtonElement).form!);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑用户" })).toBeNull(),
  );
  expect(state.writes).toEqual([state.writes[0], state.writes[0]]);
  expect(document.activeElement).toBe(opener);
});

it("does not repeat a validated name-only submission or take focus back from another task focus target", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const state = fixture(() => pending);
  mount(<AdminPage page="users" />);
  const opener = await screen.findByRole("button", { name: "Example user" });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "编辑用户" });
  const name = within(dialog).getByRole("textbox", { name: "用户名称" });
  fireEvent.change(name, { target: { value: "Concurrent name" } });
  await userEvent.click(name);
  // The public form seam queues validations before React commits pending state.
  // Move focus elsewhere before those validations finish, then assert no theft.
  const form = (save(dialog) as HTMLButtonElement).form!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
    // The modal correctly makes its background inert; move reading focus
    // to its own non-submit surface before validation resolves.
    dialog.focus();
  });
  expect(document.activeElement).toBe(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(document.activeElement).toBe(dialog);
  expect(state.writes[0]).toEqual({
    url: "/api/users/user",
    values: {
      id: "user",
      name: "Concurrent name",
      enabled: true,
      quotaBytes: 0,
      usedBytes: 0,
    },
  });
  await act(async () => {
    release(json({ error: "name save held failure" }, 503));
    await pending;
  });
  await screen.findByText("name save held failure");
  expect(state.writes).toHaveLength(1);
  expect(document.activeElement).toBe(dialog);
});

it("does not let a departed name-only save close or unlock the current user's pending task", async () => {
  let releaseOld!: (response: Response) => void;
  let releaseCurrent!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => {
    releaseOld = resolve;
  });
  const currentRequest = new Promise<Response>((resolve) => {
    releaseCurrent = resolve;
  });
  let attempt = 0;
  const state = fixture(() => (++attempt === 1 ? oldRequest : currentRequest));
  history.replaceState(null, "", "#users");
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Example user" }),
  );
  const first = await screen.findByRole("dialog", { name: "编辑用户" });
  const firstName = within(first).getByRole("textbox", { name: "用户名称" });
  fireEvent.change(firstName, { target: { value: "Departed name" } });
  await userEvent.click(firstName);
  expect((save(first) as HTMLButtonElement).form).toBe(
    firstName.closest("form"),
  );
  fireEvent.submit((save(first) as HTMLButtonElement).form!);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  await nav("网络资源", "连接端点");
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "放弃修改并离开" }),
  );
  await screen.findByRole("heading", { name: "连接端点" });
  await nav("用户与权限", "用户");
  await userEvent.click(
    await screen.findByRole("button", { name: "Example user" }),
  );
  const current = await screen.findByRole("dialog", { name: "编辑用户" });
  const currentName = within(current).getByRole("textbox", {
    name: "用户名称",
  });
  fireEvent.change(currentName, { target: { value: "Current name" } });
  await userEvent.click(currentName);
  expect((save(current) as HTMLButtonElement).form).toBe(
    currentName.closest("form"),
  );
  fireEvent.submit((save(current) as HTMLButtonElement).form!);
  await waitFor(() => expect(state.writes).toHaveLength(2));
  const currentSubmit = save(current);
  expect(document.activeElement).toBe(currentSubmit);
  await act(async () => {
    releaseOld(json(state.writes[0].values));
    await oldRequest;
  });
  expect(screen.getByRole("dialog", { name: "编辑用户" })).toBe(current);
  expect((currentName as HTMLInputElement).value).toBe("Current name");
  expect(currentName.hasAttribute("disabled")).toBe(true);
  expect(currentSubmit.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(currentSubmit);
  fireEvent.submit((currentSubmit as HTMLButtonElement).form!);
  await userEvent.keyboard("{Enter}{Escape}");
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes).toEqual([
    {
      url: "/api/users/user",
      values: {
        id: "user",
        name: "Departed name",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      },
    },
    {
      url: "/api/users/user",
      values: {
        id: "user",
        name: "Current name",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      },
    },
  ]);
  await act(async () => {
    releaseCurrent(json({ error: "current name held failure" }, 503));
    await currentRequest;
  });
  await screen.findByText("current name held failure");
  expect((currentName as HTMLInputElement).value).toBe("Current name");
  expect(currentName.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(currentSubmit);
});

it.each([
  ["nodes", "连接端点", "暂无连接端点"],
  ["users", "用户", "暂无用户"],
  ["services", "服务方案", "暂无服务方案"],
  ["legacy-routes", "链路配置", "暂无链路配置"],
  ["activity", "变更记录", "还没有配置记录"],
])("allows administrator #%s entry and recovers an unavailable inventory without presenting false empty data", async (hash, title, empty) => {
  history.replaceState(null, "", `#${hash}`);
  let release!: (response: Response) => void;
  let stateReads = 0;
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      unexpected.push(`${init.method} ${url}`);
      throw new Error("Read-only inventory case");
    }
    if (url === "/api/auth/me") return json({ user: { id: "admin-reader", name: "Admin", role: "admin" }, csrfToken: "fixture" });
    if (url === "/api/state") {
      stateReads++;
      if (stateReads === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json({ nodes: [], users: [], routes: [], revisions: [], capabilities: [] });
    }
    if (url === "/api/settings") return json({ name: "Read-only fixture", registration: "invite" });
    if (["/api/services", "/api/published-routes", "/api/rates", "/api/user-groups", "/api/audit"].includes(url)) return json([]);
    unexpected.push(url);
    throw new Error(`Unexpected inventory request ${url}`);
  }));
  mount();
  const main = await screen.findByRole("main");
  await within(main).findByRole("heading", { name: title, level: 1 });
  expect(within(main).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(within(main).queryByText(empty)).toBeNull();
  await act(async () => { release(json({ message: `${title}读取暂不可用` }, 503)); });
  await within(main).findByText(`${title}读取暂不可用`);
  expect(within(main).queryByText(empty)).toBeNull();
  await userEvent.click(within(main).getByRole("button", { name: "重试" }));
  await within(main).findByText(empty);
  expect(within(main).queryByText(`${title}读取暂不可用`)).toBeNull();
  expect(stateReads).toBe(2);
  expect(unexpected).toEqual([]);
});


it("does not expose editable default settings during initial loading or failure and restores authoritative values on retry", async () => {
  history.replaceState(null, "", "#settings");
  let release!: (response: Response) => void;
  const state = fixture(undefined, async (count, values) => {
    if (count === 1) return new Promise<Response>((resolve) => { release = resolve; });
    return json(values);
  });
  mount();
  const main = await screen.findByRole("main");
  await within(main).findByRole("heading", { name: "平台设置", level: 1 });
  expect(within(main).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
  expect(within(main).queryByLabelText("平台名称")).toBeNull();
  await act(async () => { release(json({ message: "尚未读到平台设置" }, 503)); });
  await within(main).findByText("尚未读到平台设置");
  expect(within(main).queryByLabelText("平台名称")).toBeNull();
  await userEvent.click(within(main).getByRole("button", { name: "重试" }));
  await userEvent.click(await within(main).findByRole("button", { name: "编辑平台名称" }));
  const name = await within(main).findByLabelText("平台名称");
  expect((name as HTMLInputElement).value).toBe("RouteWeaver");
  expect(within(main).queryByText("尚未读到平台设置")).toBeNull();
  expect(state.settingsReads).toBe(2);
  expect(state.writes).toEqual([]);
});

it.each([
  ["nodes", "Alpha endpoint", "仍被链路配置引用的端点不能删除。请先从相关链路配置中移除引用。"],
  ["legacy-routes", "Example legacy route", "已分配用户将不能从此链路配置获取新配置。"],
])("keeps the exact #%s deletion target and consequence through repeated safe-default cancellation", async (hash, target, consequence) => {
  history.replaceState(null, "", `#${hash}`);
  fixture();
  mount();
  const opener = await screen.findByRole("button", { name: `更多操作 ${target}` });
  const deleteLabel = `${hash === "nodes" ? "删除端点" : "删除链路配置"} ${target}`;
  expect(screen.queryByRole("button", { name: deleteLabel })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "操作" })).toBeTruthy();
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(opener);
    await userEvent.click(await screen.findByRole("menuitem", { name: deleteLabel }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByRole("heading").textContent).toContain(target);
    expect(within(confirmation).getByText(consequence)).toBeTruthy();
    const keep = within(confirmation).getByRole("button", { name: "保留" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  }
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
});

it("keeps legacy deletion behind its row menu and submits the exact target only after confirmation", async () => {
  fixture();
  const read = vi.mocked(fetch).getMockImplementation()!;
  const deleted: string[] = [];
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === "DELETE") {
      deleted.push(String(input));
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return read(input, init);
  });
  mount(<AdminPage page="legacy-routes" />);
  const opener = await screen.findByRole("button", { name: "更多操作 Example legacy route" });
  const row = screen.getByRole("group", { name: "Example legacy route 的操作" });
  expect(within(row).getByRole("button", { name: "编辑" })).toBeTruthy();
  expect(within(row).getByRole("button", { name: "校验 Example legacy route" })).toBeTruthy();
  await userEvent.click(opener);
  await userEvent.click(await screen.findByRole("menuitem", { name: "删除链路配置 Example legacy route" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "删除链路配置「Example legacy route」？" });
  const keep = within(confirmation).getByRole("button", { name: "保留" });
  await waitFor(() => expect(document.activeElement).toBe(keep));
  expect(deleted).toEqual([]);
  const remove = within(confirmation).getByRole("button", { name: "删除" });
  await userEvent.dblClick(remove);
  expect(deleted).toEqual(["/api/routes/route"]);
  expect(remove).toHaveProperty("disabled", true);
  await act(async () => { release(new Response(null, { status: 204 })); });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("preserves the exact legacy route draft after failed save, canceled discard, and explicit retry", async () => {
  let attempts = 0;
  const state = fixture(async (_url, value) => ++attempts === 1 ? json({ message: "链路草稿暂未保存" }, 503) : json(value));
  mount(<AdminPage page="legacy-routes" />);
  const opener = await screen.findByRole("button", { name: /^Example legacy route/ });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "编辑链路配置 Example legacy route" });
  const name = within(dialog).getByRole("textbox", { name: "链路配置名称" });
  fireEvent.change(name, { target: { value: "Retained route draft" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "保存草稿" }));
  await within(dialog).findByText("链路草稿暂未保存");
  expect((name as HTMLInputElement).value).toBe("Retained route draft");
  expect(state.writes).toEqual([{ url: "/api/routes/route", values: { id: "route", name: "Retained route draft", engine: "sing-box", hops: ["a"], userIds: [] } }]);
  const close = within(dialog).getByRole("button", { name: "关闭" });
  await userEvent.click(close);
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的链路配置修改？" });
  const keep = within(confirmation).getByRole("button", { name: "继续编辑" });
  await waitFor(() => expect(document.activeElement).toBe(keep));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(close));
  await userEvent.click(within(dialog).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it.each([
  ["nodes", "Alpha endpoint", "编辑端点", "端点名称"],
  ["users", "Example user", "编辑用户", "用户名称"],
] as const)("returns the %s editor to its stable Close control after canceled discard", async (page, target, title, field) => {
  const state = fixture();
  mount(<AdminPage page={page} />);
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${target}`) }));
  const dialog = await screen.findByRole("dialog", { name: title });
  const name = within(dialog).getByRole("textbox", { name: field });
  fireEvent.change(name, { target: { value: "Retained edit" } });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((name as HTMLInputElement).value).toBe("Retained edit");
  }
  expect(state.writes).toEqual([]);
});

it("keeps settings edits and exact navigation focus through two canceled departures", async () => {
  fixture();
  history.replaceState(null, "", "#settings");
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const field = await screen.findByRole("textbox", { name: "平台名称" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "Retained settings" } });
  const group = screen.getByRole("button", { name: "用户与权限" });
  if (group.getAttribute("aria-expanded") === "false") await userEvent.click(group);
  const target = within(screen.getByRole("navigation", { name: "工作空间导航" })).getByRole("button", { name: "用户" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(target);
    const review = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    const keep = within(review).getByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(field.value).toBe("Retained settings");
    expect(location.hash).toBe("#settings");
  }
});


// Source-only reconstruction regressions: these have not been executed.
it.each([
  ["0", 0],
  ["0.5", 536870912],
  ["0.000000000931322574615478515625", 1],
  ["8388607.999999999068677425384521484375", 9007199254740991],
])("creates a user with exact quota %s GiB", async (raw, expected) => {
  const api = fixture();
  mount(<AdminPage page="users" />);
  await userEvent.click(await screen.findByRole("button", { name: "添加用户" }));
  const dialog = await screen.findByRole("dialog", { name: "添加用户" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Exact quota user" },
  });
  fireEvent.change(within(dialog).getByRole("spinbutton"), {
    target: { value: raw },
  });
  await userEvent.click(save(dialog));
  await waitFor(() => expect(api.writes).toHaveLength(1));
  expect(api.writes[0].url).toBe("/api/users");
  expect(api.writes[0].values.quotaBytes).toBe(expected);
  expect(api.writes[0].values).not.toHaveProperty("quotaGiB");
});

it.each([
  "0.0000000001",
  "0.1",
  "0.50000000000000000001",
  "0.00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001",
  "8388608",
  "",
  "1e",
  "1e-400",
  "-1",
])("does not submit an inexact or incomplete new quota %s", async (raw) => {
  const api = fixture();
  mount(<AdminPage page="users" />);
  await userEvent.click(await screen.findByRole("button", { name: "添加用户" }));
  const dialog = await screen.findByRole("dialog", { name: "添加用户" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Keep this draft" },
  });
  const quota = within(dialog).getByRole("spinbutton") as HTMLInputElement;
  fireEvent.change(quota, { target: { value: raw } });
  // Submit the public form even if native NumericInput validity would stop a click.
  fireEvent.submit(quota.closest("form")!);
  await within(dialog).findByText(
    "请输入可精确换算为整数字节的非负十进制数，且不超过安全范围；0 为不限额。",
  );
  expect(api.writes).toHaveLength(0);
  expect(quota.value).toBe(raw);
  expect((within(dialog).getByRole("textbox", { name: "用户名称" }) as HTMLInputElement).value).toBe("Keep this draft");
  // A deliberate correction must still allow the same draft to be saved.
  fireEvent.change(quota, { target: { value: "0.5" } });
  await userEvent.click(save(dialog));
  await waitFor(() => expect(api.writes).toHaveLength(1));
  expect(api.writes[0].values.quotaBytes).toBe(536870912);
});

it.each([0, 1, 9007199254740991])(
  "preserves existing %s-byte quota on rename and enable edits",
  async (quotaBytes) => {
    const api = fixture(undefined, undefined, quotaBytes);
    mount(<AdminPage page="users" />);
    await userEvent.click(await screen.findByRole("button", { name: "Example user" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑用户" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "用户名称" }), {
      target: { value: "Renamed user" },
    });
    await userEvent.click(within(dialog).getByRole("switch", { name: "启用账号" }));
    await userEvent.click(save(dialog));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toEqual({
      url: "/api/users/user",
      values: { id: "user", name: "Renamed user", enabled: false, quotaBytes, usedBytes: 0 },
    });
  },
);

it("blocks all existing-account writes when its quota is not a safe integer", async () => {
  const api = fixture(undefined, undefined, 9007199254740992);
  mount(<AdminPage page="users" />);
  await userEvent.click(await screen.findByRole("button", { name: "Example user" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑用户" });
  expect(within(dialog).getByText(/为避免改写额度，名称和启用状态也暂不能保存/)).toBeTruthy();
  const name = within(dialog).getByRole("textbox", { name: "用户名称" });
  fireEvent.change(name, { target: { value: "Do not send" } });
  await userEvent.click(within(dialog).getByRole("switch", { name: "启用账号" }));
  expect((save(dialog) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { fireEvent.submit(name.closest("form")!); });
  expect(api.writes).toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "编辑用户" })).toBe(dialog);
});


it("protects a raw quota edit even when Number conversion equals the default", async () => {
  const api = fixture();
  mount(<AdminPage page="users" />);
  await userEvent.click(await screen.findByRole("button", { name: "添加用户" }));
  const dialog = await screen.findByRole("dialog", { name: "添加用户" });
  const quota = within(dialog).getByRole("spinbutton") as HTMLInputElement;
  fireEvent.change(quota, { target: { value: "100.00000000000000000001" } });
  await userEvent.click(cancel(dialog));
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  await userEvent.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  expect(quota.value).toBe("100.00000000000000000001");
  expect(api.writes).toHaveLength(0);
});

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
import Workspace from "./App";
import { StrictMode, type ReactNode } from "react";
import { SourcesPage } from "./Sources";
import type { Source } from "./types";
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";

const endpoints = [
  {
    id: "accepted-node",
    name: "Accepted connection",
    origin: "imported",
    connection: { protocol: "socks", host: "synthetic.example", port: 1080 },
  },
];
const source: Source = {
  id: "private-source",
  name: "My accepted source",
  kind: "text",
  enabled: true,
  revision: "accepted-v1",
  snapshot: { endpoints },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const unexpectedRequests: string[] = [];
beforeEach(() => {
  unexpectedRequests.length = 0;
  history.replaceState(null, "", "#sources");
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
  expect(unexpectedRequests).toEqual([]);
});
function mount(
  sources = [source],
  options: { strict?: boolean; children?: ReactNode; role?: "admin" | "member"; postSaveInventory?: "delayed" | "failed"; importCandidate?: boolean } = {},
) {
  let currentSources = sources;
  let sourceSaved = false;
  let inventoryRecovered = false;
  let finishInventory: (() => void) | undefined;
  let account = "account-a";
  let holdSession = false;
  let finishSession: ((value: Response) => void) | undefined;
  const session = () => ({
    user: { id: account, name: account, role: options.role || "member" },
    csrfToken: account,
  });
  const writes: string[] = [];
  const previews: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      if (path === "/auth/me")
        return holdSession
          ? new Promise<Response>((resolve) => {
              finishSession = resolve;
            })
          : json(session());
      if (path === "/me/sources") {
        if (init?.method === "POST" && (options.postSaveInventory || options.importCandidate)) {
          writes.push(path);
          const submitted = JSON.parse(String(init.body));
          currentSources = [{ ...source, ...submitted, ...(options.importCandidate ? { snapshot: undefined, candidate } : { snapshot: { endpoints } }) }];
          sourceSaved = true;
          return json(currentSources[0]);
        }
        if (sourceSaved && !inventoryRecovered) {
          if (options.postSaveInventory === "delayed")
            return new Promise<Response>((resolve) => { finishInventory = () => resolve(json(currentSources)); });
          if (options.postSaveInventory === "failed") return json({ detail: "Source inventory unavailable" }, 503);
        }
        return json(currentSources);
      }
      if (path === "/me/overview")
        return json({ status: "active", routes: [] });
      if (path === "/me/collections/preview") {
        previews.push(JSON.parse(String(init?.body)));
        return currentSources.length
          ? json({ endpoints, stages: [] })
          : json({ detail: "所选来源已不可用" }, 422);
      }
      if (init?.method && init.method !== "GET") {
        writes.push(path);
        return json([]);
      }
      if (
        [
          "/me/profiles",
          "/me/outputs",
          "/me/collections",
          "/me/resources",
          "/me/platform-entries",
        ].includes(path)
      )
        return json([]);
      unexpectedRequests.push(path);
      return json({ detail: "Unexpected fixture request" }, 500);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const workspace = options.children || <Workspace />;
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {options.strict ? <StrictMode>{workspace}</StrictMode> : workspace}
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    previews,
    recoverInventory: () => {
      inventoryRecovered = true;
      finishInventory?.();
    },
    setSources: (next: Source[]) => {
      currentSources = next;
    },
    setAccount: (next: string) => {
      account = next;
    },
    holdSession: () => {
      holdSession = true;
    },
    finishSession: (next: string) => {
      account = next;
      holdSession = false;
      if (!finishSession) throw new Error("Session check was not requested");
      finishSession(json(session()));
    },
  };
}

it("continues an accepted source into an unsaved full configuration without choosing an exit or writing", async () => {
  const { writes, previews } = mount();
  await userEvent.click(
    await screen.findByRole(
      "button",
      { name: /^My accepted source/ },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  const detail = await screen.findByRole("dialog", { name: source.name });
  await userEvent.click(
    within(detail).getByRole("button", { name: "用此来源新建分流配置" }),
  );
  await screen.findByRole("heading", { name: "新建分流配置" });
  expect(screen.getByText("草稿尚未保存")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "配置名称" }),
  );
  expect(screen.getByRole("tab", { name: "策略组" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "运行设置" })).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "使用的订阅来源" }).closest("label")
      ?.textContent,
  ).toContain(source.name);
  expect(
    screen.getByRole("combobox", { name: "默认流量行为" }).closest("label")
      ?.textContent,
  ).toContain("直连");
  await screen.findByText("1 个有效连接");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "配置名称" }),
  );
  expect(previews).toContainEqual({
    id: "profile-sources",
    name: "Profile sources",
    sources: [{ sourceId: source.id, steps: [] }],
    steps: [],
  });
  expect(writes).toEqual([]);
  expect(location.hash).toBe("#subscriptions");
});

async function continueFromSource(actionName = "用此来源新建分流配置") {
  await userEvent.click(
    await screen.findByRole(
      "button",
      { name: /^My accepted source/ },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  const detail = await screen.findByRole("dialog", { name: source.name });
  const start = within(detail).getByRole("button", {
    name: actionName,
  });
  start.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { name: "新建分流配置" });
}
it("protects a seeded draft through Close and Back, and never resurrects it after discard or ordinary return", async () => {
  const { writes } = mount([source], { strict: true });
  await continueFromSource();
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Keep this choice" },
  });
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑" }),
  );
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Keep this choice");
  await act(async () => history.back());
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑" }),
  );
  expect(location.hash).toBe("#subscriptions");
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Keep this choice");
  await act(async () => history.back());
  await userEvent.click(
    await screen.findByRole("button", { name: "放弃修改并离开" }),
  );
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await act(async () => history.forward());
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  // The primary subscription destination stays discoverable across sections.
  await userEvent.click(screen.getByRole("button", { name: "我的订阅" }));
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(writes).toEqual([]);
});

const candidate = {
  id: "candidate",
  createdAt: "2026-10-27",
  diagnostics: [],
  affected: [],
  diff: {
    beforeCount: 0,
    afterCount: 1,
    added: [],
    removed: [],
    renamed: [],
    connectionChanged: [],
  },
};
it.each([
  ["paused", { ...source, enabled: false }],
  ["unknown", { ...source, enabled: undefined }],
  ["unaccepted", { ...source, snapshot: undefined, endpoints }],
  ["candidate-only", { ...source, snapshot: undefined, candidate }],
] as const)(
  "does not offer a new configuration from a %s source",
  async (_state, record) => {
    mount([record as Source]);
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: /^My accepted source/ },
        { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
      ),
    );
    const detail = await screen.findByRole("dialog", { name: source.name });
    expect(
      within(detail).queryByRole("button", { name: "用此来源新建分流配置" }),
    ).toBeNull();
  },
);
it.each([
  [
    "newer failure",
    { ...source, refreshStatus: "failed", lastError: "source-fetch-failed" },
  ],
  [
    "newer candidate",
    { ...source, refreshStatus: "review-required", candidate },
  ],
] as const)(
  "retains the accepted snapshot continuation with a %s without accepting newer input",
  async (_state, record) => {
    const { writes } = mount([record as Source]);
    await continueFromSource();
    await screen.findByText("1 个有效连接");
    expect(writes).toEqual([]);
  },
);
it("does not offer an escape into a new configuration from an embedded source task", async () => {
  mount([source], { children: <SourcesPage /> });
  await userEvent.click(
    await screen.findByRole("button", { name: /^My accepted source/ }),
  );
  const detail = await screen.findByRole("dialog", { name: source.name });
  expect(
    within(detail).queryByRole("button", { name: "用此来源新建分流配置" }),
  ).toBeNull();
});
it("normalizes an unowned or reloaded draft token to inventory without reading private source inputs", async () => {
  history.replaceState(null, "", "#subscriptions?sourceDraft=unowned-token");
  const { writes, previews } = mount();
  await screen.findByRole(
    "heading",
    { name: "我的订阅", level: 1 },
    { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
  );
  await waitFor(() => expect(location.hash).toBe("#subscriptions"));
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(previews).toEqual([]);
  expect(writes).toEqual([]);
});
it("retains a source reference that becomes paused during entry and exposes existing recovery", async () => {
  const { setSources, writes } = mount();
  await userEvent.click(
    await screen.findByRole(
      "button",
      { name: /^My accepted source/ },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  setSources([{ ...source, enabled: false }]);
  const detail = await screen.findByRole("dialog", { name: source.name });
  await userEvent.click(
    within(detail).getByRole("button", { name: "用此来源新建分流配置" }),
  );
  await screen.findByRole("button", { name: `编辑来源 ${source.name}` });
  expect(
    screen.getByRole("combobox", { name: "使用的订阅来源" }).closest("label")
      ?.textContent,
  ).toContain("已暂停");
  expect(
    screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(writes).toEqual([]);
});
it("retains a disappeared source reference instead of substituting another source or empty selection", async () => {
  const { setSources, writes } = mount();
  await userEvent.click(
    await screen.findByRole(
      "button",
      { name: /^My accepted source/ },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  setSources([]);
  const detail = await screen.findByRole("dialog", { name: source.name });
  await userEvent.click(
    within(detail).getByRole("button", { name: "用此来源新建分流配置" }),
  );
  await screen.findByText("有效连接暂不可用");
  expect(
    screen.getByRole("combobox", { name: "使用的订阅来源" }).closest("label")
      ?.textContent,
  ).toContain(`${source.id}（来源暂不可用，已保留）`);
  expect(writes).toEqual([]);
});
it("drops the originating account draft on account replacement and cannot replay it from the clean URL", async () => {
  const { setAccount, setSources, writes } = mount();
  await continueFromSource();
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Account A private draft" },
  });
  setSources([]);
  setAccount("account-b");
  fireEvent(window, new Event("focus"));
  await screen.findByText("account-b");
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(screen.queryByText(source.name)).toBeNull();
  expect(location.hash).toBe("#subscriptions");
  expect(writes).toEqual([]);
});

it.each(["account-a", "account-b"])(
  "owns an unconsumed entry across a suspended session check returning %s",
  async (nextAccount) => {
    const fixture = mount();
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: /^My accepted source/ },
        { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
      ),
    );
    const detail = await screen.findByRole("dialog", { name: source.name });
    fixture.holdSession();
    // Two real public events in one commit: navigation is accepted before the
    // destination/lazy editor can mount, then identity becomes unconfirmed.
    act(() => {
      fireEvent.click(
        within(detail).getByRole("button", { name: "用此来源新建分流配置" }),
      );
      fireEvent(window, new Event("focus"));
    });
    expect(location.hash).toContain("sourceDraft=");
    expect(location.hash + JSON.stringify(history.state)).not.toContain(
      source.id,
    );
    expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
    await act(async () => fixture.finishSession(nextAccount));
    if (nextAccount === "account-a") {
      await screen.findByRole("heading", { name: "新建分流配置" });
      await screen.findByText("1 个有效连接");
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "配置名称" }),
      );
    } else {
      await screen.findByRole("heading", { name: "我的订阅", level: 1 });
      expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
      expect(fixture.previews).toEqual([]);
    }
    expect(location.hash).toBe("#subscriptions");
    expect(fixture.writes).toEqual([]);
  },
);
it("ignores repeated activation of the departed source action", async () => {
  const { writes } = mount();
  await userEvent.click(
    await screen.findByRole(
      "button",
      { name: /^My accepted source/ },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  const detail = await screen.findByRole("dialog", { name: source.name });
  const start = within(detail).getByRole("button", {
    name: "用此来源新建分流配置",
  });
  act(() => {
    fireEvent.click(start);
    fireEvent.click(start);
  });
  await screen.findByRole("heading", { name: "新建分流配置" });
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Only this draft" },
  });
  expect(screen.getAllByRole("textbox", { name: "配置名称" })).toHaveLength(1);
  expect(location.hash).toBe("#subscriptions");
  expect(writes).toEqual([]);
});
it("does not let an unowned same-page entry overwrite a dirty configuration without the normal decision", async () => {
  const { writes } = mount();
  await continueFromSource();
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Keep my existing draft" },
  });
  act(() => {
    location.hash = "#subscriptions?sourceDraft=unowned-token";
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑" }),
  );
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Keep my existing draft");
  expect(location.hash).toBe("#subscriptions");
  act(() => {
    location.hash = "#subscriptions?sourceDraft=unowned-token";
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "放弃修改并离开" }),
  );
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(location.hash).toBe("#subscriptions");
  expect(writes).toEqual([]);
});



it("starts an existing-proxy subscription task from the empty inventory and retains its accepted source draft", async () => {
  history.replaceState(null, "", "#subscriptions");
  const { writes, previews } = mount();
  const start = await screen.findByRole("button", { name: "用已有代理生成订阅" }, { timeout: INITIAL_PAGE_READY_TIMEOUT_MS });
  expect(screen.queryByRole("button", { name: "配置自有服务器" })).toBeNull();
  expect(screen.getByRole("button", { name: "新建分流配置" })).toBeTruthy();
  await userEvent.click(start);
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(screen.getByText("先导入已有代理或订阅链接。导入后继续设置客户端订阅，也可以打开下方已有来源继续。")).toBeTruthy();
  await continueFromSource("继续设置订阅");
  await screen.findByText("1 个有效连接");
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" }).closest("label")?.textContent).toContain(source.name);
  expect(screen.getByRole("combobox", { name: "默认流量行为" }).textContent).toContain("直连");
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), { target: { value: "Proxy subscription draft" } });
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await userEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect((screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement).value).toBe("Proxy subscription draft");
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" }).closest("label")?.textContent).toContain(source.name);
  expect(previews.length).toBeGreaterThan(0);
  expect(writes).toEqual([]);
  await act(async () => history.back());
  await userEvent.click(await screen.findByRole("button", { name: "放弃修改并离开" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(screen.getByText("导入外部订阅和节点，与平台节点组合使用。")).toBeTruthy();
  expect(screen.queryByText("先导入已有代理或订阅链接。导入后继续设置客户端订阅，也可以打开下方已有来源继续。")).toBeNull();
});

it("offers owned-server setup only for a verified administrator", async () => {
  history.replaceState(null, "", "#subscriptions");
  mount([], { role: "admin" });
  await screen.findByRole("button", { name: "用已有代理生成订阅" }, { timeout: INITIAL_PAGE_READY_TIMEOUT_MS });
  expect(screen.getByRole("button", { name: "配置自有服务器" })).toBeTruthy();
});


it("keeps direct-only configuration available and names its empty-catalog source action explicitly", async () => {
  history.replaceState(null, "", "#subscriptions");
  const { writes } = mount([]);
  await screen.findByRole("button", { name: "用已有代理生成订阅" }, { timeout: INITIAL_PAGE_READY_TIMEOUT_MS });
  await userEvent.click(screen.getByRole("button", { name: "新建分流配置" }));
  await screen.findByRole("heading", { name: "新建分流配置" });
  expect(screen.getByRole("combobox", { name: "默认流量行为" }).textContent).toContain("直连");
  await userEvent.click(screen.getByRole("button", { name: "收起来源设置" }));
  const addSource = await screen.findByRole("button", { name: "添加代理来源" });
  expect(screen.queryByRole("button", { name: "编辑来源" })).toBeNull();
  await userEvent.click(addSource);
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" })).toBeTruthy();
  expect(writes).toEqual([]);
});


it.each(["delayed", "failed"] as const)("retains the confirmed import task through a %s inventory refresh until verified recovery", async (postSaveInventory) => {
  const onCreateProfile = vi.fn();
  const { writes, recoverInventory } = mount([], {
    postSaveInventory,
    children: <SourcesPage subscriptionSetup onCreateProfile={onCreateProfile} />,
  });
  await userEvent.click((await screen.findAllByRole("button", { name: "添加来源" }))[0]);
  const importer = await screen.findByRole("dialog", { name: "添加订阅来源" });
  fireEvent.change(within(importer).getByRole("textbox", { name: "来源名称" }), { target: { value: "Confirmed proxy source" } });
  fireEvent.change(within(importer).getByRole("textbox", { name: "节点链接或配置内容" }), { target: { value: "socks5://192.0.2.40:1080#Accepted" } });
  await userEvent.click(within(importer).getByRole("button", { name: "导入来源" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull());
  const task = await screen.findByRole("region", { name: "继续设置订阅" });
  expect(within(task).getByRole("heading").textContent).toContain("Confirmed proxy source");
  const proceed = within(task).getByRole("button", { name: "继续设置订阅" });
  expect((proceed as HTMLButtonElement).disabled).toBe(true);
  await within(task).findByText(postSaveInventory === "delayed" ? "正在核对已导入的来源…" : "暂时无法核对来源，导入结果已保留。请重试。");
  expect(within(task).queryByText("当前来源列表中找不到此来源，请重新核对。")).toBeNull();
  await userEvent.click(proceed);
  expect(onCreateProfile).not.toHaveBeenCalled();
  expect(writes).toEqual(["/me/sources"]);
  await act(async () => recoverInventory());
  if (postSaveInventory === "failed") await userEvent.click(within(task).getByRole("button", { name: "重新核对来源" }));
  await waitFor(() => expect((proceed as HTMLButtonElement).disabled).toBe(false));
  expect(onCreateProfile).not.toHaveBeenCalled();
  await userEvent.click(proceed);
  expect(onCreateProfile).toHaveBeenCalledTimes(1);
  expect(writes).toEqual(["/me/sources"]);
});


it("retains a candidate-only imported source task without inventing an accepted snapshot", async () => {
  const onCreateProfile = vi.fn();
  const { writes } = mount([], { importCandidate: true, children: <SourcesPage subscriptionSetup onCreateProfile={onCreateProfile} /> });
  await userEvent.click((await screen.findAllByRole("button", { name: "添加来源" }))[0]);
  const importer = await screen.findByRole("dialog", { name: "添加订阅来源" });
  fireEvent.change(within(importer).getByRole("textbox", { name: "来源名称" }), { target: { value: "Pending proxy source" } });
  fireEvent.change(within(importer).getByRole("textbox", { name: "节点链接或配置内容" }), { target: { value: "socks5://192.0.2.40:1080#Pending" } });
  await userEvent.click(within(importer).getByRole("button", { name: "导入来源" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull());
  const task = await screen.findByRole("region", { name: "继续设置订阅" });
  expect(within(task).getByRole("heading").textContent).toBe("已保存来源「Pending proxy source」");
  await within(task).findByText("此来源还没有已接受的连接，请先完成导入检查。");
  expect((within(task).getByRole("button", { name: "继续设置订阅" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(task).getByRole("button", { name: "查看导入变化" })).toBeTruthy();
  expect(onCreateProfile).not.toHaveBeenCalled();
  expect(writes).toEqual(["/me/sources"]);
});

it("keeps the subscription task action on existing accepted sources and discloses an unapplied candidate", async () => {
  const onCreateProfile = vi.fn();
  const { writes } = mount([{ ...source, candidate }], { children: <SourcesPage subscriptionSetup onCreateProfile={onCreateProfile} /> });
  await userEvent.click(await screen.findByRole("button", { name: /^My accepted source/ }));
  const detail = await screen.findByRole("dialog", { name: source.name });
  expect(within(detail).getByText("使用已应用版本，待审更新不会加入。")).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "用此来源新建分流配置" })).toBeNull();
  await userEvent.click(within(detail).getByRole("button", { name: "继续设置订阅" }));
  expect(onCreateProfile).toHaveBeenCalledWith(source.id);
  expect(writes).toEqual([]);
});

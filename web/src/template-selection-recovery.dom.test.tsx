// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { type ReactNode } from "react";
import { TemplatesPage } from "./Templates";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

it("explains a source directory failure and retries reads without losing the template task or applying it", async () => {
  const template = {
    id: "routing",
    name: "日常分流",
    kind: "client-profile",
    version: 2,
    publishedAt: "2026-10-20T09:00:00Z",
    spec: { endpointSlots: [{ id: "exit", name: "出口连接" }] },
  };
  let sourceReads = 0;
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(init.body));
        return json({});
      }
      if (url === "/api/templates") return json([template]);
      if (url === "/api/templates/routing/versions")
        return json([template, { ...template, version: 1 }]);
      if (url === "/api/me/profiles")
        return json([
          {
            id: "home",
            name: "家庭配置",
            sourceIds: ["feed"],
            ir: { endpoints: [], resources: [], groups: [], rules: [] },
          },
        ]);
      if (url === "/api/me/sources") {
        sourceReads++;
        return sourceReads === 1
          ? json({ error: "temporarily unavailable" }, 503)
          : json([
              {
                id: "feed",
                snapshot: { endpoints: [{ id: "owned", name: "家庭出口" }] },
              },
            ]);
      }
      return json([]);
    }),
  );
  mount(<TemplatesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "查看并使用" }));
  await user.click(screen.getByRole("combobox", { name: "模板目标" }));
  await user.click(await screen.findByText("家庭配置"));
  expect(await screen.findByText("暂时无法加载来源")).toBeTruthy();
  expect(screen.queryByText("操作未完成")).toBeNull();
  expect(
    within(screen.getByRole("status")).getByRole("button", {
      name: "重新加载来源",
    }),
  ).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "模板版本" }));
  await user.click(await screen.findByText(/^v1 ·/));
  await user.click(screen.getByRole("radio", { name: "固定此版本" }));
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "重新加载来源" }));
  await waitFor(() => expect(sourceReads).toBe(2));
  expect(
    screen
      .getByRole("radio", { name: "固定此版本" })
      .getAttribute("aria-checked") === "true",
  ).toBe(true);
  expect(
    within(
      screen.getByRole("combobox", { name: "模板目标" }).closest("label")!,
    ).getByText("家庭配置").textContent,
  ).toBe("家庭配置");
  expect(writes).toEqual([]);
  await user.click(screen.getByRole("combobox", { name: "出口连接" }));
  await user.click(await screen.findByText("家庭出口"));
  await user.click(screen.getByRole("button", { name: "应用模板到草稿" }));
  await waitFor(() =>
    expect(writes).toEqual([
      {
        version: 1,
        mode: "pinned",
        targetId: "home",
        bindings: { endpoints: { exit: "owned" }, resources: {} },
      },
    ]),
  );
});

async function selectionFixture({
  preset = false,
  slots = true,
  local = false,
  sourceFailure = false,
  platformFailure = false,
  collectionFailure = false,
  profileFailure = false,
  collectionReference = false,
  versionFailure = false,
} = {}) {
  const template = {
    id: "routing",
    name: "日常分流",
    kind: preset ? "processing-preset" : "client-profile",
    version: 2,
    publishedAt: "2026-10-20T09:00:00Z",
    spec: {
      endpointSlots: !preset && slots ? [{ id: "exit", name: "出口连接" }] : [],
    },
  };
  const state = {
    versions: [template, { ...template, version: 1 }],
    profiles: [
      {
        id: "home",
        name: "家庭配置",
        collectionId: collectionReference ? "set" : "",
        sourceIds: collectionReference ? [] : ["feed"],
        platformEntryIds: ["platform"],
        ir: {
          endpoints: local ? [{ id: "internal", name: "本地连接" }] : [],
          resources: [],
          groups: [],
          rules: [],
        },
      },
    ],
    sources: [
      {
        id: "feed",
        snapshot: { endpoints: [{ id: "owned", name: "家庭出口" }] },
      },
    ],
    sourceFailure,
    platformFailure,
    collectionFailure,
    profileFailure,
    versionFailure,
    sourceWait: undefined as Promise<void> | undefined,
  };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(init.body));
        return json({});
      }
      if (url === "/api/templates") return json([template]);
      if (url === "/api/templates/routing/versions")
        return state.versionFailure
          ? json({ error: "unavailable" }, 503)
          : json(state.versions);
      if (url === "/api/me/profiles")
        return state.profileFailure
          ? json({ error: "unavailable" }, 503)
          : json(state.profiles);
      if (url === "/api/me/collections")
        return state.collectionFailure
          ? json({ error: "unavailable" }, 503)
          : json([
              {
                id: "set",
                name: "家庭集合",
                sources: [{ sourceId: "feed", steps: [] }],
                steps: [],
              },
            ]);
      if (url === "/api/me/sources") {
        await state.sourceWait;
        return state.sourceFailure
          ? json({ error: "unavailable" }, 503)
          : json(state.sources);
      }
      if (url === "/api/me/platform-entries")
        return state.platformFailure
          ? json({ error: "unavailable" }, 503)
          : json([]);
      return json([]);
    }),
  );
  const { client } = mount(<TemplatesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "查看并使用" }));
  const choose = async (label: string, option: string | RegExp) => {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByText(option));
  };
  return { state, writes, client, user, choose };
}
it("keeps a processing preset available when profiles and unrelated connection directories fail", async () => {
  const { choose, writes } = await selectionFixture({
    preset: true,
    profileFailure: true,
    sourceFailure: true,
    platformFailure: true,
  });
  await choose("模板目标", "家庭集合");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "应用模板到草稿" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(screen.queryByText("暂时无法加载客户端配置")).toBeNull();
  expect(writes).toEqual([]);
});
it("does not require connection directories for a no-slot client template", async () => {
  const { choose, writes } = await selectionFixture({
    slots: false,
    collectionFailure: true,
    sourceFailure: true,
    platformFailure: true,
  });
  await choose("模板目标", "家庭配置");
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "应用模板到草稿" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(screen.queryByText("暂时无法加载来源")).toBeNull();
  expect(writes).toEqual([]);
});
it("allows a known internal binding while explaining unavailable remote candidates", async () => {
  const { choose, writes } = await selectionFixture({
    local: true,
    collectionFailure: true,
    sourceFailure: true,
    platformFailure: true,
  });
  await choose("模板目标", "家庭配置");
  expect(await screen.findByText("暂时无法加载来源")).toBeTruthy();
  expect(await screen.findByText("暂时无法加载平台连接")).toBeTruthy();
  await choose("出口连接", "本地连接");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(writes).toEqual([]);
});
it("retains a selected connection through failed reload and blocks it after confirmed removal", async () => {
  const { choose, state, client, user, writes } = await selectionFixture();
  await choose("模板目标", "家庭配置");
  await choose("出口连接", "家庭出口");
  await user.click(screen.getByRole("radio", { name: "跟随版本" }));
  state.sourceFailure = true;
  await act(async () => {
    await client.refetchQueries({ queryKey: ["sources"] });
  });
  expect(await screen.findByText("暂时无法加载来源")).toBeTruthy();
  expect(
    within(
      screen.getByRole("combobox", { name: "出口连接" }).closest("label")!,
    ).getByText("家庭出口 · 暂不可用").textContent,
  ).toBe("家庭出口 · 暂不可用");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  state.sourceFailure = false;
  state.sources = [];
  await user.click(screen.getByRole("button", { name: "重新加载来源" }));
  expect(await screen.findByText("家庭出口 · 已不可用")).toBeTruthy();
  expect(
    screen
      .getByRole("radio", { name: "跟随版本" })
      .getAttribute("aria-checked") === "true",
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(writes).toEqual([]);
});
it("does not silently replace a deleted selected target", async () => {
  const { choose, state, client, writes } = await selectionFixture({
    slots: false,
  });
  await choose("模板目标", "家庭配置");
  state.profiles = [{ ...state.profiles[0], id: "other", name: "另一配置" }];
  await act(async () => {
    await client.refetchQueries({ queryKey: ["profiles"] });
  });
  expect(
    await screen.findByText("所选草稿已不可用，请重新选择。"),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("combobox", { name: "模板目标" }).closest("label")!,
    ).getByText("家庭配置 · 已不可用").textContent,
  ).toBe("家庭配置 · 已不可用");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(writes).toEqual([]);
});
it("recovers the target list without turning a service failure into an empty list", async () => {
  const { state, user, choose, writes } = await selectionFixture({
    slots: false,
    profileFailure: true,
  });
  expect(await screen.findByText("暂时无法加载客户端配置")).toBeTruthy();
  expect(screen.queryByText(/暂无可用草稿/)).toBeNull();
  state.profileFailure = false;
  await user.click(screen.getByRole("button", { name: "重新加载客户端配置" }));
  await choose("模板目标", "家庭配置");
  expect(writes).toEqual([]);
});

it("preserves a selected binding during a delayed reload and restores it without a write", async () => {
  const { choose, state, client, writes } = await selectionFixture();
  await choose("模板目标", "家庭配置");
  await choose("出口连接", "家庭出口");
  let release!: () => void;
  state.sourceWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.refetchQueries({ queryKey: ["sources"] });
  });
  expect(await screen.findByText("正在读取来源列表…")).toBeTruthy();
  expect(screen.queryByText("暂无可用连接")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    release();
    await refresh;
  });
  expect(await screen.findByText("家庭出口")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(writes).toEqual([]);
});
it("keeps paused directory reads distinct from empty and resumes without replaying apply", async () => {
  const { choose, client, writes } = await selectionFixture();
  await choose("模板目标", "家庭配置");
  await choose("出口连接", "家庭出口");
  act(() => {
    onlineManager.setOnline(false);
    void client.refetchQueries({ queryKey: ["sources"] });
  });
  expect(
    await screen.findByText("来源列表读取已暂停，恢复网络后重试。"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  act(() => {
    onlineManager.setOnline(true);
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "应用模板到草稿" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(
    within(
      screen.getByRole("combobox", { name: "出口连接" }).closest("label")!,
    ).getByText("家庭出口").textContent,
  ).toBe("家庭出口");
  expect(writes).toEqual([]);
});

it("requires the preset target list and retries its failure without loading profile dependencies", async () => {
  const { state, user, choose, writes } = await selectionFixture({
    preset: true,
    collectionFailure: true,
  });
  expect(await screen.findByText("暂时无法加载节点集合")).toBeTruthy();
  expect(screen.queryByText(/暂无可用草稿/)).toBeNull();
  state.collectionFailure = false;
  await user.click(screen.getByRole("button", { name: "重新加载节点集合" }));
  await choose("模板目标", "家庭集合");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(false);
  expect(writes).toEqual([]);
});
it("recovers collection-backed connection candidates in place", async () => {
  const { state, client, user, choose, writes } = await selectionFixture({
    collectionReference: true,
  });
  await choose("模板目标", "家庭配置");
  await choose("出口连接", "家庭出口");
  state.collectionFailure = true;
  await act(async () => {
    await client.refetchQueries({ queryKey: ["collections"] });
  });
  expect(await screen.findByText("暂时无法加载节点集合")).toBeTruthy();
  expect(
    within(
      screen.getByRole("combobox", { name: "出口连接" }).closest("label")!,
    ).getByText("家庭出口 · 暂不可用").textContent,
  ).toBe("家庭出口 · 暂不可用");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  state.collectionFailure = false;
  await user.click(screen.getByRole("button", { name: "重新加载节点集合" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "应用模板到草稿" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(
    within(
      screen.getByRole("combobox", { name: "出口连接" }).closest("label")!,
    ).getByText("家庭出口").textContent,
  ).toBe("家庭出口");
  expect(writes).toEqual([]);
});
it("requires a readable selected version rather than silently falling back to the library card", async () => {
  const { state, user, choose, writes } = await selectionFixture({
    slots: false,
    versionFailure: true,
  });
  await choose("模板目标", "家庭配置");
  expect(await screen.findByText("暂时无法加载模板版本")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  state.versionFailure = false;
  await user.click(screen.getByRole("button", { name: "重新加载模板版本" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "应用模板到草稿" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(writes).toEqual([]);
});

it("keeps a removed selected version visible instead of applying the newest version", async () => {
  const { state, client, choose, writes } = await selectionFixture({
    slots: false,
  });
  await choose("模板目标", "家庭配置");
  await choose("模板版本", /^v1 ·/);
  state.versions = state.versions.filter((v) => v.version !== 1);
  await act(async () => {
    await client.refetchQueries({ queryKey: ["template-versions", "routing"] });
  });
  expect(
    await screen.findByText("所选模板版本已不可用，请重新选择。"),
  ).toBeTruthy();
  expect(
    within(
      screen.getByRole("combobox", { name: "模板版本" }).closest("label")!,
    ).getByText("v1 · 已不可用").textContent,
  ).toBe("v1 · 已不可用");
  expect(
    screen
      .getByRole("button", { name: "应用模板到草稿" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(writes).toEqual([]);
});

it("preserves the selected target, pinned version and binding through a held source reload, failure, and explicit recovery", async () => {
  const { choose, state, client, user, writes } = await selectionFixture();
  await choose("模板目标", "家庭配置");
  await choose("模板版本", /^v1 ·/);
  await choose("出口连接", "家庭出口");
  await user.click(screen.getByRole("radio", { name: "固定此版本" }));
  let release!: () => void;
  state.sourceWait = new Promise<void>((resolve) => { release = resolve; });
  state.sourceFailure = true;
  let refresh!: Promise<void>;
  act(() => { refresh = client.refetchQueries({ queryKey: ["sources"] }); });
  await screen.findByText("正在读取来源列表…");
  expect(screen.queryByText("暂无可用连接")).toBeNull();
  expect(screen.getByRole("button", { name: "应用模板到草稿" }).hasAttribute("disabled")).toBe(true);
  await act(async () => { release(); await refresh; });
  await screen.findByText("暂时无法加载来源");
  expect(screen.queryByText("暂无可用连接")).toBeNull();
  expect(screen.getByRole("combobox", { name: "出口连接" }).textContent).toContain("家庭出口 · 暂不可用");
  expect(screen.getByRole("combobox", { name: "模板目标" }).textContent).toContain("家庭配置");
  expect(screen.getByRole("combobox", { name: "模板版本" }).textContent).toContain("v1");
  expect(screen.getByRole("radio", { name: "固定此版本" }).getAttribute("aria-checked")).toBe("true");
  state.sourceFailure = false;
  await user.click(screen.getByRole("button", { name: "重新加载来源" }));
  await waitFor(() => expect(screen.queryByText("暂时无法加载来源")).toBeNull());
  expect(screen.getByRole("combobox", { name: "出口连接" }).textContent).toContain("家庭出口");
  expect(screen.getByRole("combobox", { name: "出口连接" }).textContent).not.toContain("不可用");
  expect(screen.getByRole("button", { name: "应用模板到草稿" }).hasAttribute("disabled")).toBe(false);
  expect(writes).toEqual([]);
});

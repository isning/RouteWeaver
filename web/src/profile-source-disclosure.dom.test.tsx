// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { ClientNode, Output, Profile, Source } from "./types";

const node = (id: string, name: string): ClientNode => ({
  id,
  name,
  origin: "imported",
  connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
});
const effective = [
  node("tokyo", "Tokyo accepted"),
  node("london", "London accepted"),
];
const source: Source = {
  id: "travel-source",
  name: "Travel source",
  kind: "text",
  enabled: true,
  snapshot: {
    endpoints: [...effective, node("filtered", "Raw filtered node")],
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "/");
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
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  const profile = {
    ...emptyProfile(),
    id: "intent-profile",
    name: "Travel configuration",
    sourceIds: [source.id],
  };
  profile.ir.name = profile.name;
  return profile;
}
function mount(
  profile: Profile = fixture(),
  options: {
    output?: Output;
    inputFailure?: boolean;
    isNew?: boolean;
    pausedSource?: boolean;
    holdInputs?: boolean;
    collectionFailure?: boolean;
  } = {},
) {
  const writes: { path: string; body: any }[] = [];
  const savedSources = [{ ...source, enabled: !options.pausedSource }];
  let resolveInputs: (() => void) | undefined;
  const inputWait = new Promise<void>((resolve) => {
    resolveInputs = resolve;
  });
  const onClose = vi.fn();
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/me/collections" && options.collectionFailure)
      return json({ detail: "Collection inventory failed" }, 503);
    if (path === "/api/me/collections/preview") {
      if (options.holdInputs) await inputWait;
      return options.inputFailure
        ? json({ detail: "Accepted source is unavailable" }, 503)
        : json({ endpoints: effective, stages: [] });
    }
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/api/me/sources") {
        const savedSource = { ...body, snapshot: { endpoints: effective } };
        savedSources.push(savedSource);
        return json(savedSource);
      }
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "checked-phone",
          outputId: options.output?.id,
          artifacts: [{ path: "config.json", content: "checked exact client" }],
        });
      return json(body);
    }
    return json(
      path.endsWith("/sources")
        ? savedSources
        : path.endsWith("/resources")
          ? profile.ir.resources
          : path.endsWith("/outputs") && options.output
            ? [options.output]
            : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={options.isNew || false}
          output={options.output}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    releaseInputs: () => resolveInputs?.(),
    fetcher,
    onClose,
    unmount: view.unmount,
    editor: within(view.container),
  };
}

it("keeps the actual default visible while existing source setup is folded without changing the draft", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "kept-rule",
      match: { op: "domain-suffix", value: "chatgpt.com" },
      action: { kind: "direct" },
    },
  ];
  const { editor, writes, onClose } = mount(profile);
  const toggle = await editor.findByRole("button", {
    name: "编辑来源",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(editor.queryByRole("combobox", { name: "使用的订阅来源" })).toBeNull();
  expect(editor.getByRole("combobox", { name: "默认流量行为" })).toBeTruthy();
  await editor.findByText("2 个有效连接");
  const user = userEvent.setup();
  await user.click(toggle);
  const sourceField = editor.getByRole("combobox", { name: "使用的订阅来源" });
  await user.click(editor.getByRole("button", { name: "收起来源设置" }));
  expect(sourceField.isConnected).toBe(true);
  expect(editor.queryByRole("combobox", { name: "使用的订阅来源" })).toBeNull();
  await user.click(editor.getByRole("button", { name: "返回" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(writes).toEqual([]);
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
});

it("starts new source setup expanded without making a proxy input mandatory", async () => {
  const profile = { ...emptyProfile(), name: "Direct only" };
  const { editor, writes } = mount(profile, { isNew: true });
  expect(
    editor
      .getByRole("button", { name: "收起来源设置" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(editor.getByRole("combobox", { name: "使用的订阅来源" })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(editor.getByRole("button", { name: "收起来源设置" }));
  expect(editor.getByRole("combobox", { name: "默认流量行为" })).toBeTruthy();
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.sourceIds || []).toEqual([]);
  expect(writes[0].body.ir.defaultAction).toEqual({ kind: "direct" });
});

it("retains source choice and rule intent across disclosure and keyboard navigation", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "unchanged",
      match: { op: "domain", value: "chatgpt.com" },
      action: { kind: "direct" },
    },
  ];
  const { editor, writes } = mount(profile);
  await editor.findByText("2 个有效连接");
  const user = userEvent.setup();
  await user.click(editor.getByRole("button", { name: "编辑来源" }));
  const radio = editor.getByRole("radio", { name: "使用节点集合" });
  await user.click(radio);
  await user.click(editor.getByRole("button", { name: "收起来源设置" }));
  const toggle = editor.getByRole("button", { name: "编辑来源" });
  expect(document.activeElement).toBe(toggle);
  await user.tab();
  expect(document.activeElement).toBe(
    editor.getByRole("combobox", { name: "默认流量行为" }),
  );
  await user.click(toggle);
  expect(
    editor
      .getByRole("radio", { name: "使用节点集合" })
      .getAttribute("aria-checked") === "true",
  ).toBe(true);
  await user.click(editor.getByRole("radio", { name: "直接选择来源" }));
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.sourceIds).toEqual(profile.sourceIds);
  expect(writes[0].body.ir.rules).toEqual(profile.ir.rules);
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
});

it("shows pending effective input state while folded and never auto-expands or mutates on completion", async () => {
  const { editor, releaseInputs, writes } = mount(fixture(), {
    holdInputs: true,
  });
  await editor.findByText("正在计算有效连接…");
  expect(
    editor
      .getByRole("button", { name: "编辑来源" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  releaseInputs();
  await editor.findByText("2 个有效连接");
  expect(editor.queryByRole("combobox", { name: "使用的订阅来源" })).toBeNull();
  expect(editor.getAllByText("2 个有效连接")).toHaveLength(1);
  expect(writes).toEqual([]);
});

it("keeps unavailable source repair visible and opens the real selector when removing its reference", async () => {
  const { editor, writes } = mount(fixture(), { pausedSource: true });
  const issues = await editor.findByRole("region", { name: "需要处理的来源" });
  expect(editor.queryByRole("combobox", { name: "使用的订阅来源" })).toBeNull();
  expect(
    within(issues).getByRole("button", { name: "编辑来源 Travel source" }),
  ).toBeTruthy();
  const user = userEvent.setup();
  await user.click(
    within(issues).getByRole("button", { name: "移除来源 Travel source" }),
  );
  expect(document.activeElement).toBe(
    editor.getByRole("combobox", { name: "使用的订阅来源" }),
  );
  expect(editor.getByRole("button", { name: "收起来源设置" })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("keeps failed effective inputs and retry outside the folded setup", async () => {
  const { editor } = mount(fixture(), { inputFailure: true });
  await editor.findByText("有效连接暂不可用");
  expect(editor.getByRole("button", { name: "重新计算有效连接" })).toBeTruthy();
  expect(editor.getByRole("button", { name: "编辑来源" })).toBeTruthy();
  expect(editor.queryByRole("combobox", { name: "使用的订阅来源" })).toBeNull();
});

it("keeps a source-add session owned by the expanded editor and returns to its visible trigger on cancellation", async () => {
  const { editor, writes } = mount();
  const user = userEvent.setup();
  await user.click(await editor.findByRole("button", { name: "编辑来源" }));
  const add = editor.getByRole("button", { name: "添加来源" });
  await user.click(add);
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  expect(dialog).toBeTruthy();
  expect(add.closest("[inert]")).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: /^取\s*消$/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull(),
  );
  expect(document.activeElement).toBe(add);
  expect(
    editor
      .getByRole("button", { name: "收起来源设置" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  await user.click(editor.getByRole("button", { name: "收起来源设置" }));
  expect(editor.queryByRole("button", { name: "添加来源" })).toBeNull();
  expect(writes).toEqual([]);
});

it("shows a failed initial collection catalog without claiming an active check or losing selection", async () => {
  const profile = { ...fixture(), collectionId: "retained-collection" };
  const { editor, writes } = mount(profile, { collectionFailure: true });
  await editor.findByText("暂无法核对所选集合，原选择已保留");
  expect(editor.getByRole("button", { name: "重新加载集合" })).toBeTruthy();
  expect(
    editor
      .getByRole("button", { name: "编辑来源" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(editor.queryByText("正在核对所选集合…")).toBeNull();
  expect(editor.queryByText("2 个有效连接")).toBeNull();
  expect(editor.getByRole("combobox", { name: "默认流量行为" })).toBeTruthy();
  await userEvent.click(editor.getByRole("button", { name: "编辑来源" }));
  expect(
    editor.getByRole("combobox", { name: "复用节点集合" }).closest("label")
      ?.textContent,
  ).toContain("retained-collection");
  expect(writes).toEqual([]);
});

it("describes an offline collection check as waiting, not actively checking or successful", async () => {
  onlineManager.setOnline(false);
  const profile = { ...fixture(), collectionId: "retained-collection" };
  const { editor, writes } = mount(profile);
  await editor.findByText("等待核对所选集合，原选择已保留");
  expect(editor.getByText("等待核对有效连接…")).toBeTruthy();
  expect(editor.queryByText("正在核对所选集合…")).toBeNull();
  expect(editor.queryByText("正在计算有效连接…")).toBeNull();
  expect(editor.queryByText("2 个有效连接")).toBeNull();
  expect(
    editor
      .getByRole("button", { name: "编辑来源" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(editor.getByRole("combobox", { name: "默认流量行为" })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("returns focus only after dirty source cancellation releases its confirmation owner", async () => {
  const { editor, writes } = mount();
  const user = userEvent.setup();
  await user.click(await editor.findByRole("button", { name: "编辑来源" }));
  const add = editor.getByRole("button", { name: "添加来源" });
  await user.click(add);
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  await user.type(
    within(dialog).getByRole("textbox", { name: "来源名称" }),
    "Retained source",
  );
  await user.click(within(dialog).getByRole("button", { name: /^取\s*消$/ }));
  let confirmation = await screen.findByRole("alertdialog", {
    name: "放弃尚未保存的来源修改？",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "继续编辑" }),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "来源名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Retained source");
  await user.click(within(dialog).getByRole("button", { name: /^取\s*消$/ }));
  confirmation = await screen.findByRole("alertdialog", {
    name: "放弃尚未保存的来源修改？",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Radix schedules unmount autofocus after DOM removal, and the task overlay
  // restores focus in a microtask. Observe that handoff separately from absence.
  await waitFor(() => expect(document.activeElement).toBe(add));
  expect(writes).toEqual([]);
});

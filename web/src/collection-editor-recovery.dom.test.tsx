// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionsPage } from "./Sources";
import { UIProviders } from "./ui-patterns/providers";
import { getNavigationWarning, hasNavigationWarning, hasUnsavedChanges } from "./navigation";
import type { Collection, Source } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const opened: Collection = {
  id: "travel", name: "Travel", revisionToken: "opened-r1",
  sources: [
    { sourceId: "one", steps: [{ id: "rename", kind: "rename", enabled: true, template: "{name}-one" }] },
    { sourceId: "two", steps: [{ id: "override", kind: "override", enabled: false, override: { port: 1080 } }] },
  ],
  steps: [{ id: "merged", kind: "rename", enabled: true, template: "{name}-merged" }],
};
const current: Collection = {
  id: "travel", name: "Current recipe", revisionToken: "current-r2",
  sources: [{ sourceId: "two", steps: [{ id: "override", kind: "override", enabled: true, override: { port: 2080 } }] }],
  steps: [{ id: "current-merged", kind: "rename", enabled: false, template: "{name}-current" }],
};
const providers: Source[] = ["one", "two"].map((id) => ({
  id, name: `Provider ${id}`, kind: "text", enabled: true, snapshot: { endpoints: [] },
}));
const conflict = () => json({ code: "COLLECTION_DRAFT_CHANGED", message: "Untrusted conflict detail" }, 409);
const clients: QueryClient[] = [];
function mount(cachedCollections?: unknown[], cachedSources?: Source[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false, networkMode: "always" } } });
  clients.push(client);
  if (cachedCollections) client.setQueryData(["collections"], cachedCollections);
  if (cachedSources) client.setQueryData(["sources"], cachedSources);
  const tree = (key: string) => <QueryClientProvider client={client}>
    <UIProviders><CollectionsPage key={key} /></UIProviders>
  </QueryClientProvider>;
  const view = render(tree("first"));
  return { client, replace: () => view.rerender(tree("next")) };
}
type Write = { path: string; method: string; body: Collection; headers: Headers };
function api(options: {
  collections?: unknown[];
  list?: () => Promise<Response>;
  save?: (value: Collection, attempt: number) => Promise<Response>;
  read?: () => Promise<Response>;
  preview?: (value: Collection) => Promise<Response>;
  createSource?: (value: Source) => Promise<Response>;
  sourceList?: () => Promise<Response>;
} = {}) {
  const writes: Write[] = [], reads: string[] = [], previews: Collection[] = [];
  let collections = options.collections ?? [opened], sources = providers;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    if (init?.method) {
      const body = JSON.parse(String(init.body));
      if (path === "/me/collections/preview") {
        previews.push(body);
        return options.preview ? options.preview(body) : json({ endpoints: [] });
      }
      if (path === "/me/sources" && options.createSource) {
        const response = await options.createSource(body);
        if (response.ok) sources = [...sources, await response.clone().json()];
        return response;
      }
      writes.push({ path, method: init.method, body, headers: new Headers(init.headers) });
      return options.save ? options.save(body, writes.length) : conflict();
    }
    if (path === "/me/collections") return options.list ? options.list() : json(collections);
    if (path === "/me/sources") return options.sourceList ? options.sourceList() : json(sources);
    if (path === "/me/collections/travel") {
      reads.push(path);
      return options.read ? options.read() : json(current);
    }
    throw new Error(`Unexpected read ${path}`);
  }));
  return { writes, reads, previews, refresh: () => { collections = [current]; } };
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(async () => {
  await act(async () => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });
  onlineManager.setOnline(true);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function openRecipe() {
  await userEvent.click(await screen.findByRole("button", { name: /^Travel.*编辑集合/ }));
  return within(await screen.findByRole("dialog", { name: "Travel" }));
}
async function editAndConflict(beforeSave?: () => Promise<void>) {
  const editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Local recipe" } });
  await userEvent.click(editor.getByRole("button", { name: "上移来源 2" }));
  await userEvent.click(editor.getByRole("button", { name: /^2\. Provider one/ }));
  const firstSource = within(editor.getByRole("group", { name: /^2\. Provider one/ }));
  fireEvent.change(firstSource.getByLabelText("步骤 1 命名模板"), { target: { value: "{name}-local-source" } });
  fireEvent.change(within(editor.getByRole("group", { name: "合并后处理" })).getByLabelText("步骤 1 命名模板"),
    { target: { value: "{name}-local-merged" } });
  await beforeSave?.();
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await editor.findByRole("button", { name: "读取最新集合" });
  return editor;
}
async function reloadReview(editor: ReturnType<typeof within>) {
  await userEvent.click(editor.getByRole("button", { name: "读取最新集合" }));
  return within(await screen.findByRole("alertdialog", { name: "放弃当前修改并读取最新集合？" }));
}
async function confirmReload(editor: ReturnType<typeof within>) {
  const review = await reloadReview(editor);
  await userEvent.click(review.getByRole("button", { name: "放弃修改并读取" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}

it("keeps the opened revision and complete local recipe through refetch and cancellation, then replaces it only after an explicit successful read", async () => {
  const f = api({ save: async (value, attempt) => attempt === 1 ? conflict() : json({ ...value, revisionToken: "saved-r3" }) });
  const host = mount();
  const editor = await editAndConflict(async () => {
    f.refresh();
    await act(async () => { await host.client.refetchQueries({ queryKey: ["collections"] }); });
  });
  expect(f.writes[0].headers.get("If-Match")).toBe("opened-r1");
  expect(f.writes[0].body).toEqual({
    id: "travel", name: "Local recipe",
    sources: [opened.sources[1], { sourceId: "one", steps: [{ id: "rename", kind: "rename", enabled: true, template: "{name}-local-source" }] }],
    steps: [{ id: "merged", kind: "rename", enabled: true, template: "{name}-local-merged" }],
  });
  expect(editor.queryByText("Untrusted conflict detail")).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  f.refresh();
  await act(async () => { await host.client.refetchQueries({ queryKey: ["collections"] }); });
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local recipe");
  expect((editor.getByRole("button", { name: "保存集合" }) as HTMLButtonElement).disabled).toBe(true);
  const review = await reloadReview(editor);
  expect(review.getByText("这会替换集合名称、来源选择、顺序和处理步骤。已保存的来源和已发布订阅不会改变。")).toBeTruthy();
  await userEvent.click(review.getByRole("button", { name: "保留当前输入" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local recipe");
  expect(f.reads).toEqual([]);
  expect(f.writes).toHaveLength(1);
  await confirmReload(editor);
  await waitFor(() => expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Current recipe"));
  await waitFor(() => expect(document.activeElement).toBe(editor.getByLabelText("集合名称")));
  expect(hasUnsavedChanges()).toBe(false);
  expect(editor.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(editor.queryByRole("button", { name: /Provider one/ })).toBeNull();
  expect(editor.getByRole("button", { name: /^1\. Provider two/ }).getAttribute("aria-expanded")).toBe("false");
  expect((editor.getByLabelText("步骤 1 命名模板") as HTMLInputElement).value).toBe("{name}-current");
  expect(f.writes).toHaveLength(1);
  await userEvent.click(editor.getByRole("button", { name: "预览处理结果" }));
  await editor.findByText("逐阶段预览");
  expect(f.previews).toEqual([{ id: "travel", name: "Current recipe", sources: current.sources, steps: current.steps }]);
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Fresh edit" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].headers.get("If-Match")).toBe("current-r2");
  expect(f.writes[1].body).toEqual({ id: "travel", name: "Fresh edit", sources: current.sources, steps: current.steps });
});

it.each([
  ["failed", () => json({ message: "Latest collection unavailable" }, 503)],
  ["foreign identity", () => json({ ...current, id: "other-collection" })],
  ["missing revision", () => json({ ...current, revisionToken: undefined })],
  ["missing aggregate steps", () => json({ ...current, steps: undefined })],
  ["partial source recipe", () => json({ ...current, sources: [{ sourceId: "two" }] })],
] as const)("keeps raw port input, disclosure and the full recipe after a %s reload", async (problem, response) => {
  let validRead = false;
  const f = api({ read: async () => validRead ? json(current) : response() });
  mount();
  const editor = await editAndConflict();
  const sourceTwo = editor.getByRole("button", { name: /^1\. Provider two/ });
  await userEvent.click(sourceTwo);
  fireEvent.change(editor.getByLabelText("覆盖端口"), { target: { value: "443.5" } });
  await confirmReload(editor);
  await editor.findByText(problem === "failed" ? "Latest collection unavailable" : "未能读取完整的最新集合，当前输入已保留。请重试。");
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local recipe");
  expect((editor.getByLabelText("覆盖端口") as HTMLInputElement).value).toBe("443.5");
  expect(sourceTwo.getAttribute("aria-expanded")).toBe("true");
  expect(editor.getByRole("button", { name: /^2\. Provider one/ }).getAttribute("aria-expanded")).toBe("true");
  expect((within(editor.getByRole("group", { name: /^2\. Provider one/ })).getByLabelText("步骤 1 命名模板") as HTMLInputElement).value).toBe("{name}-local-source");
  expect((within(editor.getByRole("group", { name: "合并后处理" })).getByLabelText("步骤 1 命名模板") as HTMLInputElement).value).toBe("{name}-local-merged");
  expect((editor.getByRole("button", { name: "保存集合" }) as HTMLButtonElement).disabled).toBe(true);
  expect(hasUnsavedChanges()).toBe(true);
  expect(f.writes).toHaveLength(1);
  validRead = true;
  await confirmReload(editor);
  await waitFor(() => expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Current recipe"));
  await userEvent.click(editor.getByRole("button", { name: /^1\. Provider two/ }));
  expect((editor.getByLabelText("覆盖端口") as HTMLInputElement).value).toBe("2080");
  expect(hasUnsavedChanges()).toBe(false);
  expect(f.writes).toHaveLength(1);
});

it("retains an independently saved nested source notice after canceled and failed collection recovery", async () => {
  const f = api({
    read: async () => json({ message: "Latest collection unavailable" }, 503),
    createSource: async (source) => json({ ...source, enabled: false, revision: "saved-source-r1", snapshot: { endpoints: [] } }),
  });
  mount();
  let editor = await editAndConflict();
  await userEvent.click(editor.getByRole("button", { name: "添加来源" }));
  const source = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
  fireEvent.change(source.getByLabelText("来源名称"), { target: { value: "Saved provider needs work" } });
  fireEvent.change(source.getByLabelText("节点链接或配置内容"), { target: { value: "socks5://synthetic.example:1080#Synthetic" } });
  await userEvent.click(source.getByRole("button", { name: "导入来源" }));
  editor = within(await screen.findByRole("dialog", { name: "Local recipe" }));
  await editor.findByText("来源尚未加入集合");
  const review = await reloadReview(editor);
  await userEvent.click(review.getByRole("button", { name: "保留当前输入" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await confirmReload(editor);
  await editor.findByText("Latest collection unavailable");
  expect(editor.getByText("「Saved provider needs work」已单独保存，尚未加入当前集合。")).toBeTruthy();
  expect(editor.getByRole("button", { name: "继续编辑" })).toBeTruthy();
  expect(editor.getByRole("button", { name: /^2\. Provider one/ }).getAttribute("aria-expanded")).toBe("true");
  expect(f.writes).toHaveLength(1);
});

it("owns one recovery through duplicate gestures, blocks pending dismissal, and ignores a late read after replacement", async () => {
  let finish: ((response: Response) => void) | undefined;
  const f = api({ read: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  const host = mount();
  const editor = await editAndConflict();
  const reload = editor.getByRole("button", { name: "读取最新集合" });
  expect(fireEvent.keyDown(reload, { key: "Enter", repeat: true })).toBe(false);
  await userEvent.dblClick(reload);
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  await userEvent.dblClick(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃修改并读取" }));
  await waitFor(() => expect(f.reads).toHaveLength(1));
  expect(editor.getByLabelText("集合名称").matches(":disabled")).toBe(true);
  expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
  expect((editor.getByRole("button", { name: "保存集合" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(editor.getByRole("button", { name: "添加来源" }));
  fireEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Local recipe" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  host.replace();
  const next = await openRecipe();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "New owner local recipe" } });
  await act(async () => finish!(json(current)));
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("New owner local recipe");
  expect(next.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(hasUnsavedChanges()).toBe(true);
});

it.each(["success", "failure"] as const)("does not let a late save %s close or change a replacement editor", async (outcome) => {
  let finish: ((response: Response) => void) | undefined;
  const f = api({ save: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  const host = mount();
  const editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Old owner edit" } });
  const save = editor.getByRole("button", { name: "保存集合" });
  expect(fireEvent.keyDown(save, { key: "Enter", repeat: true })).toBe(false);
  await userEvent.dblClick(save);
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Old owner edit" })).toBeTruthy();
  host.replace();
  const next = await openRecipe();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "New owner edit" } });
  await act(async () => finish!(outcome === "success" ? json({ ...opened, name: "Old owner edit" }) : conflict()));
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("New owner edit");
  expect(next.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(screen.queryByText("集合已保存")).toBeNull();
  expect(f.writes).toHaveLength(1);
});

it("does not treat an unknown conflict as a proven collection draft conflict", async () => {
  const f = api({ save: async () => json({ message: "Unknown save result" }, 409) });
  mount();
  const editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Local recipe" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await editor.findByText("Unknown save result");
  expect(editor.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect((editor.getByRole("button", { name: "保存集合" }) as HTMLButtonElement).disabled).toBe(false);
  expect(f.writes).toHaveLength(1);
});

it.each(["typed conflict", "lost response"] as const)("retains new collection input on %s with guarded creation and explicit recovery", async (problem) => {
  const f = api({ save: async () => {
    if (problem === "lost response") throw new TypeError("Synthetic lost response");
    return conflict();
  } });
  mount();
  await userEvent.click((await screen.findAllByRole("button", { name: "新建集合" }))[0]);
  const editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "New local recipe" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await editor.findByText(problem === "lost response" ? "集合保存结果尚未确认" : "集合或来源已变化");
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("New local recipe");
  expect(editor.getByRole("button", { name: "读取最新集合" })).toBeTruthy();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].method).toBe("POST");
  expect(f.writes[0].headers.has("If-Match")).toBe(false);
  expect(f.writes[0].headers.get("If-None-Match")).toBe("*");
  expect(hasUnsavedChanges()).toBe(true);
});

it.each(["success", "failure"] as const)("ignores a preview %s from a closed collection opening", async (outcome) => {
  let finish: ((response: Response) => void) | undefined;
  const f = api({ preview: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  mount();
  const editor = await openRecipe();
  await userEvent.click(editor.getByRole("button", { name: "预览处理结果" }));
  await waitFor(() => expect(f.previews).toHaveLength(1));
  await userEvent.click(editor.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const next = await openRecipe();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "New opening" } });
  await act(async () => finish!(outcome === "success" ? json({ endpoints: [] }) : json({ message: "Old preview failed" }, 503)));
  expect(next.queryByText("逐阶段预览")).toBeNull();
  expect(next.queryByText("Old preview failed")).toBeNull();
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("New opening");
});

it.each(["empty collection", "empty source steps"] as const)("normalizes present legacy null slices for a %s without dropping its guarded editing identity", async (shape) => {
  const recipe = { ...opened, sources: shape === "empty collection" ? null : [{ sourceId: "one", steps: null }], steps: null };
  const expectedSources = shape === "empty collection" ? [] : [{ sourceId: "one", steps: [] }];
  const f = api({
    collections: [recipe],
    read: async () => json({ ...recipe, name: "Current recipe", revisionToken: "current-null-r2" }),
    save: async (value, attempt) => attempt === 1 ? conflict() : json({ ...value, revisionToken: "saved-null-r3" }),
  });
  mount();
  const editor = await openRecipe();
  expect(hasUnsavedChanges()).toBe(false);
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Local null edit" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await editor.findByRole("button", { name: "读取最新集合" });
  expect(f.writes[0].body).toEqual({ id: "travel", name: "Local null edit", sources: expectedSources, steps: [] });
  expect(f.writes[0].headers.get("If-Match")).toBe("opened-r1");
  await confirmReload(editor);
  await waitFor(() => expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Current recipe"));
  expect(hasUnsavedChanges()).toBe(false);
  await userEvent.click(editor.getByRole("button", { name: "预览处理结果" }));
  await editor.findByText("逐阶段预览");
  expect(f.previews).toEqual([{ id: "travel", name: "Current recipe", sources: expectedSources, steps: [] }]);
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Fresh null edit" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes[1].headers.get("If-Match")).toBe("current-null-r2");
  expect(f.writes[1].body).toEqual({ id: "travel", name: "Fresh null edit", sources: expectedSources, steps: [] });
});

it.each(["empty collection", "empty source steps"] as const)("opens a cached legacy %s before a delayed refetch fails, preserving the opened revision", async (shape) => {
  let finish: ((response: Response) => void) | undefined;
  const cached = { ...opened, sources: shape === "empty collection" ? null : [{ sourceId: "one", steps: null }], steps: null };
  const f = api({ list: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  mount([cached]);
  const editor = await openRecipe();
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Travel");
  expect(hasUnsavedChanges()).toBe(false);
  await act(async () => finish!(json({ message: "Collection list unavailable" }, 503)));
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Retained cached edit" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await editor.findByRole("button", { name: "读取最新集合" });
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].headers.get("If-Match")).toBe("opened-r1");
  expect(f.writes[0].body).toEqual({
    id: "travel", name: "Retained cached edit", steps: [],
    sources: shape === "empty collection" ? [] : [{ sourceId: "one", steps: [] }],
  });
});


it("distinguishes a cached empty source list being refreshed from a confirmed empty list", async () => {
  let finish: ((response: Response) => void) | undefined;
  api({ sourceList: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  mount(undefined, []);
  const editor = await openRecipe();
  expect(editor.queryByText("暂无可选来源")).toBeNull();
  expect(editor.getByText("正在更新可选来源，当前显示上次读取结果。")).toBeTruthy();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Retained local name" } });
  await act(async () => finish!(json([])));
  expect(await editor.findByText("暂无可选来源")).toBeTruthy();
  expect(editor.queryByText("正在更新可选来源，当前显示上次读取结果。")).toBeNull();
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Retained local name");
  expect(editor.getByRole("button", { name: /^1\. one/ })).toBeTruthy();
});

it("identifies a paused initial source read and resumes without replacing the collection draft", async () => {
  api();
  onlineManager.setOnline(false);
  mount([opened]);
  await userEvent.click(screen.getAllByRole("button", { name: "新建集合" })[0]);
  const editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  expect(editor.getByText("等待网络连接，恢复后将继续加载可选来源。")).toBeTruthy();
  expect(editor.queryByText("正在加载可选来源…")).toBeNull();
  expect(editor.queryByText("暂无可选来源")).toBeNull();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Offline draft" } });
  await act(async () => onlineManager.setOnline(true));
  await waitFor(() => expect((editor.getByLabelText("订阅来源") as HTMLButtonElement).disabled).toBe(false));
  expect(editor.queryByText("等待网络连接，恢复后将继续加载可选来源。")).toBeNull();
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Offline draft");
});

it.each([false, true])("does not send an offline collection save after its editor is abandoned (creating=%s)", async (creating) => {
  const f = api({ save: async (value) => json(value) });
  const host = mount();
  let editor: ReturnType<typeof within>;
  if (creating) {
    await userEvent.click((await screen.findAllByRole("button", { name: "新建集合" }))[0]);
    editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  } else editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Abandoned recipe" } });
  onlineManager.setOnline(false);
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  expect(f.writes).toEqual([]);
  host.replace();
  await act(async () => { onlineManager.setOnline(true); await host.client.resumePausedMutations(); });
  expect(f.writes).toEqual([]);
  expect(screen.queryByText("集合已保存")).toBeNull();
});

it.each([false, true])("keeps an offline save editable and requires a fresh save after reconnect (creating=%s)", async (creating) => {
  const f = api({ save: async (value) => json(value) });
  const host = mount();
  let editor: ReturnType<typeof within>;
  if (creating) {
    await userEvent.click((await screen.findAllByRole("button", { name: "新建集合" }))[0]);
    editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  } else editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Offline recipe" } });
  onlineManager.setOnline(false);
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  expect(await editor.findByText("当前离线，集合未保存。请联网后重新保存。")).toBeTruthy();
  expect(editor.queryByText("集合保存结果尚未确认")).toBeNull();
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).disabled).toBe(false);
  expect((editor.getByRole("button", { name: "保存集合" }) as HTMLButtonElement).disabled).toBe(false);
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Revised offline recipe" } });
  await act(async () => { onlineManager.setOnline(true); await host.client.resumePausedMutations(); });
  expect(f.writes).toEqual([]);
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].method).toBe(creating ? "POST" : "PUT");
  expect(f.writes[0].body.name).toBe("Revised offline recipe");
});


it("warns that leaving cannot cancel a collection save already sent, without applying its late feedback to a new editor", async () => {
  let finish!: (response: Response) => void;
  const f = api({ save: () => new Promise<Response>((resolve) => { finish = resolve; }) });
  const host = mount();
  const editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Sent recipe" } });
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(hasNavigationWarning()).toBe(true);
  expect(getNavigationWarning()).toBe("集合正在保存，离开不会取消已发送的请求。请返回后核对保存结果。");
  host.replace();
  const next = await openRecipe();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "New editor recipe" } });
  await act(async () => finish(json(f.writes[0].body)));
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("New editor recipe");
  expect(screen.queryByText("集合已保存")).toBeNull();
  expect(hasNavigationWarning()).toBe(false);
});

it.each([false, true])("does not send when an online save loses its editor before dispatch (creating=%s)", async (creating) => {
  const f = api({ save: async (value) => json(value) });
  const host = mount();
  let editor: ReturnType<typeof within>;
  if (creating) {
    await userEvent.click((await screen.findAllByRole("button", { name: "新建集合" }))[0]);
    editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  } else editor = await openRecipe();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Abandoned online recipe" } });
  // A save yields for onMutate before I/O. Synchronous owner teardown must win.
  fireEvent.click(editor.getByRole("button", { name: "保存集合" }));
  host.replace();
  await act(async () => { await Promise.resolve(); });
  expect(f.writes).toEqual([]);
  expect(screen.queryByText("集合已保存")).toBeNull();
});

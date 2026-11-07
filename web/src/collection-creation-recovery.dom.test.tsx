// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionsPage } from "./Sources";
import { UIProviders } from "./ui-patterns/providers";
import { hasUnsavedChanges } from "./navigation";
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
function mount(cachedCollections?: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  if (cachedCollections) client.setQueryData(["collections"], cachedCollections);
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
  read?: (id: string) => Promise<Response>;
  preview?: (value: Collection) => Promise<Response>;
  createSource?: (value: Source) => Promise<Response>;
} = {}) {
  const writes: Write[] = [], reads: string[] = [], previews: Collection[] = [];
  let collections = options.collections ?? [], sources = providers;
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
    if (path === "/me/sources") return json(sources);
    if (path.startsWith("/me/collections/")) {
      reads.push(path);
      return options.read ? options.read(decodeURIComponent(path.split("/").at(-1)!)) : json({ ...current, id: writes[0].body.id });
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
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function createDraft() {
  await userEvent.click((await screen.findAllByRole("button", { name: "新建集合" }))[0]);
  const editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Local creation" } });
  return editor;
}
async function saveDraft(editor: ReturnType<typeof within>) {
  await userEvent.click(editor.getByRole("button", { name: "保存集合" }));
}
async function reviewReload(editor: ReturnType<typeof within>) {
  await userEvent.click(editor.getByRole("button", { name: "读取最新集合" }));
  return within(await screen.findByRole("alertdialog", { name: "放弃当前修改并读取最新集合？" }));
}
async function confirmReload(editor: ReturnType<typeof within>) {
  const review = await reviewReload(editor);
  await userEvent.click(review.getByRole("button", { name: "放弃修改并读取" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}
const creationConflict = () => json({ code: "COLLECTION_CREATION_CONFLICT", message: "Untrusted creation conflict" }, 412);

it("retries a lost creation with the same guarded ID, preserves cancellation, then uses only the explicitly read recipe and revision for PUT", async () => {
  const f = api({ save: async (value, attempt) => {
    if (attempt === 1) throw new TypeError("Lost after commit");
    if (attempt === 2) return creationConflict();
    return json({ ...value, revisionToken: "saved-r3" });
  } });
  const host = mount();
  const editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("集合保存结果尚未确认");
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Local retry" } });
  await saveDraft(editor);
  await editor.findByText("集合创建发生冲突");
  expect(editor.getByText("此前保存结果尚未确认。当前输入已保留，不能覆盖已保存的集合。")).toBeTruthy();
  expect(editor.queryByText("Untrusted creation conflict")).toBeNull();
  expect(f.writes.map((write) => [write.path, write.method, write.headers.get("If-None-Match"), write.headers.get("If-Match")])).toEqual([
    ["/me/collections", "POST", "*", null], ["/me/collections", "POST", "*", null],
  ]);
  expect(f.writes[1].body.id).toBe(f.writes[0].body.id);
  const review = await reviewReload(editor);
  await userEvent.click(review.getByRole("button", { name: "保留当前输入" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await act(async () => { await host.client.refetchQueries({ queryKey: ["collections"] }); });
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local retry");
  expect(f.reads).toEqual([]);
  expect(hasUnsavedChanges()).toBe(true);
  await confirmReload(editor);
  await waitFor(() => expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Current recipe"));
  await waitFor(() => expect(document.activeElement).toBe(editor.getByLabelText("集合名称")));
  expect(hasUnsavedChanges()).toBe(false);
  expect(f.writes).toHaveLength(2);
  expect(editor.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  fireEvent.change(editor.getByLabelText("集合名称"), { target: { value: "Reviewed edit" } });
  await saveDraft(editor);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes[2].method).toBe("PUT");
  expect(f.writes[2].headers.get("If-Match")).toBe("current-r2");
  expect(f.writes[2].headers.has("If-None-Match")).toBe(false);
  expect(f.writes[2].body).toEqual({ id: f.writes[0].body.id, name: "Reviewed edit", sources: current.sources, steps: current.steps });
});

it.each([
  ["404", (id: string) => json({ message: "Collection no longer exists" }, 404)],
  ["503", (id: string) => json({ message: "Read unavailable" }, 503)],
  ["wrong identity", (id: string) => json({ ...current, id: "foreign" })],
  ["missing revision", (id: string) => json({ ...current, id, revisionToken: undefined })],
  ["blank revision", (id: string) => json({ ...current, id, revisionToken: " " })],
  ["missing steps", (id: string) => json({ ...current, id, steps: undefined })],
  ["partial source", (id: string) => json({ ...current, id, sources: [{ sourceId: "one" }] })],
] as const)("preserves raw port input and same-ID creation after a %s recovery read", async (_problem, response) => {
  const f = api({ save: async () => creationConflict(), read: async (id) => response(id) });
  mount();
  const editor = await createDraft();
  const merged = within(editor.getByRole("group", { name: "合并后处理" }));
  await userEvent.click(merged.getByRole("combobox", { name: "添加处理步骤" }));
  await userEvent.click(screen.getByRole("option", { name: "字段覆盖" }));
  fireEvent.change(merged.getByLabelText("覆盖端口"), { target: { value: "443" } });
  await saveDraft(editor);
  await editor.findByText("集合创建发生冲突");
  fireEvent.change(merged.getByLabelText("覆盖端口"), { target: { value: "443.5" } });
  await confirmReload(editor);
  await waitFor(() => expect(editor.getByLabelText("集合名称").matches(":disabled")).toBe(false));
  expect(f.reads).toHaveLength(1);
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local creation");
  expect((merged.getByLabelText("覆盖端口") as HTMLInputElement).value).toBe("443.5");
  expect(hasUnsavedChanges()).toBe(true);
  expect(f.writes).toHaveLength(1);
  // Fix only the unfinished port; a failed read must not silently change method or ID.
  fireEvent.change(merged.getByLabelText("覆盖端口"), { target: { value: "443" } });
  await saveDraft(editor);
  await waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes[1].method).toBe("POST");
  expect(f.writes[1].headers.get("If-None-Match")).toBe("*");
  expect(f.writes[1].headers.has("If-Match")).toBe(false);
  expect(f.writes[1].body).toEqual(f.writes[0].body);
});

it("can retry creation after the conflicting record is deleted and recovery returns 404", async () => {
  const f = api({
    save: async (value, attempt) => attempt === 1 ? creationConflict() : json({ ...value, revisionToken: "created-r1" }),
    read: async () => json({ message: "Collection no longer exists" }, 404),
  });
  mount();
  const editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("集合创建发生冲突");
  await confirmReload(editor);
  await editor.findByText("Collection no longer exists");
  await saveDraft(editor);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].body).toEqual(f.writes[0].body);
  expect(f.writes[1].method).toBe("POST");
  expect(f.writes[1].headers.get("If-None-Match")).toBe("*");
});

it.each([400, 409, 412])( "does not treat an unknown %s error as proven creation or a successful save", async (status) => {
  const f = api({ save: async () => json({ message: "Unknown save rejection" }, status) });
  mount();
  const editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("Unknown save rejection");
  expect(editor.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(screen.queryByText("集合已保存")).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(hasUnsavedChanges()).toBe(true);
});

it("owns one pending recovery and ignores a late full read after the editor is replaced", async () => {
  let finish: ((response: Response) => void) | undefined;
  const f = api({ save: async () => creationConflict(), read: () => new Promise((resolve) => { finish = resolve; }) });
  const host = mount();
  const editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("集合创建发生冲突");
  const reload = editor.getByRole("button", { name: "读取最新集合" });
  expect(fireEvent.keyDown(reload, { key: "Enter", repeat: true })).toBe(false);
  await userEvent.dblClick(reload);
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  await userEvent.dblClick(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃修改并读取" }));
  await waitFor(() => expect(f.reads).toHaveLength(1));
  expect(editor.getByLabelText("集合名称").matches(":disabled")).toBe(true);
  expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
  fireEvent.click(editor.getByRole("button", { name: "保存集合" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "新建集合" })).toBeTruthy();
  host.replace();
  const next = await createDraft();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "Replacement draft" } });
  await act(async () => finish!(json({ ...current, id: f.writes[0].body.id })));
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Replacement draft");
  expect(next.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(f.writes).toHaveLength(1);
});

it.each(["server error", "malformed response"] as const)("keeps a %s uncertain across a later validation rejection", async (problem) => {
  const f = api({ save: async (_value, attempt) => attempt > 1
    ? json({ code: "COLLECTION_CREATION_PRECONDITION_INVALID", message: "Invalid creation precondition" }, 400)
    : problem === "server error" ? json({ message: "Save unavailable" }, 503) : new Response("not-json", { status: 200 }) });
  mount();
  const editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("集合保存结果尚未确认");
  await saveDraft(editor);
  await editor.findByText("Invalid creation precondition");
  expect(editor.getByText("集合保存结果尚未确认")).toBeTruthy();
  expect(screen.queryByText("集合已保存")).toBeNull();
  expect(f.writes[1].body.id).toBe(f.writes[0].body.id);
  expect(f.writes[1].headers.get("If-None-Match")).toBe("*");
});

it.each(["success", "failure"] as const)("ignores a late creation %s after replacement and suppresses repeated saves", async (outcome) => {
  let finish: ((response: Response) => void) | undefined;
  const f = api({ save: () => new Promise((resolve) => { finish = resolve; }) });
  const host = mount();
  const editor = await createDraft();
  const save = editor.getByRole("button", { name: "保存集合" });
  expect(fireEvent.keyDown(save, { key: "Enter", repeat: true })).toBe(false);
  await userEvent.dblClick(save);
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
  host.replace();
  const next = await createDraft();
  fireEvent.change(next.getByLabelText("集合名称"), { target: { value: "Replacement creation" } });
  await act(async () => finish!(outcome === "success" ? json({ ...f.writes[0].body, revisionToken: "saved-r1" }) : creationConflict()));
  expect((next.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Replacement creation");
  expect(next.queryByRole("button", { name: "读取最新集合" })).toBeNull();
  expect(screen.queryByText("集合已保存")).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
});

it("keeps an independently saved source notice through canceled and failed creation recovery", async () => {
  const f = api({ save: async () => creationConflict(), read: async () => json({ message: "Read unavailable" }, 503),
    createSource: async (value) => json({ ...value, enabled: false, revision: "saved-source-r1", snapshot: { endpoints: [] } }),
  });
  mount();
  let editor = await createDraft();
  await saveDraft(editor);
  await editor.findByText("集合创建发生冲突");
  await userEvent.click(editor.getByRole("button", { name: "添加来源" }));
  const source = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
  fireEvent.change(source.getByLabelText("来源名称"), { target: { value: "Saved provider needs work" } });
  fireEvent.change(source.getByLabelText("节点链接或配置内容"), { target: { value: "socks5://synthetic.example:1080#Synthetic" } });
  await userEvent.click(source.getByRole("button", { name: "导入来源" }));
  editor = within(await screen.findByRole("dialog", { name: "新建集合" }));
  await editor.findByText("来源尚未加入集合");
  const review = await reviewReload(editor);
  await userEvent.click(review.getByRole("button", { name: "保留当前输入" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await confirmReload(editor);
  await editor.findByText("Read unavailable");
  expect(editor.getByText("「Saved provider needs work」已单独保存，尚未加入当前集合。")).toBeTruthy();
  expect(editor.getByRole("button", { name: "继续编辑" })).toBeTruthy();
  expect((editor.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Local creation");
  expect(f.writes).toHaveLength(1);
});

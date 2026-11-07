// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceEditorDialog } from "./SourceEditorDialog";
import { UIProviders } from "./ui-patterns/providers";
import { hasUnsavedChanges } from "./navigation";
import type { Source } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const source: Source = {
  id: "recover-source", name: "Original source", kind: "text", enabled: true,
  content: "socks5://original.example:1080#Original", revision: "original-r1",
  applyMode: "auto", snapshot: { endpoints: [] },
};
const current: Source = {
  ...source, name: "Current source", kind: "url", content: undefined,
  url: "https://current.example/synthetic-feed", revision: "current-r2", applyMode: "manual",
};
const clients: QueryClient[] = [];
function mount(initial?: Source) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const onSaved = vi.fn(), onClose = vi.fn();
  const tree = (value?: Source, key = "first") => <QueryClientProvider client={client}>
    <UIProviders><SourceEditorDialog key={key} open source={value} onSaved={onSaved} onClose={onClose} /></UIProviders>
  </QueryClientProvider>;
  const view = render(tree(initial));
  return { onSaved, onClose, replace: (value: Source) => view.rerender(tree(value, "replacement")) };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(async () => {
  await act(async () => { cleanup(); clients.splice(0).forEach((client) => client.clear()); });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function editAndConflict() {
  const editor = within(await screen.findByRole("dialog", { name: "编辑来源" }));
  await waitFor(() => expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(source.name));
  fireEvent.change(editor.getByLabelText("来源名称"), { target: { value: "Unsaved name" } });
  fireEvent.change(editor.getByLabelText("节点链接或配置内容"), { target: { value: "socks5://local.example:1080#Local" } });
  await userEvent.click(editor.getByRole("button", { name: "保存修改" }));
  await editor.findByRole("button", { name: "读取最新来源" });
  return editor;
}
async function confirmReload(editor: ReturnType<typeof within>) {
  await userEvent.click(editor.getByRole("button", { name: "读取最新来源" }));
  const review = within(await screen.findByRole("alertdialog", { name: "放弃当前修改并读取最新来源？" }));
  await userEvent.click(review.getByRole("button", { name: "放弃修改并读取" }));
}

it("keeps a conflicted draft until explicit discard-and-read, then saves only a fresh complete version", async () => {
  let reads = 0;
  const writes: { method: string; value: Source; headers: Headers }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method) {
      writes.push({ method: init.method, value: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return writes.length === 1 ? json({ detail: "Source changed" }, 409) : json({ ...writes[1].value, revision: "saved-r3" });
    }
    const value = reads++ < 2 ? source : current;
    return json(String(url).endsWith("/reveal") ? value : { ...value, content: undefined, url: undefined });
  }));
  const host = mount(source);
  const editor = await editAndConflict();
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(editor.getByRole("button", { name: "读取最新来源" }));
  const review = within(await screen.findByRole("alertdialog", { name: "放弃当前修改并读取最新来源？" }));
  expect(review.getByText("这会替换当前窗口中的未保存输入。已保存的来源和已发布订阅不会改变。")).toBeTruthy();
  await userEvent.click(review.getByRole("button", { name: "保留当前输入" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe("Unsaved name");
  expect((editor.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe("socks5://local.example:1080#Local");
  expect(reads).toBe(2);
  await confirmReload(editor);
  await waitFor(() => expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(current.name));
  expect((editor.getByLabelText("订阅地址") as HTMLInputElement).value).toBe(current.url);
  expect(editor.getByRole("combobox", { name: "更新应用方式" }).textContent).toBe("手动应用");
  expect(editor.queryByRole("button", { name: "读取最新来源" })).toBeNull();
  expect(hasUnsavedChanges()).toBe(false);
  expect(host.onSaved).not.toHaveBeenCalled();
  expect(host.onClose).not.toHaveBeenCalled();
  expect(writes).toHaveLength(1);
  const nameInput = editor.getByLabelText("来源名称");
  await waitFor(() => expect((nameInput as HTMLInputElement).disabled).toBe(false));
  expect(fireEvent.keyDown(nameInput, { key: "Enter", repeat: true })).toBe(false);
  expect(fireEvent.keyDown(nameInput, { key: "Enter", repeat: false })).toBe(true);
  expect(writes).toHaveLength(1);
  fireEvent.change(editor.getByLabelText("来源名称"), { target: { value: "Fresh edit" } });
  await userEvent.click(editor.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(host.onSaved).toHaveBeenCalledTimes(1));
  expect(writes[1].value).toMatchObject({ revision: "current-r2", name: "Fresh edit", kind: "url", url: current.url, applyMode: "manual" });
  expect(writes[1].value.content).toBeUndefined();
  expect(writes[1].method).toBe("PUT");
  expect(writes[1].headers.has("If-None-Match")).toBe(false);
});

it.each(["failed", "mismatched", "foreign", "missing-revision"])(
  "preserves uncertain creation and local input after a %s read-back, then adopts a verified saved source",
  async (problem) => {
    const writes: { path: string; method: string; value: Source; headers: Headers }[] = [];
    const reads: string[] = [];
    let validRead = false;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (init?.method) {
        writes.push({ path, method: init.method, value: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
        if (writes.length === 1) throw new TypeError("Synthetic response lost after commit");
        if (writes.length === 2) return json({ detail: "Source already exists", code: "SOURCE_CREATION_CONFLICT" }, 412);
        return json({ ...writes[2].value, revision: "saved-r3" });
      }
      reads.push(path);
      const saved = { ...source, id: writes[0].value.id, name: "Saved in another tab", revision: "read-r2" };
      if (!validRead && problem === "failed") return json({ detail: "Read unavailable" }, 503);
      const summary: Source = { ...saved, content: undefined };
      if (!validRead && !path.endsWith("/reveal")) {
        if (problem === "mismatched") summary.revision = "different-r2";
        if (problem === "foreign") summary.id = "foreign-source";
        if (problem === "missing-revision") summary.revision = undefined;
      }
      return json(path.endsWith("/reveal") ? saved : summary);
    }));
    const host = mount();
    let editor = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
    fireEvent.change(editor.getByLabelText("来源名称"), { target: { value: "Local new source" } });
    fireEvent.change(editor.getByLabelText("节点链接或配置内容"), { target: { value: "socks5://local.example:1080#Local" } });
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await editor.findByText("尚未确认输入是否保存");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(editor.queryByText("Source already exists")).toBeNull();
    for (const write of writes) {
      expect(write.method).toBe("POST");
      expect(write.path).toBe("/api/me/sources");
      expect(write.headers.get("If-None-Match")).toBe("*");
      expect(write.value.revision).toBeUndefined();
    }
    expect(writes[0].value.id).toBe(writes[1].value.id);
    await confirmReload(editor);
    await editor.findByText(problem === "failed" ? "Read unavailable" : "来源在读取时发生变化，请重试。");
    expect(editor.getByText("尚未确认输入是否保存")).toBeTruthy();
    expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe("Local new source");
    expect((editor.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe("socks5://local.example:1080#Local");
    expect(hasUnsavedChanges()).toBe(true);
    expect(host.onSaved).not.toHaveBeenCalled();
    expect(host.onClose).not.toHaveBeenCalled();
    expect(writes).toHaveLength(2);
    validRead = true;
    await confirmReload(editor);
    editor = within(await screen.findByRole("dialog", { name: "编辑来源" }));
    await waitFor(() => expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe("Saved in another tab"));
    expect(editor.queryByText("尚未确认输入是否保存")).toBeNull();
    expect(hasUnsavedChanges()).toBe(false);
    expect(reads).toEqual([
      `/api/me/sources/${writes[0].value.id}/reveal`, `/api/me/sources/${writes[0].value.id}`,
      `/api/me/sources/${writes[0].value.id}/reveal`, `/api/me/sources/${writes[0].value.id}`,
    ]);
    fireEvent.change(editor.getByLabelText("来源名称"), { target: { value: "Fresh recovered edit" } });
    await userEvent.click(editor.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(host.onSaved).toHaveBeenCalledTimes(1));
    expect(writes[2].method).toBe("PUT");
    expect(writes[2].headers.has("If-None-Match")).toBe(false);
    expect(writes[2].value).toMatchObject({ id: writes[0].value.id, revision: "read-r2", name: "Fresh recovered edit", content: source.content });
  },
);

it("owns one confirmed read, blocks saving and closing while pending, and ignores its result after owner replacement", async () => {
  let initialReads = 0;
  const pending: Array<(response: Response) => void> = [];
  const writes: string[] = [];
  const next = { ...source, id: "next-source", name: "New owner", revision: "next-r1" };
  vi.stubGlobal("fetch", vi.fn((url: unknown, init?: RequestInit) => {
    if (init?.method) {
      writes.push(String(url));
      return Promise.resolve(json({ detail: "Source changed" }, 409));
    }
    if (String(url).includes("next-source")) return Promise.resolve(json(next));
    if (initialReads++ < 2) return Promise.resolve(json(source));
    return new Promise<Response>((resolve) => pending.push(resolve));
  }));
  const host = mount(source);
  const editor = await editAndConflict();
  await userEvent.dblClick(editor.getByRole("button", { name: "读取最新来源" }));
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  const review = within(screen.getByRole("alertdialog"));
  await userEvent.dblClick(review.getByRole("button", { name: "放弃修改并读取" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  expect((editor.getByLabelText("来源名称") as HTMLInputElement).disabled).toBe(true);
  // Pending tasks remove header dismissal and disable their footer actions.
  expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
  const cancel = editor.getByRole("button", { name: "取消" }) as HTMLButtonElement;
  const save = editor.getByRole("button", { name: "保存修改" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  expect(save.disabled).toBe(true);
  fireEvent.click(cancel);
  fireEvent.click(save);
  fireEvent.submit(editor.getByLabelText("来源名称").closest("form")!);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "编辑来源" })).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(true);
  expect(host.onClose).not.toHaveBeenCalled();
  expect(writes).toHaveLength(1);
  host.replace(next);
  const replacement = within(await screen.findByRole("dialog", { name: "编辑来源" }));
  await waitFor(() => expect((replacement.getByLabelText("来源名称") as HTMLInputElement).value).toBe("New owner"));
  fireEvent.change(replacement.getByLabelText("来源名称"), { target: { value: "New owner local draft" } });
  await act(async () => pending.forEach((resolve) => resolve(json(current))));
  expect((replacement.getByLabelText("来源名称") as HTMLInputElement).value).toBe("New owner local draft");
  expect(host.onSaved).not.toHaveBeenCalled();
  expect(host.onClose).not.toHaveBeenCalled();
  expect(writes).toHaveLength(1);
});

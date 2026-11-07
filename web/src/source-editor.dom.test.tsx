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
import { useState } from "react";
import { SourceEditorDialog } from "./Sources";
import { hasUnsavedChanges } from "./navigation";
import type { Source } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount({
  source,
  onSaved = vi.fn(),
  onActivityChange = vi.fn(),
}: {
  source?: Source;
  onSaved?: (source: Source) => void;
  onActivityChange?: (active: boolean) => void;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>直接添加</button>
        <SourceEditorDialog
          open={open}
          source={source}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
          primaryActionText={source ? undefined : "添加并使用"}
          onActivityChange={onActivityChange}
        />
      </>
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Host />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
  // JSDOM has no layout; give AntD's nested-dialog focus trap visible elements.
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!this.isConnected) return null;
      for (
        let node: HTMLElement | null = this;
        node;
        node = node.parentElement
      ) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          return null;
      }
      return this.parentElement;
    },
  );
});
afterEach(async () => {
  // Settle React work from unmount before restoring the jsdom test environment.
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens a source form directly and returns its saved identity without loading management or saving a profile", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    json({ ...JSON.parse(String(init?.body)), revision: "saved-source" }),
  );
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn(),
    onActivityChange = vi.fn();
  mount({ onSaved, onActivityChange });
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    dialog.getByRole("combobox", { name: "更新应用方式" }).textContent,
  ).toBe("自动应用");
  expect(hasUnsavedChanges()).toBe(false);
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "My airport" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example:1080#London" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "添加并使用" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/me/sources");
  expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).applyMode).toBe(
    "auto",
  );
  expect(onSaved.mock.calls[0][0]).toMatchObject({
    name: "My airport",
    kind: "text",
    enabled: true,
    applyMode: "auto",
    revision: "saved-source",
  });
  expect(onSaved.mock.calls[0][0].id).toMatch(/^src/);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onActivityChange).toHaveBeenLastCalledWith(false);
});

it.each([
  { storedMode: undefined, expectedMode: "auto", label: "自动应用" },
  { storedMode: "auto", expectedMode: "auto", label: "自动应用" },
  { storedMode: "manual", expectedMode: "manual", label: "手动应用" },
] as const)(
  "preserves fresh $storedMode application mode during an unrelated source edit",
  async ({ storedMode, expectedMode, label }) => {
    const source: Source = {
      id: "mode-source",
      revision: "fresh-mode-r2",
      name: "Stored source",
      kind: "text",
      content: "socks5://synthetic.example:1080#Stored",
      format: "uri-list",
      enabled: false,
      applyMode: storedMode,
    };
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT")
        return json({ ...JSON.parse(String(init.body)), revision: "saved-r3" });
      return json(
        String(url).endsWith("/reveal")
          ? source
          : { ...source, content: undefined },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const onSaved = vi.fn();
    // The editor must use its fresh read, not the list row used to open it.
    mount({
      source: { ...source, revision: "stale-r1", applyMode: "auto" },
      onSaved,
    });
    const dialog = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    const name = await dialog.findByLabelText("来源名称");
    expect(
      dialog.getByRole("combobox", { name: "更新应用方式" }).textContent,
    ).toBe(label);
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.change(name, { target: { value: "Renamed source" } });
    await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const writes = fetcher.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/api/me/sources/mode-source");
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      id: "mode-source",
      revision: "fresh-mode-r2",
      name: "Renamed source",
      kind: "text",
      content: "socks5://synthetic.example:1080#Stored",
      format: "uri-list",
      enabled: false,
      applyMode: expectedMode,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onSaved.mock.calls[0][0].applyMode).toBe(expectedMode);
  },
);

it.each([
  { before: "auto", after: "manual", label: "手动应用" },
  { before: "manual", after: "auto", label: "自动应用" },
] as const)(
  "saves a $before to $after application mode change only with the full source save",
  async ({ before, after, label }) => {
    const source: Source = {
      id: "change-mode",
      revision: "source-r1",
      name: "Mode source",
      kind: "text",
      content: "socks5://synthetic.example:1080#Stored",
      enabled: true,
      applyMode: before,
    };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      json(init?.method === "PUT" ? JSON.parse(String(init.body)) : source),
    );
    vi.stubGlobal("fetch", fetcher);
    const onSaved = vi.fn();
    mount({ source, onSaved });
    const dialog = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    const mode = await dialog.findByRole("combobox", { name: "更新应用方式" });
    expect(hasUnsavedChanges()).toBe(false);
    await userEvent.click(mode);
    await userEvent.click(await screen.findByRole("option", { name: label }));
    expect(mode.textContent).toBe(label);
    expect(hasUnsavedChanges()).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
    expect(dialog.getByText(/不会自动发布订阅/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledTimes(3);
    const write = fetcher.mock.calls.find(([, init]) => init?.method)!;
    expect(write[0]).toBe("/api/me/sources/change-mode");
    expect(write[1]?.method).toBe("PUT");
    expect(JSON.parse(String(write[1]?.body))).toEqual({
      ...source,
      applyMode: after,
    });
    expect(hasUnsavedChanges()).toBe(false);
  },
);

it("protects mode-only changes on cancel and restores the default after discard and reopen", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn();
  mount({ onSaved });
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const mode = dialog.getByRole("combobox", { name: "更新应用方式" });
  await userEvent.click(mode);
  await userEvent.click(
    await screen.findByRole("option", { name: "手动应用" }),
  );
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  let discard = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  await userEvent.click(discard.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(mode.textContent).toBe("手动应用");
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  discard = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  await userEvent.click(discard.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(hasUnsavedChanges()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "直接添加" }));
  const reopened = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  expect(
    reopened.getByRole("combobox", { name: "更新应用方式" }).textContent,
  ).toBe("自动应用");
  expect(hasUnsavedChanges()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

it("keeps a failed private-field reveal recoverable without exposing redacted values as an editable source", async () => {
  const source: Source = {
    id: "private-source",
    revision: "redacted-revision",
    name: "Private source",
    kind: "url",
    enabled: true,
  };
  let reveals = 0;
  let summaries = 0;
  const fetcher = vi.fn(async (url: unknown) => {
    if (String(url).endsWith("/reveal"))
      return ++reveals === 1
        ? json({ detail: "Unable to load private fields" }, 503)
        : json({
            ...source,
            revision: "revealed-revision",
            url: "https://provider.example/secret",
          });
    expect(String(url)).toBe("/api/me/sources/private-source");
    summaries++;
    return json({ ...source, revision: "revealed-revision" });
  });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn();
  mount({ source, onSaved });
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  await dialog.findByText("Unable to load private fields");
  expect(dialog.queryByLabelText("来源名称")).toBeNull();
  expect(dialog.queryByRole("button", { name: "保存修改" })).toBeNull();
  await userEvent.click(dialog.getByRole("button", { name: "重试" }));
  const input = await dialog.findByLabelText("订阅地址");
  expect((input as HTMLInputElement).value).toBe(
    "https://provider.example/secret",
  );
  expect(reveals).toBe(2);
  expect(summaries).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(onSaved).not.toHaveBeenCalled();
});

it("protects direct-entry values with safe discard focus and blocks closing or duplicate submission while saving", async () => {
  let finishSave: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(
    (_url: unknown, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finishSave = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn();
  mount({ onSaved });
  expect(hasUnsavedChanges()).toBe(false);
  const element = await screen.findByRole("dialog", { name: "添加订阅来源" });
  const dialog = within(element);
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Private import" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example:1080#London" },
  });
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  const confirm = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      confirm.getByRole("button", { name: "继续编辑" }),
    ),
  );
  const continueEditing = confirm.getByRole("button", { name: "继续编辑" });
  const discard = confirm.getByRole("button", { name: "放弃修改" });
  act(() => discard.focus());
  expect(fireEvent.keyDown(discard, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(continueEditing);
  expect(
    fireEvent.keyDown(continueEditing, { key: "Tab", shiftKey: true }),
  ).toBe(false);
  expect(document.activeElement).toBe(discard);
  fireEvent.keyDown(discard, { key: "Tab" });
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃尚未保存的来源修改？" }),
    ).toBeNull(),
  );
  expect((dialog.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
    "Private import",
  );
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  const escapeReview = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      escapeReview.getByRole("button", { name: "继续编辑" }),
    ),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃尚未保存的来源修改？" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "添加订阅来源" })).toBe(element);
  expect((dialog.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
    "Private import",
  );
  expect(hasUnsavedChanges()).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  const submit = dialog.getByRole("button", { name: "添加并使用" });
  await userEvent.dblClick(submit);
  await waitFor(() => expect(finishSave).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(dialog.queryByRole("button", { name: "关闭" })).toBeNull();
  fireEvent.keyDown(element, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "添加订阅来源" })).toBe(element);
  expect(
    screen.queryByRole("dialog", { name: "放弃尚未保存的来源修改？" }),
  ).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  finishSave!(
    json({
      ...JSON.parse(String(fetcher.mock.calls[0][1]?.body)),
      revision: "saved",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(hasUnsavedChanges()).toBe(false);
});

it("ignores a private-field response from a dismissed session and keeps the newer edit identity and settings", async () => {
  const source: Source = {
    id: "same-source",
    name: "Source",
    kind: "url",
    enabled: true,
  };
  let firstReveal: ((response: Response) => void) | undefined;
  let revealCount = 0;
  let summaryCount = 0;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") return json(JSON.parse(String(init.body)));
    if (String(url).endsWith("/reveal")) {
      if (++revealCount === 1)
        return new Promise<Response>((resolve) => {
          firstReveal = resolve;
        });
      return json({
        ...source,
        revision: "new-revision",
        enabled: false,
        format: "base64",
        applyMode: "manual",
        url: "https://provider.example/new-private-url",
      });
    }
    expect(String(url)).toBe("/api/me/sources/same-source");
    summaryCount++;
    return json({
      ...source,
      revision: summaryCount === 1 ? "old-revision" : "new-revision",
      enabled: summaryCount === 1,
      format: summaryCount === 1 ? "auto" : "base64",
      applyMode: summaryCount === 1 ? "auto" : "manual",
    });
  });
  vi.stubGlobal("fetch", fetcher);
  mount({ source });
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "编辑来源" })).getByRole(
      "button",
      { name: "关闭" },
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "直接添加" }));
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  const url = await dialog.findByLabelText("订阅地址");
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "My newer edit" },
  });
  firstReveal!(
    json({
      ...source,
      revision: "old-revision",
      applyMode: "auto",
      url: "https://provider.example/old-private-url",
    }),
  );
  await waitFor(() =>
    expect((url as HTMLInputElement).value).toBe(
      "https://provider.example/new-private-url",
    ),
  );
  expect(
    dialog.getByRole("combobox", { name: "更新应用方式" }).textContent,
  ).toBe("手动应用");
  await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(revealCount).toBe(2);
  expect(summaryCount).toBe(2);
  const write = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(write[0]).toBe("/api/me/sources/same-source");
  expect(JSON.parse(String(write[1]?.body))).toMatchObject({
    id: "same-source",
    revision: "new-revision",
    name: "My newer edit",
    url: "https://provider.example/new-private-url",
    enabled: false,
    format: "base64",
    applyMode: "manual",
  });
});

it("imports files locally, preserves newer typed content and rejects oversized files without dropping the draft", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount();
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const input = dialog.getByLabelText(
    "节点链接或配置内容",
  ) as HTMLTextAreaElement;
  const fileInput = dialog.getByLabelText("读取配置文件");
  let finishRead: ((content: string) => void) | undefined;
  const slowFile = new File(["old file"], "source.txt", { type: "text/plain" });
  Object.defineProperty(slowFile, "text", {
    value: () =>
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
  });
  fireEvent.change(fileInput, { target: { files: [slowFile] } });
  fireEvent.change(input, { target: { value: "newer typed content" } });
  await act(async () => {
    finishRead!("old file content");
  });
  expect(input.value).toBe("newer typed content");

  const imported = new File(["local config"], "source.json", {
    type: "application/json",
  });
  Object.defineProperty(imported, "text", {
    value: async () => '{"outbounds":[]}',
  });
  fireEvent.change(fileInput, { target: { files: [imported] } });
  await waitFor(() => expect(input.value).toBe('{"outbounds":[]}'));
  expect(hasUnsavedChanges()).toBe(true);
  const large = new File(["unused"], "large.json", {
    type: "application/json",
  });
  const readLarge = vi.fn();
  Object.defineProperties(large, {
    size: { value: 1024 * 1024 + 1 },
    text: { value: readLarge },
  });
  fireEvent.change(fileInput, { target: { files: [large] } });
  await dialog.findByText("配置文件最大 1 MB。更大的订阅请使用 URL 导入。");
  expect(readLarge).not.toHaveBeenCalled();
  expect(input.value).toBe('{"outbounds":[]}');
  expect(fetcher).not.toHaveBeenCalled();
});

it("explains that an existing accepted source survives discarding local edits", async () => {
  const source: Source = {
    id: "accepted-source",
    name: "Saved accepted source",
    kind: "text",
    enabled: true,
    revision: "accepted-r1",
    refreshStatus: "accepted",
    content: "socks5://proxy.example:1080#Saved",
    snapshot: { endpoints: [] },
  };
  const fetcher = vi.fn(async () => json(source));
  vi.stubGlobal("fetch", fetcher);
  mount({ source });
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  await waitFor(() =>
    expect((dialog.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      source.name,
    ),
  );
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Local unsaved name" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "取消" }));
  const discard = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  expect(
    discard.getByText("本次提交后的修改尚未保存。已保存的来源输入会保留。"),
  ).toBeTruthy();
  await userEvent.click(discard.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(2); // Only the original summary and reveal reads.
});

it("identifies a retained 422 input as saved and only asks to discard later local edits", async () => {
  let submitted: Source;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    submitted = JSON.parse(String(init?.body));
    return json(
      {
        detail: "Cannot import this input",
        source: {
          ...submitted,
          content: undefined,
          revision: "saved-failure-r2",
          refreshStatus: "failed",
          lastError: "Cannot import this input",
        },
      },
      422,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Saved failed source" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "invalid input" },
  });
  await userEvent.click(dialog.getByRole("combobox", { name: "更新应用方式" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "手动应用" }),
  );
  await userEvent.click(dialog.getByRole("button", { name: "添加并使用" }));
  await dialog.findByText("输入已保存，导入未完成");
  expect(hasUnsavedChanges()).toBe(false);
  expect(
    (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value,
  ).toBe("invalid input");
  expect(submitted!.applyMode).toBe("manual");
  expect(
    dialog.getByRole("combobox", { name: "更新应用方式" }).textContent,
  ).toBe("手动应用");
  await userEvent.click(dialog.getByRole("combobox", { name: "更新应用方式" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "自动应用" }),
  );
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Later unsaved name" },
  });
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: /取\s*消/ }));
  const discard = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  expect(
    discard.getByText("本次提交后的修改尚未保存。已保存的来源输入会保留。"),
  ).toBeTruthy();
  expect(discard.queryByText("这次修改的来源设置尚未保存。")).toBeNull();
  await userEvent.click(discard.getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(submitted!.name).toBe("Saved failed source");
});

it("offers URL and text as visible choices without fetching or losing either private value", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount();
  const editor = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const text = editor.getByRole("radio", { name: "节点 URI / 配置文本" });
  expect(text.getAttribute("aria-checked")).toBe("true");
  fireEvent.change(editor.getByLabelText("节点链接或配置内容"), {
    target: { value: "private configuration" },
  });
  await userEvent.click(editor.getByRole("radio", { name: "订阅 URL" }));
  fireEvent.change(editor.getByLabelText("订阅地址"), {
    target: { value: "https://provider.example/private-token" },
  });
  expect(editor.getByLabelText("订阅地址").getAttribute("type")).toBe(
    "password",
  );
  await userEvent.click(
    editor.getByRole("radio", { name: "节点 URI / 配置文本" }),
  );
  expect(
    (editor.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value,
  ).toBe("private configuration");
  await userEvent.click(editor.getByRole("radio", { name: "订阅 URL" }));
  expect(
    ((await editor.findByLabelText("订阅地址")) as HTMLInputElement).value,
  ).toBe("https://provider.example/private-token");
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps a lost body-read result uncertain even after a retry conflicts", async () => {
  let writes = 0;
  const fetcher = vi.fn(async () => {
    writes++;
    if (writes === 1)
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new TypeError("Response body interrupted");
        },
      };
    return json({ detail: "Source revision changed" }, 409);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const editor = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(editor.getByLabelText("来源名称"), {
    target: { value: "Possibly saved source" },
  });
  fireEvent.change(editor.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://synthetic.example:1080" },
  });
  fireEvent.click(editor.getByRole("button", { name: "添加并使用" }));
  await editor.findByText("尚未确认输入是否保存");
  fireEvent.click(editor.getByRole("button", { name: "添加并使用" }));
  await editor.findByText("Source revision changed");
  expect(editor.getByText("尚未确认输入是否保存")).toBeTruthy();
  await userEvent.click(editor.getByRole("button", { name: /取\s*消/ }));
  const close = within(
    await screen.findByRole("alertdialog", { name: "关闭来源编辑？" }),
  );
  expect(
    close.getByText(
      "尚未确认上次提交是否已保存。关闭不会撤销已提交的来源输入；当前窗口中的输入将不再保留。",
    ),
  ).toBeTruthy();
  expect(writes).toBe(2);
});

it.each([false, true])(
  "keeps source footer Tab boundaries owned by the visible editor (existing=%s)",
  async (existing) => {
    const source: Source = {
      id: "keyboard-source",
      name: "Keyboard source",
      kind: "text",
      content: "socks5://192.0.2.10:1080#Local",
      enabled: true,
      revision: "keyboard-r1",
    };
    const requests: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method || "GET" });
        if (!init?.method || init.method === "GET") return json(source);
        throw new Error("This readonly focus task must not submit a source.");
      }),
    );
    mount({ source: existing ? source : undefined });
    const modal = await screen.findByRole("dialog", {
      name: existing ? "编辑来源" : "添加订阅来源",
    });
    const dialog = within(modal);
    await dialog.findByLabelText("来源名称");
    const close = dialog.getByRole("button", { name: "关闭" });
    const submit = dialog.getByRole("button", {
      name: existing ? "保存修改" : "添加并使用",
    });
    // This is a rendered DOM key-event/focus contract, not native browser Tab
    // order or geometry. The retained browser RED proves the actual escape.
    const focusClose = vi.spyOn(close, "focus");
    const focusSubmit = vi.spyOn(submit, "focus");
    act(() => submit.focus());
    focusSubmit.mockClear();
    expect(fireEvent.keyDown(submit, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(focusClose).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    expect(document.activeElement).toBe(submit);
    expect(focusSubmit).toHaveBeenLastCalledWith({ preventScroll: true });
    const name = dialog.getByLabelText("来源名称");
    act(() => name.focus());
    expect(fireEvent.keyDown(name, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(name);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  },
);

it("keeps the source's one busy action focused after field submission and preserves its captured name on failure", async () => {
  const source: Source = {
    id: "busy-source",
    revision: "r1",
    name: "Original",
    kind: "text",
    content: "socks5://proxy.example:1080#London",
    enabled: true,
    format: "uri-list",
    applyMode: "manual",
  };
  let release: ((response: Response) => void) | undefined;
  const writes: Array<{ url: string; body: Source }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === "GET")
        return Promise.resolve(json(source));
      writes.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  mount({ source });
  const element = await screen.findByRole("dialog", { name: "编辑来源" });
  const dialog = within(element);
  const name = await dialog.findByLabelText("来源名称");
  await waitFor(() =>
    expect((name as HTMLInputElement).value).toBe("Original"),
  );
  await userEvent.click(name);
  await userEvent.keyboard(" update");
  // JSDOM does not implement implicit Enter submission to an external form-owned footer.
  // Invoke the public rendered form submit seam while the name input retains focus.
  fireEvent.submit(name.closest("form")!);
  await waitFor(() => expect(writes).toHaveLength(1));
  const submit = dialog.getByRole("button", {
    name: "保存修改",
  }) as HTMLButtonElement;
  expect(document.activeElement).toBe(submit);
  expect(submit.disabled).toBe(false);
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect((name as HTMLInputElement).disabled).toBe(true);
  expect(
    (
      dialog.getByRole("combobox", {
        name: "更新应用方式",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (dialog.getByRole("button", { name: /导入选项/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(fireEvent.keyDown(submit, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(submit);
  expect(fireEvent.keyDown(submit, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(submit);
  await userEvent.keyboard("{Enter} ");
  fireEvent.submit(submit.form!);
  await act(async () => {});
  expect(writes).toHaveLength(1);
  fireEvent.keyDown(element, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "编辑来源" })).toBe(element);
  expect(writes[0]).toMatchObject({
    url: "/api/me/sources/busy-source",
    body: {
      name: "Original update",
      content: source.content,
      format: "uri-list",
      applyMode: "manual",
      revision: "r1",
    },
  });
  await act(async () => release!(json({ detail: "Held source failure" }, 503)));
  await waitFor(() =>
    expect(submit.getAttribute("aria-busy")).not.toBe("true"),
  );
  expect((name as HTMLInputElement).value).toBe("Original update");
  expect((name as HTMLInputElement).disabled).toBe(false);
  expect(
    dialog.getByRole("combobox", { name: "更新应用方式" }).textContent,
  ).toBe("手动应用");
  await userEvent.click(submit);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body).toEqual(writes[0].body);
  await act(async () => release!(json({ detail: "Held retry failure" }, 503)));
});

it("names an unsupported stored import format without silently changing it", async () => {
  const source: Source = {
    id: "legacy-format",
    name: "Legacy input",
    kind: "text",
    enabled: true,
    format: "share-links",
    content: "socks5://example.invalid:1080",
    revision: "r1",
  };
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method && init.method !== "GET")
        writes.push(JSON.parse(String(init.body)));
      return json(source);
    }),
  );
  mount({ source });
  await screen.findByDisplayValue("Legacy input");
  expect(screen.getByText("当前内容格式不受支持")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "导入选项" }));
  expect(
    screen.getByRole("combobox", { name: "内容格式" }).textContent,
  ).toContain("share-links（不支持）");
  expect(writes).toEqual([]);
});

it("presents the freshly loaded unsupported format on the first connected editor render", async () => {
  const source: Source = {
    id: "fresh-unsupported-format",
    name: "Fresh format",
    kind: "text",
    enabled: true,
    format: "auto",
    revision: "r1",
  };
  const fresh = {
    ...source,
    format: "future-parser",
    revision: "r2",
    content: "socks5://example.invalid:1080",
  };
  const fetch = vi.fn(async () => json(fresh));
  vi.stubGlobal("fetch", fetch);
  const observed: boolean[] = [];
  const appendChild = Node.prototype.appendChild;
  const append = vi
    .spyOn(Node.prototype, "appendChild")
    .mockImplementation(function <T extends Node>(this: Node, node: T): T {
      const result = appendChild.call(this, node) as T;
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog?.querySelector("textarea")) {
        observed.push(
          !!dialog.textContent?.includes("当前内容格式不受支持") &&
            !!dialog.textContent?.includes("future-parser"),
        );
      }
      return result;
    });
  try {
    mount({ source });
    await screen.findByDisplayValue("Fresh format");
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(Boolean)).toBe(true);
  } finally {
    append.mockRestore();
  }
});

it("presents the new text source and its local-file control together on the first connected render", async () => {
  vi.stubGlobal("fetch", vi.fn());
  const observed: boolean[] = [];
  const appendChild = Node.prototype.appendChild;
  // Observe the actual connected DOM commit before passive form watchers run.
  // Waiting for a later selector would conceal a partially presented task.
  const append = vi
    .spyOn(Node.prototype, "appendChild")
    .mockImplementation(function <T extends Node>(this: Node, node: T): T {
      const result = appendChild.call(this, node) as T;
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog?.querySelector("textarea"))
        observed.push(!!dialog.querySelector('input[type="file"]'));
      return result;
    });
  try {
    mount();
    await screen.findByRole("dialog", { name: "添加订阅来源" });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(Boolean)).toBe(true);
  } finally {
    append.mockRestore();
  }
});

it.each(["url", "legacy-kind"])(
  "does not treat loaded %s input as a new text source",
  async (kind) => {
    const source: Source = {
      id: "stored-kind",
      name: "Stored source",
      kind,
      enabled: true,
      url: "https://example.invalid/subscription",
      content: "retained input",
      revision: "r1",
    };
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method && init.method !== "GET") writes.push(init.body);
        return json(source);
      }),
    );
    mount({ source });
    await screen.findByDisplayValue("Stored source");
    const dialog = within(screen.getByRole("dialog", { name: "编辑来源" }));
    expect(dialog.queryByLabelText("读取配置文件")).toBeNull();
    if (kind === "url") {
      expect(dialog.getByLabelText("订阅地址")).toBeTruthy();
      expect(dialog.queryByLabelText("节点链接或配置内容")).toBeNull();
    } else {
      expect(
        (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
          .value,
      ).toBe("retained input");
      expect(
        dialog
          .getByRole("radio", { name: "节点 URI / 配置文本" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    }
    expect(writes).toEqual([]);
  },
);


it("treats a delayed file as an unsaved choice and blocks stale form submission until cancelled", async () => {
  const source: Source = {
    id: "file-owner", name: "Saved source", kind: "text", enabled: true,
    revision: "r1", content: "socks5://saved.example:1080", refreshStatus: "accepted",
  };
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => json(source));
  vi.stubGlobal("fetch", fetcher);
  mount({ source });
  const dialog = within(await screen.findByRole("dialog", { name: "编辑来源" }));
  await waitFor(() => expect((dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe(source.content));
  let finish!: (text: string) => void;
  const file = new File(["fixture"], "delayed.conf");
  Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { finish = resolve; }) });
  fireEvent.change(dialog.getByLabelText("读取配置文件"), { target: { files: [file] } });
  expect(hasUnsavedChanges()).toBe(true);
  expect(dialog.getByRole("status").textContent).toContain("正在读取");
  expect((dialog.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(dialog.getByLabelText("来源名称").closest("form")!);
  await act(async () => {});
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  await userEvent.click(dialog.getByRole("button", { name: "取消", exact: true }));
  const confirmation = within(await screen.findByRole("alertdialog"));
  await userEvent.click(confirmation.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await userEvent.click(dialog.getByRole("button", { name: "取消文件选择" }));
  expect(hasUnsavedChanges()).toBe(false);
  await act(async () => { finish("late content"); });
  expect((dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe(source.content);
  expect(dialog.getByRole("status").textContent).toBe("尚未选择文件");
  await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});


it("clears file status on mode changes and ignores an obsolete read failure", async () => {
  vi.stubGlobal("fetch", vi.fn());
  mount();
  const dialog = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
  let reject!: (error: Error) => void;
  const delayed = new File(["fixture"], "obsolete.yaml");
  Object.defineProperty(delayed, "text", { value: () => new Promise<string>((_resolve, fail) => { reject = fail; }) });
  fireEvent.change(dialog.getByLabelText("读取配置文件"), { target: { files: [delayed] } });
  await userEvent.click(dialog.getByRole("radio", { name: "订阅 URL" }));
  await userEvent.click(dialog.getByRole("radio", { name: "节点 URI / 配置文本" }));
  await act(async () => { reject(new Error("obsolete failure")); });
  expect(dialog.queryByText("无法读取文件，请重新选择。")).toBeNull();
  expect(dialog.getByRole("status").textContent).toBe("尚未选择文件");
  expect(hasUnsavedChanges()).toBe(false);
});

it("keeps a failed file choice blocked until the same file is successfully retried", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => json({ ...JSON.parse(String(init?.body)), revision: "r2" }));
  vi.stubGlobal("fetch", fetcher);
  mount();
  const dialog = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
  fireEvent.change(dialog.getByLabelText("来源名称"), { target: { value: "Retry file" } });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), { target: { value: "old content" } });
  const file = new File(["fixture"], "retry.yml");
  Object.defineProperty(file, "text", { value: vi.fn().mockRejectedValueOnce(new Error("unreadable")).mockResolvedValue("socks5://retry.example:1080") });
  const input = dialog.getByLabelText("读取配置文件");
  fireEvent.change(input, { target: { files: [file] } });
  await dialog.findByText("无法读取文件，请重新选择。");
  fireEvent.submit(dialog.getByLabelText("来源名称").closest("form")!);
  await act(async () => {});
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect((dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe("socks5://retry.example:1080"));
  expect(dialog.queryByText("无法读取文件，请重新选择。")).toBeNull();
  await userEvent.click(dialog.getByRole("button", { name: "添加并使用" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ name: "Retry file", kind: "text", content: "socks5://retry.example:1080" });
});


it("lets a newer file own the content when the older read finishes last", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount();
  const dialog = within(await screen.findByRole("dialog", { name: "添加订阅来源" }));
  const input = dialog.getByLabelText("读取配置文件");
  let finish!: (text: string) => void;
  const old = new File(["fixture"], "old.txt");
  Object.defineProperty(old, "text", { value: () => new Promise<string>((resolve) => { finish = resolve; }) });
  const next = new File(["fixture"], "next.json");
  Object.defineProperty(next, "text", { value: async () => "newer content" });
  fireEvent.change(input, { target: { files: [old] } });
  fireEvent.change(input, { target: { files: [next] } });
  await waitFor(() => expect((dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe("newer content"));
  await act(async () => { finish("obsolete content"); });
  expect((dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value).toBe("newer content");
  expect(dialog.getByRole("status").textContent).toBe("已读取文件：next.json");
  expect(fetcher).not.toHaveBeenCalled();
});

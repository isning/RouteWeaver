// @vitest-environment jsdom
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { SOURCE_IMPORT_JOURNEY_TIMEOUT_MS } from "./test-support/source-import-journey";
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
import { CollectionsPage } from "./Sources";
import { hasUnsavedChanges } from "./navigation";
import type { Collection, Source } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
function mount(
  key = "first",
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
  clients.push(client);
  const tree = (session: string) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <CollectionsPage key={session} />
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(tree(key));
  return { client, replace: (session: string) => view.rerender(tree(session)) };
}
function api({
  collections = [],
  sources = [],
  saveSource,
  saveCollection,
  decideSource,
  readSource,
}: {
  collections?: Collection[];
  sources?: Source[];
  saveSource?: (source: Source) => Promise<Response>;
  saveCollection?: (collection: Collection) => Promise<Response>;
  decideSource?: (
    path: string,
    body: Record<string, unknown>,
  ) => Promise<Response>;
  readSource?: (id: string) => Promise<Response>;
} = {}) {
  let savedSources = sources;
  let savedCollections = collections;
  const writes: {
    path: string;
    body: Record<string, unknown>;
    method: string;
  }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const method = init?.method || "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body));
      writes.push({ path, body, method });
      if (path === "/me/sources") {
        const response = saveSource
          ? await saveSource(body)
          : json({
              ...body,
              revision: "source-r1",
              snapshot: { endpoints: [] },
            });
        if (response.ok)
          savedSources = [...savedSources, await response.clone().json()];
        return response;
      }
      if (
        (path.endsWith("/apply") || path.endsWith("/candidate/reject")) &&
        decideSource
      ) {
        const response = await decideSource(path, body);
        if (response.ok) {
          const result = await response.clone().json();
          savedSources = [
            ...savedSources.filter((item) => item.id !== result.id),
            result,
          ];
        }
        return response;
      }
      if (path === "/me/collections/preview") return json({ endpoints: [] });
      if (path.startsWith("/me/collections")) {
        const response = saveCollection ? await saveCollection(body) : json(body);
        if (response.ok) savedCollections = [body];
        return response;
      }
      throw new Error(`Unexpected write ${method} ${path}`);
    }
    if (path === "/me/sources") return json(savedSources);
    if (path === "/me/collections") return json(savedCollections);
    if (path.startsWith("/me/sources/")) {
      const id = path.split("/")[3];
      return readSource
        ? readSource(id)
        : json(savedSources.find((item) => item.id === id));
    }
    throw new Error(`Unexpected read ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { writes, fetcher };
}
const source = (id: string, name: string): Source => ({
  id,
  name,
  kind: "text",
  enabled: true,
  snapshot: { endpoints: [] },
});
const recipe: Collection = {
  id: "travel",
  name: "Travel",
  sources: [
    {
      sourceId: "one",
      steps: [
        { id: "rename", kind: "rename", enabled: true, template: "{name}-one" },
      ],
    },
    {
      sourceId: "two",
      steps: [{ id: "disabled", kind: "deduplicate", enabled: false }],
    },
  ],
  steps: [{ id: "merged", kind: "deduplicate", enabled: true }],
};
async function openNew() {
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  return within(await screen.findByRole("dialog", { name: "新建集合" }));
}
async function addSource(
  name = "New provider",
  scenario?: ReturnType<typeof ownedClickScenario>,
) {
  scenario?.assertActive();
  if (scenario)
    await scenario.click(() =>
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "添加来源",
      }),
    );
  else
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "添加来源",
      }),
    );
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  scenario?.assertActive();
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: name },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example:1080#London" },
  });
  return dialog;
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
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Declared whole-journey correctness budget, not a product latency SLA or speedup.
// The retained native 10 s failure entered the parent-focus check after ~9.87 s of UI work,
// before the remaining draft/preview/save assertions. Inner waits/hooks are unchanged.
const COLLECTION_IMPORT_RETURN_SAVE_JOURNEY_TIMEOUT_MS = 20_000;

it(
  "returns a newly saved source to the same unsaved collection, preserving order and both processing stages",
  async (context) => {
    const scenario = ownedClickScenario(context);
    scenario.assertActive();
    const { writes } = api({
      collections: [recipe],
      sources: [source("one", "One"), source("two", "Two")],
    });
    mount();
    await scenario.click(() => screen.findByRole("button", { name: /Travel/ }));
    scenario.assertActive();
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Unsaved travel" },
    });
    await scenario.click(() =>
      screen.getByRole("switch", { name: "启用步骤 1" }),
    );
    scenario.assertActive();
    await scenario.click(() => screen.getByText("1. One"));
    scenario.assertActive();
    fireEvent.change(screen.getByLabelText("步骤 1 命名模板"), {
      target: { value: "unsaved-{name}" },
    });
    await scenario.click(() =>
      screen.getByRole("button", { name: "下移来源 1" }),
    );
    scenario.assertActive();
    const editor = await addSource("New provider", scenario);
    scenario.assertActive();
    expect(screen.queryByRole("dialog", { name: "Unsaved travel" })).toBeNull();
    await scenario.click(() =>
      editor.getByRole("button", { name: "导入来源" }),
    );
    scenario.assertActive();
    const returnedParent = within(
      await screen.findByRole("dialog", { name: "Unsaved travel" }),
    );
    scenario.assertActive();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        returnedParent.getByRole("button", { name: "添加来源" }),
      ),
    );
    scenario.assertActive();
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/me/sources");
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    expect(hasUnsavedChanges()).toBe(true);
    expect(
      (returnedParent.getByLabelText("集合名称") as HTMLInputElement).value,
    ).toBe("Unsaved travel");
    expect(returnedParent.getByText("1. Two")).toBeTruthy();
    expect(returnedParent.getByText("2. One")).toBeTruthy();
    expect(returnedParent.getByText("3. New provider")).toBeTruthy();
    expect(screen.queryByText("来源已添加", { exact: true })).toBeNull();
    expect(
      returnedParent
        .getByText("当前集合已选择来源「New provider」。")
        .getAttribute("role"),
    ).toBe("status");
    expect(
      returnedParent.getByRole("button", { name: /3\. New provider.*来源处理/ })
        .textContent,
    ).not.toContain("已配置");
    expect(
      (returnedParent.getByLabelText("步骤 1 命名模板") as HTMLInputElement)
        .value,
    ).toBe("unsaved-{name}");
    await scenario.click(() =>
      returnedParent.getByRole("button", { name: "预览处理结果" }),
    );
    scenario.assertActive();
    await returnedParent.findByText("逐阶段预览");
    scenario.assertActive();
    const expected = {
      ...recipe,
      name: "Unsaved travel",
      sources: [
        recipe.sources[1],
        {
          sourceId: "one",
          steps: [
            {
              id: "rename",
              kind: "rename",
              enabled: true,
              template: "unsaved-{name}",
            },
          ],
        },
        { sourceId: writes[0].body.id, steps: [] },
      ],
      steps: [{ id: "merged", kind: "deduplicate", enabled: false }],
    };
    expect(writes[1]).toMatchObject({
      path: "/me/collections/preview",
      body: expected,
    });
    await scenario.click(() =>
      returnedParent.getByRole("button", { name: "保存集合" }),
    );
    scenario.assertActive();
    await waitFor(() => expect(writes).toHaveLength(3));
    scenario.assertActive();
    expect(writes[2]).toMatchObject({
      path: "/me/collections/travel",
      method: "PUT",
      body: expected,
    });
  },
  COLLECTION_IMPORT_RETURN_SAVE_JOURNEY_TIMEOUT_MS,
);

it(
  "names collapsed source processing and counts configured disabled steps without expanding them, including after reopen",
  async (context) => {
    const scenario = ownedClickScenario(context);
    scenario.assertActive();
    api({
      collections: [recipe],
      sources: [source("one", "One"), source("two", "Two")],
    });
    mount();
    await scenario.click(() => screen.findByRole("button", { name: /Travel/ }));
    scenario.assertActive();
    const one = screen.getByRole("button", {
      name: /1\. One.*来源处理.*已配置 1 步/,
    });
    const two = screen.getByRole("button", {
      name: /2\. Two.*来源处理.*已配置 1 步/,
    });
    expect(one.getAttribute("aria-expanded")).toBe("false");
    expect(two.getAttribute("aria-expanded")).toBe("false");
    scenario.assertActive();
    two.focus();
    scenario.assertActive();
    await userEvent.keyboard("{Enter}");
    scenario.assertActive();
    expect(two.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(two.getAttribute("aria-controls")!)!;
    expect(
      within(region)
        .getByRole("switch", { name: "启用步骤 1" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await scenario.click(() =>
      screen.getByRole("button", { name: "上移来源 2" }),
    );
    scenario.assertActive();
    expect(
      screen.getByRole("button", { name: /1\. Two.*来源处理.*已配置 1 步/ }),
    ).toBeTruthy();
    await scenario.click(() =>
      screen.getByRole("button", { name: "保存集合" }),
    );
    scenario.assertActive();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    scenario.assertActive();
    await scenario.click(() => screen.getByRole("button", { name: /Travel/ }));
    scenario.assertActive();
    expect(
      screen
        .getByRole("button", { name: /1\. Two.*来源处理.*已配置 1 步/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: /2\. One.*来源处理.*已配置 1 步/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it.each([
  { enabled: false, snapshot: { endpoints: [] } },
  { enabled: true },
  {
    lastError: "Provider could not be read",
    lastErrorCode: "source_url_not_allowed",
    refreshStatus: "failed",
    snapshot: { endpoints: [] },
  },
])(
  "keeps unavailable or failed imported sources separate from the parent draft: %j",
  async (result) => {
    const { writes } = api({
      saveSource: async (value) => json({ ...value, ...result }),
    });
    mount();
    await openNew();
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Keep my recipe" },
    });
    const editor = await addSource("Needs correction");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const collection = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    await collection.findByText("来源尚未加入集合");
    expect(collection.getByText(/「Needs correction」已单独保存/)).toBeTruthy();
    expect(collection.getByRole("button", { name: "继续编辑" })).toBeTruthy();
    if ("lastErrorCode" in result) {
      expect(
        collection.getByText(
          "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
        ),
      ).toBeTruthy();
      expect(collection.queryByText("Provider could not be read")).toBeNull();
    }
    expect(collection.queryByText("1. Needs correction")).toBeNull();
    expect(
      (collection.getByLabelText("集合名称") as HTMLInputElement).value,
    ).toBe("Keep my recipe");
    expect(writes).toHaveLength(1);
    await userEvent.click(
      collection.getByRole("button", { name: "预览处理结果" }),
    );
    await collection.findByText("逐阶段预览");
    expect(writes[1].body.sources).toEqual([]);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "keeps the independently saved source when its unsaved collection is explicitly discarded",
  async () => {
    const { writes } = api();
    mount();
    await openNew();
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Discard collection only" },
    });
    const editor = await addSource();
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const collection = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    await userEvent.click(collection.getByRole("button", { name: "关闭" }));
    const confirm = within(
      await screen.findByRole("alertdialog", {
        name: "放弃尚未保存的集合修改？",
      }),
    );
    expect(confirm.getByText(/已保存的来源会保留/)).toBeTruthy();
    await userEvent.click(confirm.getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hasUnsavedChanges()).toBe(false);
    expect(writes).toHaveLength(1);
    const reopened = await openNew();
    expect(
      (reopened.getByLabelText("集合名称") as HTMLInputElement).value,
    ).toBe("");
    await userEvent.click(reopened.getByRole("combobox", { name: "订阅来源" }));
    expect(await screen.findByText("New provider")).toBeTruthy();
    expect(writes).toHaveLength(1);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "cancels clean and dirty source subtasks without dirtying a clean collection or replacing its draft",
  async () => {
    const { writes } = api();
    mount();
    await openNew();
    expect(hasUnsavedChanges()).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "添加来源" }));
    let editor = within(
      await screen.findByRole("dialog", { name: "添加订阅来源" }),
    );
    expect(hasUnsavedChanges()).toBe(false);
    await userEvent.click(editor.getByRole("button", { name: /取\s*消/ }));
    await screen.findByRole("dialog", { name: "新建集合" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Keep this" },
    });
    editor = await addSource("Discard this source");
    await userEvent.click(editor.getByRole("button", { name: /取\s*消/ }));
    let confirm = within(
      await screen.findByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
      }),
    );
    await userEvent.click(confirm.getByRole("button", { name: "继续编辑" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "放弃尚未保存的来源修改？" }),
      ).toBeNull(),
    );
    expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      "Discard this source",
    );
    await userEvent.click(editor.getByRole("button", { name: /取\s*消/ }));
    confirm = within(
      await screen.findByRole("alertdialog", {
        name: "放弃尚未保存的来源修改？",
      }),
    );
    await userEvent.click(confirm.getByRole("button", { name: "放弃修改" }));
    await screen.findByRole("dialog", { name: "新建集合" });
    expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "Keep this",
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "添加来源" }));
    editor = within(
      await screen.findByRole("dialog", { name: "添加订阅来源" }),
    );
    expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      "",
    );
    expect(
      (editor.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "blocks parent save/close/replacement while a source write is pending, retains failed input, then safely retries",
  async () => {
    let finish: ((response: Response) => void) | undefined;
    const { writes } = api({
      saveSource: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    mount();
    const collection = await openNew();
    fireEvent.change(collection.getByLabelText("集合名称"), {
      target: { value: "Pending collection" },
    });
    const parentSave = collection.getByRole("button", { name: "保存集合" });
    const parentClose = collection.getByRole("button", { name: "关闭" });
    const editor = await addSource();
    await userEvent.dblClick(editor.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect((parentSave as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(parentSave);
    await userEvent.click(parentClose);
    fireEvent.click(
      screen.getAllByRole("button", { name: "新建集合", hidden: true })[0],
    );
    expect(editor.queryByRole("button", { name: "关闭" })).toBeNull();
    expect(
      (editor.getByRole("button", { name: /^取\s*消$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const busyImport = editor.getByRole("button", { name: "导入来源" });
    expect(busyImport.getAttribute("aria-busy")).toBe("true");
    expect((busyImport as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(busyImport);
    expect(document.activeElement).toBe(busyImport);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "添加订阅来源" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "新建集合" })).toBeNull();
    expect(
      screen.queryByRole("alertdialog", { name: "放弃尚未保存的来源修改？" }),
    ).toBeNull();
    expect(hasUnsavedChanges()).toBe(true);
    expect(writes).toHaveLength(1);
    await act(async () =>
      finish!(json({ detail: "Import temporarily failed" }, 503)),
    );
    await editor.findByText("Import temporarily failed");
    expect(
      (editor.getByRole("button", { name: "关闭" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (editor.getByRole("button", { name: /^取\s*消$/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      "New provider",
    );
    expect(
      (editor.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("socks5://proxy.example:1080#London");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    await act(async () =>
      finish!(
        json({
          ...writes[1].body,
          revision: "retry-saved",
          snapshot: { endpoints: [] },
        }),
      ),
    );
    await screen.findByRole("dialog", { name: "新建集合" });
    expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "Pending collection",
    );
    expect(screen.getByText("1. New provider")).toBeTruthy();
    expect(writes.every(({ path }) => path === "/me/sources")).toBe(true);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "does not let an old source response mutate or close a replacement collection/source session",
  async () => {
    const finishes: ((response: Response) => void)[] = [];
    const { writes } = api({
      saveSource: () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    });
    const host = mount();
    await openNew();
    let editor = await addSource("Old source");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    host.replace("replacement");
    await openNew();
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "New owning draft" },
    });
    editor = await addSource("New source");
    await act(async () =>
      finishes[0](
        json({
          ...writes[0].body,
          revision: "old-completed",
          snapshot: { endpoints: [] },
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "添加订阅来源" })).toBeTruthy(),
    );
    expect((editor.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      "New source",
    );
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    await act(async () =>
      finishes[1](
        json({
          ...writes[1].body,
          revision: "new-completed",
          snapshot: { endpoints: [] },
        }),
      ),
    );
    const collection = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    expect(
      (collection.getByLabelText("集合名称") as HTMLInputElement).value,
    ).toBe("New owning draft");
    expect(collection.getByText("1. New source")).toBeTruthy();
    expect(collection.queryByText(/\d\. Old source/)).toBeNull();
    await userEvent.click(
      collection.getByRole("button", { name: "预览处理结果" }),
    );
    await collection.findByText("逐阶段预览");
    expect(writes[2].body.sources).toEqual([
      { sourceId: writes[1].body.id, steps: [] },
    ]);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "defers and resumes the same candidate in place, then rejects without changing the parent draft",
  async () => {
    let saved: Source;
    const { writes } = api({
      collections: [recipe],
      sources: [source("one", "One"), source("two", "Two")],
      saveSource: async (value) => {
        saved = legacyPendingImport(value);
        return json(saved);
      },
      decideSource: async (path) => {
        expect(path).toBe(`/me/sources/${saved.id}/candidate/reject`);
        return json({
          ...saved,
          candidate: undefined,
          revision: "rejected-r2",
          refreshStatus: "rejected",
        });
      },
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: /Travel/ }),
    );
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Keep recovery draft" },
    });
    const editor = await addSource();
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    let parent = within(
      await screen.findByRole("dialog", { name: "Keep recovery draft" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        parent.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect((parent.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "Keep recovery draft",
    );
    expect(parent.getByText("1. One")).toBeTruthy();
    expect(parent.getByText("2. Two")).toBeTruthy();
    expect(parent.queryByText("3. New provider")).toBeNull();
    expect(writes).toHaveLength(1);
    await userEvent.click(parent.getByRole("button", { name: "查看变化" }));
    let review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    await userEvent.click(review.getByRole("button", { name: "稍后处理" }));
    parent = within(
      await screen.findByRole("dialog", { name: "Keep recovery draft" }),
    );
    expect(writes).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        parent.getByRole("button", { name: "查看变化" }),
      ),
    );
    await userEvent.click(parent.getByRole("button", { name: "查看变化" }));
    review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    expect(review.getByText("New provider")).toBeTruthy();
    await userEvent.click(review.getByRole("button", { name: "忽略本次更新" }));
    await screen.findByRole("dialog", { name: "Keep recovery draft" });
    expect(writes.map(({ path }) => path)).toEqual([
      "/me/sources",
      `/me/sources/${saved!.id}/candidate/reject`,
    ]);
    expect(screen.queryByText("3. New provider")).toBeNull();
    expect(screen.getByRole("button", { name: "继续编辑" })).toBeTruthy();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "clears a previous import warning when opening a different collection editing session",
  async () => {
    api({
      saveSource: async (value) =>
        json({ ...value, diagnostics: ["Review this source"] }),
    });
    mount();
    await openNew();
    const editor = await addSource();
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await screen.findByText("来源尚未加入集合");
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "新建集合" })).getByRole(
        "button",
        { name: "关闭" },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const next = await openNew();
    expect(next.queryByText("来源尚未加入集合")).toBeNull();
    expect(next.queryByText(/Review this source/)).toBeNull();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "immediately names a saved source while list refresh is pending or failed, then uses the latest server name",
  async () => {
    let reads = 0;
    let finishList: ((response: Response) => void) | undefined;
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = String(url).replace(/^.*\/api/, "");
        if (init?.method === "POST") {
          writes.push(path);
          return json({
            ...JSON.parse(String(init.body)),
            id: "saved-source-id",
            name: "Known provider",
            snapshot: { endpoints: [] },
            content: "private-source-content",
            url: "https://private.example/token",
          });
        }
        if (path === "/me/sources") {
          reads++;
          if (reads === 1)
            return json([source("existing", "Existing provider")]);
          return new Promise<Response>((resolve) => {
            finishList = resolve;
          });
        }
        if (path === "/me/collections") return json([]);
        throw new Error(`Unexpected request ${path}`);
      }),
    );
    const { client } = mount();
    await openNew();
    await screen.findByText("尚未选择来源");
    const editor = await addSource("Known provider");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const collection = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    await waitFor(() => expect(finishList).toBeTruthy());
    expect(collection.getByText("1. Known provider")).toBeTruthy();
    expect(
      collection.getByRole("combobox", { name: "订阅来源" }).closest("label")
        ?.textContent,
    ).toContain("Known provider");
    expect(collection.queryByText("saved-source-id")).toBeNull();
    expect(JSON.stringify(client.getQueryData(["sources"]))).not.toMatch(
      /private-source-content|private\.example/,
    );
    await act(async () =>
      finishList!(json({ detail: "List temporarily failed" }, 503)),
    );
    await collection.findByText("暂时无法加载来源");
    expect(collection.getByText("1. Known provider")).toBeTruthy();
    expect(
      collection.getByRole("combobox", { name: "订阅来源" }).closest("label")
        ?.textContent,
    ).toContain("Known provider");
    await userEvent.click(
      collection.getByRole("button", { name: "重试加载来源" }),
    );
    await waitFor(() => expect(reads).toBe(3));
    await act(async () =>
      finishList!(
        json([
          source("existing", "Existing provider"),
          source("saved-source-id", "Server renamed provider"),
        ]),
      ),
    );
    await collection.findByText("1. Server renamed provider");
    expect(collection.queryByText("1. Known provider")).toBeNull();
    expect(
      collection.getByRole("combobox", { name: "订阅来源" }).closest("label")
        ?.textContent,
    ).toContain("Server renamed provider");
    expect(writes).toEqual(["/me/sources"]);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "does not keep a local source-name hint as an available option after removal or in a new collection opening",
  async () => {
    let reads = 0;
    let finishList: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (init?.method === "POST")
          return json({
            ...JSON.parse(String(init.body)),
            id: "saved-source-id",
            name: "Known provider",
            snapshot: { endpoints: [] },
          });
        if (String(url).endsWith("/sources") && ++reads > 1)
          return new Promise<Response>((resolve) => {
            finishList = resolve;
          });
        return json([]);
      }),
    );
    mount();
    await openNew();
    await screen.findByText("暂无可选来源");
    const editor = await addSource("Known provider");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const collection = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    await waitFor(() => expect(finishList).toBeTruthy());
    expect(collection.getByText("1. Known provider")).toBeTruthy();
    expect(collection.queryByText("暂无可选来源")).toBeNull();
    await userEvent.click(
      collection.getByRole("button", { name: "移除 Known provider" }),
    );
    expect(collection.queryByText("1. Known provider")).toBeNull();
    await userEvent.click(
      collection.getByRole("combobox", { name: "订阅来源" }),
    );
    expect(screen.queryByRole("option", { name: "Known provider" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(collection.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const next = await openNew();
    await userEvent.click(next.getByRole("combobox", { name: "订阅来源" }));
    expect(screen.queryByRole("option", { name: "Known provider" })).toBeNull();
    await act(async () =>
      finishList!(json([source("saved-source-id", "Server current provider")])),
    );
    expect(await screen.findByText("Server current provider")).toBeTruthy();
    expect(next.queryByText("1. Server current provider")).toBeNull();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it.each(["auto", "manual"] as const)(
  "uses the first imported snapshot in %s mode after one child save without a forced review or collection write",
  async (applyMode) => {
    const { writes } = api({
      saveSource: async (value) =>
        json({
          ...value,
          revision: "ready-first-import-r1",
          refreshStatus: "accepted",
          snapshot: {
            endpoints: [
              {
                id: "ready-imported-node",
                name: "London",
                origin: "imported",
                connection: {
                  protocol: "socks",
                  host: "synthetic.example",
                  port: 1080,
                },
              },
            ],
          },
          diagnostics: [{ code: "connection-extraction" }],
        }),
    });
    mount();
    await openNew();
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Unsaved first import" },
    });
    const editor = await addSource("Immediately available");
    if (applyMode === "manual") {
      await userEvent.click(
        editor.getByRole("combobox", { name: "更新应用方式" }),
      );
      await userEvent.click(
        await screen.findByRole("option", { name: "手动应用" }),
      );
    }
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const parent = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    expect(parent.queryByRole("button", { name: "查看变化" })).toBeNull();
    expect(parent.getByText("1. Immediately available")).toBeTruthy();
    expect((parent.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "Unsaved first import",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        parent.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      path: "/me/sources",
      method: "POST",
      body: { applyMode },
    });
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

// Compatibility fixture: newly imported sources no longer require this phase,
// but an already pending import can still be opened explicitly and resolved.
const legacyPendingImport = (value: Source): Source => ({
  ...value,
  revision: "source-review-r1",
  refreshStatus: "review-required",
  candidate: {
    id: "first-import-candidate",
    createdAt: "2026-10-23T02:00:00Z",
    diff: {
      beforeCount: 0,
      afterCount: 1,
      added: [{ id: "imported-option", name: "London" }],
      removed: [],
      renamed: [],
      connectionChanged: [],
    },
    affected: [],
    diagnostics: [
      { code: "connection-extraction", message: "Extracted connections" },
    ],
  },
});

it(
  "applies an explicitly opened legacy pending import with its CAS fence without saving the collection",
  async () => {
    let saved: Source;
    const { writes } = api({
      collections: [recipe],
      sources: [source("one", "One"), source("two", "Two")],
      saveSource: async (value) => {
        saved = legacyPendingImport(value);
        return json(saved);
      },
      decideSource: async (path, body) => {
        expect(path).toBe(`/me/sources/${saved.id}/apply`);
        expect(body).toEqual({
          candidateId: "first-import-candidate",
          sourceRevision: "source-review-r1",
        });
        return json({
          ...saved,
          candidate: undefined,
          revision: "accepted-r2",
          refreshStatus: "accepted",
          snapshot: { endpoints: [] },
          diagnostics: saved.candidate!.diagnostics,
        });
      },
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: /Travel/ }),
    );
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Unsaved review task" },
    });
    await userEvent.click(screen.getByRole("button", { name: "下移来源 1" }));
    const editor = await addSource("Full client configuration");
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    const deferredParent = within(
      await screen.findByRole("dialog", { name: "Unsaved review task" }),
    );
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    expect(writes).toHaveLength(1);
    expect(
      deferredParent.queryByText("3. Full client configuration"),
    ).toBeNull();
    await userEvent.click(
      deferredParent.getByRole("button", { name: "查看变化" }),
    );
    const review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    expect(
      review.getByText("分流、DNS、分组等其他配置不会导入。"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Unsaved review task" }),
    ).toBeNull();
    expect(writes).toHaveLength(1);
    await userEvent.click(review.getByRole("button", { name: "应用更新" }));
    const parent = within(
      await screen.findByRole("dialog", { name: "Unsaved review task" }),
    );
    expect(parent.getByText("1. Two")).toBeTruthy();
    expect(parent.getByText("2. One")).toBeTruthy();
    expect(parent.getByText("3. Full client configuration")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        parent.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect(writes.map(({ path }) => path)).toEqual([
      "/me/sources",
      `/me/sources/${saved!.id}/apply`,
    ]);
    await userEvent.click(parent.getByRole("button", { name: "预览处理结果" }));
    await parent.findByText("逐阶段预览");
    expect(writes[2].body).toMatchObject({
      name: "Unsaved review task",
      sources: [
        recipe.sources[1],
        recipe.sources[0],
        { sourceId: saved!.id, steps: [] },
      ],
      steps: recipe.steps,
    });
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it.for(["double click", "held Enter"])(
  "returns to the collection after importing by %s without opening or applying pending changes",
  { timeout: SOURCE_IMPORT_JOURNEY_TIMEOUT_MS },
  async (gesture, context) => {
    const scenario = ownedClickScenario(context);
    const { writes } = api({
      saveSource: async (value) => json(legacyPendingImport(value)),
    });
    mount();
    await openNew();
    const editor = await addSource("Gesture boundary", scenario);
    const submit = editor.getByRole("button", { name: "导入来源" });
    if (gesture === "double click") await userEvent.dblClick(submit);
    else {
      submit.focus();
      await userEvent.keyboard("{Enter>3/}");
    }
    const parent = within(
      await screen.findByRole("dialog", { name: "新建集合" }),
    );
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        parent.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect(writes.map(({ path }) => path)).toEqual(["/me/sources"]);
    await scenario.click(() =>
      parent.getByRole("button", { name: "查看变化" }),
    );
    const review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        review.getByLabelText("来源检查摘要"),
      ),
    );
    expect(writes.map(({ path }) => path)).toEqual(["/me/sources"]);
    expect(review.getByRole("button", { name: "应用更新" })).toBeTruthy();
  },
);


it("retains a failed collection save through repeated canceled discard and retries the exact ordered draft", async () => {
  let attempts = 0;
  const { writes } = api({
    collections: [recipe], sources: [source("one", "Provider one"), source("two", "Provider two")],
    saveCollection: async (value) => ++attempts === 1 ? json({ message: "集合暂未保存，请重试" }, 503) : json(value),
  });
  mount();
  const opener = await screen.findByRole("button", { name: /Travel/ });
  await userEvent.click(opener);
  fireEvent.change(screen.getByLabelText("集合名称"), { target: { value: "Travel edited" } });
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await screen.findByText("集合暂未保存，请重试");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({ ...recipe, name: "Travel edited" });
  for (let attempt = 0; attempt < 2; attempt++) {
    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "关闭" });
    await userEvent.click(close);
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃尚未保存的集合修改？" });
    expect(confirmation.textContent).toContain("已保存的来源会保留");
    const keep = within(confirmation).getByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe("Travel edited");
    expect(writes).toHaveLength(1);
  }
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await screen.findByRole("button", { name: /Travel edited/ });
  expect(hasUnsavedChanges()).toBe(false);
});

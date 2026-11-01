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
import { CollectionsPage, SourceEditorDialog } from "./Sources";
const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(editor = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {editor ? (
          <SourceEditorDialog open onClose={() => {}} onSaved={() => {}} />
        ) : (
          <CollectionsPage />
        )}
      </UIProviders>
    </QueryClientProvider>,
  );
  return client;
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
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps processing editable before sources without describing an empty merge", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  mount();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  await screen.findByText("暂无可选来源");
  expect(screen.getByRole("combobox", { name: "订阅来源" })).toBeTruthy();
  expect(screen.queryByText(/按以上顺序合并|按此顺序合并/)).toBeNull();
  expect(
    screen.queryByText(/保留所有节点|添加步骤，开始整理|未添加处理步骤/),
  ).toBeNull();
  await userEvent.click(screen.getByRole("combobox", { name: "添加处理步骤" }));
  await userEvent.click(await screen.findByText("去除重复连接"));
  expect(screen.getByRole("switch", { name: "启用步骤 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "预览处理结果" })).toBeTruthy();
});

it("groups the four privacy facts with the actual submit action and retains a failed import", async () => {
  const fetcher = vi.fn(async () =>
    json({ detail: "Import failed; try again" }, 503),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(true);
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const decision = within(dialog.getByRole("group", { name: "来源导入确认" }));
  const privacy = decision.getByText(/平台服务器解析/);
  for (const fact of [
    "平台运营者可处理其中的连接信息",
    "仅对你的账号可见",
    "不会自动加入共享服务器线路",
  ]) {
    expect(privacy.textContent).toContain(fact);
  }
  expect(decision.getByRole("button", { name: /取\s*消/ })).toBeTruthy();
  expect(dialog.getByRole("switch", { name: "启用来源" })).toBeTruthy();
  expect(decision.queryByRole("switch")).toBeNull();
  expect(dialog.getByText(/文件先在本地读取，提交后才上传/)).toBeTruthy();
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Private source" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example:1080#London" },
  });
  await userEvent.click(decision.getByRole("button", { name: "导入来源" }));
  await dialog.findByText("Import failed; try again");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((dialog.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
    "Private source",
  );
  expect(
    (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value,
  ).toBe("socks5://proxy.example:1080#London");
  expect(
    dialog
      .getByRole("radio", {
        name: "节点 URI / 配置文本",
      })
      .getAttribute("aria-checked") === "true",
  ).toBe(true);
});

it("reveals merge order only for multiple sources and preserves both processing layers through preview and save", async () => {
  const sourceStep = {
    id: "rename-one",
    kind: "rename",
    enabled: true,
    template: "{source}-{name}",
  };
  const mergedStep = { id: "dedup", kind: "deduplicate", enabled: true };
  const collection = {
    id: "collection-one",
    name: "Travel",
    sources: [{ sourceId: "one", steps: [sourceStep] }],
    steps: [mergedStep],
  };
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/sources"))
      return json([
        {
          id: "one",
          name: "One",
          kind: "text",
          enabled: true,
          snapshot: { endpoints: [] },
        },
        {
          id: "two",
          name: "Two",
          kind: "text",
          enabled: true,
          snapshot: { endpoints: [] },
        },
      ]);
    if (String(url).endsWith("/preview")) return json({ endpoints: [] });
    if (init?.method === "PUT") return json(JSON.parse(String(init.body)));
    return json([collection]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  await userEvent.click(await screen.findByRole("button", { name: /^Travel.*编辑集合/ }));
  expect(screen.queryByText(/按此顺序合并/)).toBeNull();
  expect(screen.queryByRole("button", { name: "下移来源 1" })).toBeNull();
  await userEvent.click(screen.getByText("1. One"));
  expect(
    (screen.getByLabelText("步骤 1 命名模板") as HTMLInputElement).value,
  ).toBe("{source}-{name}");
  await userEvent.click(screen.getByRole("combobox", { name: "订阅来源" }));
  await userEvent.click(await screen.findByText("Two"));
  await userEvent.click(screen.getByText("合并后处理"));
  expect(screen.getByText(/按此顺序合并/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "下移来源 1" }));
  expect(screen.getByText("1. Two")).toBeTruthy();
  expect(screen.getByText("2. One")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "预览处理结果" }));
  await screen.findByText("逐阶段预览");
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      true,
    ),
  );
  const expected = {
    ...collection,
    sources: [{ sourceId: "two", steps: [] }, collection.sources[0]],
  };
  const previewCall = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/preview"),
  );
  const saveCall = fetcher.mock.calls.find(
    ([, init]) => init?.method === "PUT",
  );
  expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual(expected);
  expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual(expected);
});

it("distinguishes available but unselected sources and allows steps to be prepared first", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) =>
      json(
        String(url).endsWith("/sources")
          ? [
              {
                id: "one",
                name: "One",
                kind: "text",
                enabled: true,
                snapshot: { endpoints: [] },
              },
            ]
          : [],
      ),
    ),
  );
  mount();
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  await screen.findByText("尚未选择来源");
  expect(screen.queryByText("暂无可选来源")).toBeNull();
  await userEvent.click(screen.getByRole("combobox", { name: "添加处理步骤" }));
  await userEvent.click(await screen.findByText("去除重复连接"));
  await userEvent.click(screen.getByRole("combobox", { name: "订阅来源" }));
  await userEvent.click(await screen.findByText("One"));
  await userEvent.click(screen.getByText("合并后处理"));
  expect(screen.getByRole("switch", { name: "启用步骤 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "下移来源 1" })).toBeNull();
  await userEvent.click(screen.getByText("1. One"));
  expect(screen.getByText("未添加处理步骤")).toBeTruthy();
});

it("keeps completion controls unavailable while the source write is pending", async () => {
  let finish: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(true);
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Pending source" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example:1080#Pending" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "导入来源" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(
    (dialog.getByRole("button", { name: /取\s*消/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => finish!(json({ detail: "Try again" }, 503)));
  await dialog.findByText("Try again");
  expect(
    (dialog.getByRole("button", { name: /取\s*消/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("binds footer submission and field labels to each mounted editor even when they edit the same record", async () => {
  const source = {
    id: "shared-source",
    revision: "r1",
    name: "Shared record",
    kind: "text" as const,
    enabled: true,
    content: "socks5://proxy.example:1080#Shared",
  };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    json(init?.method === "PUT" ? JSON.parse(String(init.body)) : source),
  );
  vi.stubGlobal("fetch", fetcher);
  const firstSaved = vi.fn(),
    secondSaved = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourceEditorDialog
          open
          source={source}
          onClose={() => {}}
          onSaved={firstSaved}
        />
        <SourceEditorDialog
          open
          source={source}
          onClose={() => {}}
          onSaved={secondSaved}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  const dialogs = await screen.findAllByRole("dialog", { hidden: true });
  expect(dialogs).toHaveLength(2);
  for (const element of dialogs) {
    const dialog = within(element);
    const submit = (await dialog.findByRole("button", {
      name: "保存修改",
      hidden: true,
    })) as HTMLButtonElement;
    const form = element.querySelector("form");
    expect(submit.form).toBe(form);
    for (const label of element.querySelectorAll<HTMLLabelElement>(
      "label[for]",
    )) {
      expect(label.control?.closest("form")).toBe(form);
    }
  }
  const second = within(dialogs[1]);
  fireEvent.change(second.getByLabelText("来源名称"), {
    target: { value: "Second editor draft" },
  });
  // Two simultaneously mounted modal fixtures are intentionally inaccessible
  // to a real pointer. Dispatch this DOM-contract submission to its exact
  // footer owner; normal single-editor user submission is covered above.
  fireEvent.click(
    second.getByRole("button", { name: "保存修改", hidden: true }),
  );
  await waitFor(() => expect(secondSaved).toHaveBeenCalledTimes(1));
  expect(firstSaved).not.toHaveBeenCalled();
  expect(secondSaved.mock.calls[0][0]).toMatchObject({
    id: "shared-source",
    name: "Second editor draft",
    content: source.content,
  });
});

it("uses sequential scrolling on short screens and restores body scrolling when space returns", async () => {
  // JSDOM checks the resize decision, not actual field geometry or keyboard visibility.
  // The browser journey separately checks those contracts with doubled text.
  vi.stubGlobal("innerHeight", 240);
  mount(true);
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  await waitFor(() =>
    expect(dialog.getAttribute("data-task-scroll")).toBe("task"),
  );
  vi.stubGlobal("innerHeight", 844);
  fireEvent(window, new Event("resize"));
  await waitFor(() =>
    expect(dialog.getAttribute("data-task-scroll")).toBe("body"),
  );
});

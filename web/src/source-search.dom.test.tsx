// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourcesPage } from "./Sources";

const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const sources = [
  {
    id: "source-b",
    name: "南区 Beta",
    kind: "text",
    enabled: true,
    raw: "private-import-content",
  },
  {
    id: "source-a",
    name: "北区 Alpha",
    kind: "url",
    enabled: true,
    url: "https://private.example/subscription?token=secret",
  },
];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
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
  // jsdom has no layout. Fake only viewport geometry to exercise the real
  // DataTable hint alongside the real source page and official shadcn controls.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches('[data-slot="table-container"]') ? 320 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches('[data-slot="table-container"]') ? 680 : 0;
    },
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("distinguishes no matches and clears only the query to recover the same source identities and order", async () => {
  const fetcher = vi.fn(async () => json(sources));
  vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByRole("button", { name: /^南区 Beta\s*文本导入$/ });
  const search = screen.getByRole("textbox", {
    name: "搜索来源",
  }) as HTMLInputElement;
  const table = screen.getByRole("table");
  const rowIds = () =>
    Array.from(table.querySelectorAll("tr[data-row-key]")).map((row) =>
      row.getAttribute("data-row-key"),
    );
  expect(rowIds()).toEqual(["source-b", "source-a"]);
  expect(screen.getByText("向左右滚动查看完整表格")).toBeTruthy();

  fireEvent.change(search, { target: { value: "不存在的来源" } });
  expect(search.value).toBe("不存在的来源");
  expect(screen.getByText("没有匹配的来源")).toBeTruthy();
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  expect(screen.queryByText("向左右滚动查看完整表格")).toBeNull();
  expect(screen.getAllByRole("button", { name: "添加来源" })).toHaveLength(1);
  expect(screen.getByText("找到 0 个，共 2 个私有来源")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(
    /private-import-content|private\.example|token=secret/,
  );

  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("table")).toBe(table);
  expect(rowIds()).toEqual(["source-b", "source-a"]);
  expect(screen.queryByText("没有匹配的来源")).toBeNull();
  expect(screen.getByText("向左右滚动查看完整表格")).toBeTruthy();
  expect(
    within(table).getByRole("button", { name: /^南区 Beta\s*文本导入$/ }),
  ).toBeTruthy();
  expect(
    within(table).getByRole("button", { name: /^北区 Alpha\s*订阅链接$/ }),
  ).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);

  // Search is still case-insensitive and repeatable after recovery.
  fireEvent.change(search, { target: { value: "ALPHA" } });
  expect(rowIds()).toEqual(["source-a"]);
  fireEvent.change(search, { target: { value: "another no match" } });
  await userEvent.click(search);
  const clearSearch = screen.getByRole("button", { name: "清除搜索" });
  for (
    let tabs = 0;
    tabs < 3 && document.activeElement !== clearSearch;
    tabs++
  ) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(clearSearch);
  await userEvent.keyboard("{Enter}");
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
  expect(rowIds()).toEqual(["source-b", "source-a"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps loading, failed reads and true empty-inventory onboarding distinct from no matches", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(json([]));
  vi.stubGlobal("fetch", fetcher);
  mount();
  expect(screen.getByLabelText("正在加载")).toBeTruthy();
  expect(screen.queryByText("没有匹配的来源")).toBeNull();
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  await act(async () => finish(json({ detail: "无法读取来源" }, 503)));
  await screen.findByText("暂时无法加载");
  expect(screen.queryByText("没有匹配的来源")).toBeNull();
  expect(screen.queryByText("暂无订阅来源")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("暂无订阅来源");
  expect(screen.getAllByRole("button", { name: "添加来源" })).toHaveLength(2);
  const search = screen.getByRole("textbox", {
    name: "搜索来源",
  }) as HTMLInputElement;
  fireEvent.change(search, { target: { value: "existing query" } });
  expect(search.value).toBe("existing query");
  expect(screen.getByText("暂无订阅来源")).toBeTruthy();
  expect(screen.queryByText("没有匹配的来源")).toBeNull();
  expect(screen.queryByRole("button", { name: "清除搜索" })).toBeNull();
  expect(screen.queryByText("向左右滚动查看完整表格")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("separates source identity and secondary kind visually and in its accessible name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(sources)),
  );
  mount();
  const source = await screen.findByRole("button", {
    name: "南区 Beta 文本导入",
  });
  expect(source.classList.contains("inline-flex")).toBe(true);
  expect(source.classList.contains("gap-2")).toBe(true);
  const kind = within(source).getByText("文本导入");
  expect(kind.classList.contains("block")).toBe(true);
  expect(kind.classList.contains("text-muted-foreground")).toBe(true);
  const icon = source.querySelector(".table-icon")!;
  expect(icon.classList.contains("shrink-0")).toBe(true);
  expect(icon.classList.contains("[&_svg]:size-4")).toBe(true);
});

it("clears a matching source query without losing source identities or focus", async () => {
  const fetcher = vi.fn(async () => json(sources));
  vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByRole("button", { name: /^南区 Beta\s*文本导入$/ });
  const toolbar = screen.getByRole("search", { name: "查找订阅来源" });
  const search = within(toolbar).getByRole("textbox", { name: "搜索来源" });
  expect(within(toolbar).queryByText("2 个私有来源")).toBeNull();
  expect(screen.getByRole("columnheader", { name: "操作" })).toBeTruthy();
  await userEvent.type(search, "Alpha");
  expect(screen.getByText("找到 1 个，共 2 个私有来源")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^南区 Beta/ })).toBeNull();
  expect(screen.getByRole("button", { name: /^北区 Alpha/ })).toBeTruthy();
  const clear = within(toolbar).getByRole("button", { name: "清除搜索输入" });
  clear.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "");
  expect(screen.getByText("2 个私有来源")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^南区 Beta/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^北区 Alpha/ })).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

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

it("keeps collection membership and processing through unavailable inventory and explicit retry", async () => {
  const collection = {
    id: "c",
    name: "Travel",
    sources: [
      {
        sourceId: "s2",
        steps: [
          { id: "rename", kind: "rename", enabled: true, template: "{name}" },
        ],
      },
      { sourceId: "s1", steps: [] },
    ],
    steps: [],
  };
  let finish: (response: Response) => void = () => {};
  let attempts = 0;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/sources")) {
      attempts++;
      return attempts === 1
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : json([
            {
              id: "s1",
              name: "One",
              kind: "text",
              enabled: true,
              snapshot: { endpoints: [] },
            },
            {
              id: "s2",
              name: "Two",
              kind: "text",
              enabled: true,
              snapshot: { endpoints: [] },
            },
          ]);
    }
    if (init?.method === "PUT") return json(JSON.parse(String(init.body)));
    return json([collection]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  await userEvent.click(await screen.findByRole("button", { name: /Travel/ }));
  expect(screen.getByText("正在加载可选来源…")).toBeTruthy();
  expect(
    (
      screen.getByRole("combobox", {
        name: "订阅来源",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  await act(async () => {
    finish(json({ detail: "offline" }, 503));
  });
  await screen.findByText("暂时无法加载来源");
  expect(screen.queryByText("暂无可选来源")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("例如：日常连接"), {
    target: { value: "Travel revised" },
  });
  await userEvent.click(screen.getByRole("button", { name: "重试加载来源" }));
  await screen.findByText("1. Two");
  expect(
    (screen.getByPlaceholderText("例如：日常连接") as HTMLInputElement).value,
  ).toBe("Travel revised");
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      true,
    ),
  );
  const saved = fetcher.mock.calls.find(
    ([, init]) => init?.method === "PUT",
  )![1];
  expect(JSON.parse(String(saved?.body))).toEqual({
    ...collection,
    name: "Travel revised",
  });
});

it("ignores preview failure from a closed collection and lets the current collection retry its own failure", async () => {
  const a = { id: "a", name: "Alpha", sources: [], steps: [] };
  const b = { ...a, id: "b", name: "Beta" };
  let finish: (response: Response) => void = () => {};
  let previews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/preview")) {
        previews++;
        if (previews === 1)
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        if (previews === 2)
          return json({ detail: "Current preview failed" }, 422);
        return json({ endpoints: [] });
      }
      return json(String(url).endsWith("/sources") ? [] : [a, b]);
    }),
  );
  mount();
  await userEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
  await userEvent.click(screen.getByRole("button", { name: "预览处理结果" }));
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));
  await userEvent.click(screen.getByRole("button", { name: /Beta/ }));
  await act(async () => {
    finish(json({ detail: "Old preview failed" }, 422));
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "预览处理结果" }).className,
    ).not.toContain("loading"),
  );
  expect(screen.queryByText("Old preview failed")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "预览处理结果" }));
  await screen.findByText("Current preview failed");
  await userEvent.click(screen.getByRole("button", { name: "预览处理结果" }));
  await screen.findByText("逐阶段预览");
  expect(screen.queryByText("Current preview failed")).toBeNull();
});

it("offers a localized keyboard file picker, preserves cancellation and retries the same local file without uploading", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  mount(true);
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const picker = dialog.getByRole("button", { name: "选择配置文件" });
  const input = dialog.getByLabelText("读取配置文件") as HTMLInputElement;
  const clicked = vi.fn();
  input.addEventListener("click", clicked);
  picker.focus();
  await userEvent.keyboard("{Enter}");
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(dialog.getByRole("status").textContent).toBe("尚未选择文件");
  const file = new File(["config"], "我的连接.json", {
    type: "application/json",
  });
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("unreadable"))
    .mockResolvedValue("local content");
  Object.defineProperty(file, "text", { value: read });
  fireEvent.change(input, { target: { files: [file] } });
  await dialog.findByText("无法读取文件，请重新选择。");
  expect(dialog.getByRole("status").textContent).toContain("我的连接.json");
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { files: [] } });
  expect(dialog.getByRole("status").textContent).toContain("我的连接.json");
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(
      (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("local content"),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(dialog.queryByText("无法读取文件，请重新选择。")).toBeNull();
  expect(
    dialog.getByText(
      "文件先在本地读取，提交后才上传。仅提取受支持的连接内容。",
    ),
  ).toBeTruthy();
  expect(dialog.getByText(/平台运营者可处理其中的连接信息/)).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});

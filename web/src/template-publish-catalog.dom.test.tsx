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
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { TemplatesPage } from "./Templates";
import { setCSRF, setToken } from "./api";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
  setCSRF("");
  setToken("");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(read?: (url: string) => Response | Promise<Response>) {
  let collectionReads = 0;
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return json(url.endsWith("/sanitize") ? { spec: { steps: [] } } : {});
      }
      if (read && ["/api/me/collections", "/api/me/profiles"].includes(url))
        return read(url);
      if (url === "/api/me/collections" && ++collectionReads === 1)
        return new Response(
          JSON.stringify({ detail: "Collections unavailable" }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      if (url === "/api/me/collections")
        return json([
          { id: "one", name: "Saved collection", sources: [], pipeline: [] },
          { id: "two", name: "Other collection", sources: [], pipeline: [] },
        ]);
      return json([]);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <TemplatesPage admin />
      </UIProviders>
    </QueryClientProvider>,
  );
  return writes;
}

it("recovers a failed extraction-source catalog in the publishing dialog without discarding entered name", async () => {
  const writes = mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "发布模板" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), {
    target: { value: "Unpublished name" },
  });
  await waitFor(() =>
    expect(client.getQueryState(["collections"])?.status).toBe("error"),
  );
  const retry = within(dialog).getByRole("button", {
    name: "重新加载节点集合",
  });
  await userEvent.click(retry);
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Saved collection" }),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "模板名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Unpublished name");
  expect(writes).toEqual([]);
});

const savedSource = {
  id: "one",
  name: "Saved source",
  sources: [],
  pipeline: [],
  ir: {},
};
async function openSource(kind: "collection" | "profile" = "collection") {
  await userEvent.click(
    await screen.findByRole("button", { name: "发布模板" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), {
    target: { value: "Reviewed draft" },
  });
  if (kind === "profile") {
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: "模板类型" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "客户端配置模板" }),
    );
  }
  return dialog;
}
async function extractSource(dialog: HTMLElement) {
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Saved source" }),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "提取可共享结构" }),
  );
  await userEvent.click(await within(dialog).findByRole("checkbox"));
}
it.each(["collection", "profile"] as const)(
  "retains the reviewed draft and permits publication when background %s source verification fails",
  async (kind) => {
    let fail = false;
    const writes = mount(() =>
      fail
        ? new Response(JSON.stringify({ detail: "Sources unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
        : json([savedSource]),
    );
    const dialog = await openSource(kind);
    await extractSource(dialog);
    const spec = (
      within(dialog).getByRole("textbox", {
        name: "共享结构",
      }) as HTMLTextAreaElement
    ).value;
    fail = true;
    await act(async () => {
      await client.refetchQueries({
        queryKey: [kind === "collection" ? "collections" : "profiles"],
        exact: true,
      });
    });
    await within(dialog).findByText(
      `暂时无法加载${kind === "collection" ? "节点集合" : "客户端配置"}`,
    );
    expect(
      within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" })
        .textContent,
    ).toContain("Saved source");
    expect(
      within(dialog)
        .getByRole("button", { name: "提取可共享结构" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(dialog).getByRole("checkbox").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: "共享结构",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe(spec);
    const publish = within(dialog).getByRole("button", { name: "发布 v1" });
    expect(publish.hasAttribute("disabled")).toBe(false);
    await userEvent.click(publish);
    await waitFor(() =>
      expect(
        writes.filter((write) => write.url === "/api/admin/templates"),
      ).toHaveLength(1),
    );
  },
);
it("keeps a removed extraction source identified and recovers it without re-extracting or replacing the draft", async () => {
  const writes = mount(() => json([savedSource]));
  const dialog = await openSource();
  await extractSource(dialog);
  await act(async () => {
    client.setQueryData(["collections"], []);
  });
  expect(
    within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" })
      .textContent,
  ).toContain("Saved source");
  expect(await within(dialog).findByText("已不可用")).toBeTruthy();
  expect(
    within(dialog)
      .getByRole("button", { name: "提取可共享结构" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    within(dialog).getByRole("checkbox").getAttribute("aria-checked"),
  ).toBe("true");
  const before = [...writes];
  await userEvent.click(
    within(dialog).getByRole("button", { name: "重新加载节点集合" }),
  );
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "提取可共享结构" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(writes).toEqual(before);
  expect(within(dialog).queryByText("已不可用")).toBeNull();
});
it("distinguishes a pending initial source read from confirmed empty without offering a nonfunctional interrupted-read retry", async () => {
  let finish!: (value: Response) => void;
  mount((url) =>
    url.endsWith("/collections")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : json([]),
  );
  const dialog = await openSource();
  await within(dialog).findByText("正在读取节点集合列表…");
  expect(
    within(dialog)
      .getByRole("combobox", { name: "从自己的已保存配置提取" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(within(dialog).queryByText(/暂无已保存/)).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: /重新加载节点集合/ }),
  ).toBeNull();
  await act(async () => {
    finish(json([]));
  });
  await within(dialog).findByText("暂无已保存的节点集合，请先创建并保存。");
  expect(within(dialog).queryByText("正在读取节点集合列表…")).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "提取可共享结构" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("keeps paused source loading distinct from empty and resumes without a write", async () => {
  onlineManager.setOnline(false);
  const writes = mount(() => json([savedSource]));
  const dialog = await openSource();
  await within(dialog).findByText("节点集合列表读取已暂停，恢复网络后重试。");
  expect(within(dialog).queryByText(/暂无已保存/)).toBeNull();
  expect(
    within(dialog)
      .getByRole("button", { name: "提取可共享结构" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    onlineManager.setOnline(true);
  });
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("combobox", { name: "从自己的已保存配置提取" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(writes).toEqual([]);
});

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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SourcesPage } from "./Sources";
import { SubscriptionsPage } from "./Subscriptions";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const source = {
  id: "source-one",
  revision: "revision-one",
  name: "My source",
  kind: "text",
  enabled: true,
  content: "socks://localhost:1080",
  endpoints: [],
};
const clients: QueryClient[] = [];
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
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
  // JSDOM has no layout. AntD's nested-dialog focus trap uses offsetParent
  // to discover visible buttons; without this shim it cannot restore focus
  // when the underlying editor finishes opening after its discard prompt.
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("closes an untouched source without a discard prompt", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  mount(<SourcesPage />);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "添加来源" }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  await userEvent.click(
    within(dialog).getByRole("button", { name: /取\s*消/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("放弃尚未保存的来源修改？")).toBeNull();
});

it("keeps changed source values and identity when dismissal is canceled, and blocks dismissal while saving", async () => {
  let finishSave: ((response: Response) => void) | undefined;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT")
      return new Promise<Response>((resolve) => {
        finishSave = resolve;
      });
    if (String(url).endsWith("/reveal")) return json(source);
    const summary = { ...source, content: undefined };
    if (String(url) === "/api/me/sources/source-one") return json(summary);
    return json([summary]);
  });
  vi.stubGlobal("fetch", fetcher);
  const editingChanged = vi.fn();
  mount(<SourcesPage onEditingChange={editingChanged} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "编辑 My source" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "编辑来源" });
  fireEvent.change(within(dialog).getByLabelText("来源名称"), {
    target: { value: "Renamed source" },
  });
  await userEvent.click(
    within(dialog).getByRole("button", { name: /取\s*消/ }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "放弃尚未保存的来源修改？",
  });
  const keepEditing = within(confirmation).getByRole("button", {
    name: "继续编辑",
  });
  await waitFor(() => expect(document.activeElement).toBe(keepEditing));
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "放弃尚未保存的来源修改？" }),
    ).toBeNull(),
  );
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
    false,
  );
  expect(
    (within(dialog).getByLabelText("来源名称") as HTMLInputElement).value,
  ).toBe("Renamed source");
  expect(editingChanged).toHaveBeenLastCalledWith(true);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "保存修改" }),
  );
  await waitFor(() => expect(finishSave).toBeTruthy());
  const call = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(String(call[0])).toBe("/api/me/sources/source-one");
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({
    id: source.id,
    revision: source.revision,
    name: "Renamed source",
    content: source.content,
  });
  expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
  expect(
    (
      within(dialog).getByRole("button", {
        name: /^取\s*消$/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const busySave = within(dialog).getByRole("button", { name: "保存修改" });
  expect(busySave.getAttribute("aria-busy")).toBe("true");
  expect((busySave as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(busySave);
  expect(document.activeElement).toBe(busySave);
  await userEvent.keyboard("{Escape}");
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
  ).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "编辑来源" })).toBeTruthy();
  expect(screen.queryByText("放弃尚未保存的来源修改？")).toBeNull();
  finishSave!(json({ ...source, name: "Renamed source" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑来源" })).toBeNull(),
  );
});

it("requires explicit discard for a new source and clears it only after approval", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  mount(<SourcesPage />);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "添加来源" }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  fireEvent.change(within(dialog).getByLabelText("节点链接或配置内容"), {
    target: { value: "my unsaved config" },
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "放弃尚未保存的来源修改？",
  });
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows saved-draft query failure and restores continuation on retry", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/me/profiles"))
        return fail
          ? json({ message: "草稿读取失败" }, 503)
          : json([
              {
                id: "draft",
                name: "Saved draft",
                target: { adapterId: "sing-box" },
              },
            ]);
      return json(String(url).endsWith("/overview") ? { user: {} } : []);
    }),
  );
  mount(<SubscriptionsPage navigate={vi.fn()} />);
  await screen.findByText("暂时无法加载分流配置");
  expect(
    screen.getByRole("region", { name: "分流配置与客户端订阅" }),
  ).toBeTruthy();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "重试配置" }));
  await screen.findByText("Saved draft");
  expect(screen.getByRole("button", { name: "继续配置" })).toBeTruthy();
});

it("does not classify profiles as unpublished while outputs are loading or failed", async () => {
  let finishOutputs: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/me/outputs"))
        return new Promise<Response>((resolve) => {
          finishOutputs = resolve;
        });
      if (String(url).endsWith("/me/profiles"))
        return json([
          {
            id: "published-profile",
            name: "Published profile",
            target: { adapterId: "sing-box" },
          },
        ]);
      return json({ user: {} });
    }),
  );
  mount(<SubscriptionsPage navigate={vi.fn()} />);
  await waitFor(() => expect(finishOutputs).toBeTruthy());
  expect(screen.getByText("正在加载配置与客户端订阅…")).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "分流配置与客户端订阅" }),
  ).toBeTruthy();
  finishOutputs!(json({ message: "订阅读取失败" }, 503));
  await screen.findByText("暂时无法加载客户端订阅");
  expect(screen.getByText(/关联订阅待核对/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新核对订阅" })).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "分流配置与客户端订阅" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "继续配置" })).toBeNull();
});

it("guards browser navigation only for changed source fields, including file-loaded content", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  mount(<SourcesPage />);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "添加来源" }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  const unloadBlocked = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await waitFor(() => expect(unloadBlocked()).toBe(false));
  fireEvent.change(within(dialog).getByLabelText("来源名称"), {
    target: { value: "changed" },
  });
  await waitFor(() => expect(unloadBlocked()).toBe(true));
  fireEvent.change(within(dialog).getByLabelText("来源名称"), {
    target: { value: "" },
  });
  await waitFor(() => expect(unloadBlocked()).toBe(false));
  const file = new File(["socks://localhost:1080"], "source.txt", {
    type: "text/plain",
  });
  Object.defineProperty(file, "text", {
    value: async () => "socks://localhost:1080",
  });
  fireEvent.change(within(dialog).getByLabelText("读取配置文件"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(
      (
        within(dialog).getByLabelText(
          "节点链接或配置内容",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("socks://localhost:1080"),
  );
  await waitFor(() => expect(unloadBlocked()).toBe(true));
});

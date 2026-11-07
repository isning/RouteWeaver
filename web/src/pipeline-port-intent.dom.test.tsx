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

// Public page and transport boundary only. These regressions are UNRUN.
function collectionFixture() {
  const override = () => ({ id: "same-step", kind: "override", enabled: true, override: { port: 443 } });
  return { id: "ports", name: "Ports", sources: [{ sourceId: "source", steps: [override()] }], steps: [override()] };
}
function serve(collection = collectionFixture()) {
  const writes: { path: string; body: ReturnType<typeof collectionFixture> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT" || init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      return json(path.endsWith("preview") ? { endpoints: [], stages: [] } : body);
    }
    if (path.endsWith("/sources")) return json([{ id: "source", name: "Origin", kind: "text", enabled: true, snapshot: { endpoints: [] } }]);
    return json([collection]);
  }));
  mount();
  return writes;
}

it.each(["1e", "-", "443.00000000000000001", "65535.000000000000001"])("blocks source port %s even when collapsed without contaminating aggregate with same step ID", async (raw) => {
  const writes = serve();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Ports.*编辑集合/ }));
  const disclosure = screen.getByRole("button", { name: /1\. Origin.*来源处理/ });
  await user.click(disclosure);
  const source = screen.getByRole("group", { name: "来源处理" });
  const merged = screen.getByRole("group", { name: "合并后处理" });
  const port = within(source).getByRole("spinbutton", { name: "覆盖端口" });
  fireEvent.change(port, { target: { value: raw } });
  await user.click(disclosure);
  await user.click(screen.getByRole("button", { name: "预览处理结果" }));
  await waitFor(() => expect(document.activeElement).toBe(port));
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(document.activeElement).toBe(port));
  expect(writes).toEqual([]);
  expect((within(merged).getByRole("spinbutton", { name: "覆盖端口" }) as HTMLInputElement).value).toBe("443");
  fireEvent.change(port, { target: { value: "8.080e3" } });
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.sources[0].steps[0].override.port).toBe(8080);
  expect(writes[0].body.steps[0].override.port).toBe(443);
});

it("retains disabled aggregate port intent and repairs by arrow", async () => {
  const writes = serve();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Ports.*编辑集合/ }));
  const merged = screen.getByRole("group", { name: "合并后处理" });
  const port = within(merged).getByRole("spinbutton", { name: "覆盖端口" });
  fireEvent.change(port, { target: { value: "443.00000000000000001" } });
  await user.click(within(merged).getByRole("switch", { name: "启用步骤 1" }));
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  expect(writes).toEqual([]);
  fireEvent.keyDown(port, { key: "ArrowUp" });
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.steps[0].override.port).toBe(444);
  expect(writes[0].body.steps[0].enabled).toBe(false);
});

it.each(["blank", "untouched", "removed"])("preserves pipeline %s port semantics", async (mode) => {
  const collection = collectionFixture();
  collection.steps[0].override.port = 0;
  const writes = serve(collection);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Ports.*编辑集合/ }));
  const merged = screen.getByRole("group", { name: "合并后处理" });
  if (mode !== "untouched") {
    fireEvent.change(within(merged).getByRole("spinbutton", { name: "覆盖端口" }), { target: { value: mode === "blank" ? "" : "1e" } });
    if (mode === "removed") await user.click(within(merged).getByRole("button", { name: "删除步骤 1" }));
  }
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  if (mode === "removed") expect(writes[0].body.steps).toEqual([]);
  else expect(writes[0].body.steps[0].override.port).toBe(mode === "blank" ? undefined : 0);
});

it("retains both raw ports through an actual source-subtask unmount and return", async () => {
  const writes = serve();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Ports.*编辑集合/ }));
  await user.click(screen.getByRole("button", { name: /1\. Origin.*来源处理/ }));
  const originalSourcePort = within(screen.getByRole("group", { name: "来源处理" })).getByRole("spinbutton", { name: "覆盖端口" });
  fireEvent.change(originalSourcePort, { target: { value: "443.00000000000000001" } });
  fireEvent.change(within(screen.getByRole("group", { name: "合并后处理" })).getByRole("spinbutton", { name: "覆盖端口" }), { target: { value: "1e" } });
  await user.click(screen.getByRole("button", { name: "添加来源" }));
  const sourceDialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  await waitFor(() => expect(originalSourcePort.isConnected).toBe(false));
  await user.click(within(sourceDialog).getByRole("button", { name: "关闭" }));
  const collectionDialog = await screen.findByRole("dialog", { name: "Ports" });
  const sourcePort = within(within(collectionDialog).getByRole("group", { name: "来源处理" })).getByRole("spinbutton", { name: "覆盖端口" });
  const aggregatePort = within(within(collectionDialog).getByRole("group", { name: "合并后处理" })).getByRole("spinbutton", { name: "覆盖端口" });
  expect((sourcePort as HTMLInputElement).value).toBe("443.00000000000000001");
  expect((aggregatePort as HTMLInputElement).value).toBe("1e");
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(document.activeElement).toBe(sourcePort));
  expect(writes).toEqual([]);
  fireEvent.change(sourcePort, { target: { value: "8443" } });
  await user.click(screen.getByRole("button", { name: "预览处理结果" }));
  await waitFor(() => expect(document.activeElement).toBe(aggregatePort));
  expect(writes).toEqual([]);
  fireEvent.change(aggregatePort, { target: { value: "8080" } });
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.sources[0].steps[0].override.port).toBe(8443);
  expect(writes[0].body.steps[0].override.port).toBe(8080);
});

it("keeps raw edits when discard is cancelled and clears them for a new opening after confirmed discard", async () => {
  const writes = serve();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Ports.*编辑集合/ }));
  await user.click(screen.getByRole("button", { name: /1\. Origin.*来源处理/ }));
  fireEvent.change(within(screen.getByRole("group", { name: "来源处理" })).getByRole("spinbutton", { name: "覆盖端口" }), { target: { value: "1e" } });
  fireEvent.change(within(screen.getByRole("group", { name: "合并后处理" })).getByRole("spinbutton", { name: "覆盖端口" }), { target: { value: "443.00000000000000001" } });
  await user.click(within(screen.getByRole("dialog", { name: "Ports" })).getByRole("button", { name: "关闭" }));
  await user.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect((within(screen.getByRole("group", { name: "来源处理" })).getByRole("spinbutton", { name: "覆盖端口" }) as HTMLInputElement).value).toBe("1e");
  await user.click(within(screen.getByRole("dialog", { name: "Ports" })).getByRole("button", { name: "关闭" }));
  await user.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
  // Reuse the same collection, source, and step IDs in a fresh editing session.
  await user.click(screen.getByRole("button", { name: /^Ports.*编辑集合/ }));
  await user.click(screen.getByRole("button", { name: /1\. Origin.*来源处理/ }));
  expect((within(screen.getByRole("group", { name: "来源处理" })).getByRole("spinbutton", { name: "覆盖端口" }) as HTMLInputElement).value).toBe("443");
  expect((within(screen.getByRole("group", { name: "合并后处理" })).getByRole("spinbutton", { name: "覆盖端口" }) as HTMLInputElement).value).toBe("443");
  await user.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.sources[0].steps[0].override.port).toBe(443);
  expect(writes[0].body.steps[0].override.port).toBe(443);
});

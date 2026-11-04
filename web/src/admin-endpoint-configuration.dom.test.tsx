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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import type { NodeRecord } from "./types";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(node: NodeRecord) {
  const writes: NodeRecord[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const data =
        init?.method === "PUT"
          ? (writes.push(JSON.parse(init.body)), writes.at(-1))
          : String(url) === "/api/state"
            ? {
                nodes: [node],
                users: [],
                routes: [],
                capabilities: [],
                revisions: [],
              }
            : [];
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="nodes" />
      </UIProviders>
    </QueryClientProvider>,
  );
  return writes;
}
it("edits the primary endpoint with the complete client connection fields and preserves unopened metadata", async () => {
  const node: NodeRecord = {
    id: "n1",
    name: "Advanced endpoint",
    host: "edge.example.test",
    port: 443,
    protocol: "vless",
    uuid: "4de8a1b9-d2fd-460a-8253-06b44cf76c7f",
    region: "UK",
    coreId: "xray-instance",
    coreVersion: "26.3",
    tags: ["private"],
    tls: { enabled: true, serverName: "sni.example.test", alpn: ["h2"] },
    transport: {
      type: "ws",
      path: "/tunnel",
      host: "host.example.test",
      headers: { "X-Test": "preserve-me" },
    },
  };
  const writes = mount(node);
  await userEvent.click(
    await screen.findByRole("button", { name: /^Advanced endpoint/ }),
  );
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑端点" }),
  );
  expect(dialog.getByRole("group", { name: "协议与认证" })).toBeTruthy();
  fireEvent.change(dialog.getByLabelText("端点名称"), {
    target: { value: "Renamed endpoint" },
  });
  const submit = dialog.getByRole("button", {
    name: "保存",
  }) as HTMLButtonElement;
  expect(submit.form).toBe(dialog.getByLabelText("端点名称").closest("form"));
  expect(submit.closest("[data-task-overlay-body]")).toBeNull();
  await userEvent.click(submit);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ ...node, name: "Renamed endpoint" });
});
it("keeps destructive endpoint actions in a row menu and restores focus after cancelling", async () => {
  const node: NodeRecord = {
    id: "n1",
    name: "London endpoint",
    host: "edge.example.test",
    port: 443,
    protocol: "socks",
  };
  const writes = mount(node);
  const more = await screen.findByRole("button", {
    name: "更多操作 London endpoint",
  });
  expect(
    screen.queryByRole("button", { name: "删除端点 London endpoint" }),
  ).toBeNull();
  await userEvent.click(more);
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "删除端点 London endpoint" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "删除端点「London endpoint」？",
  });
  expect(
    within(confirmation).getByText("仍被链路配置引用的端点不能删除。请先从相关链路配置中移除引用。"),
  ).toBeTruthy();
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "保留" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(more));
  expect(writes).toHaveLength(0);
});

/** JSDOM has no live computed animation style. Keep actual Radix Presence in
 * its exit phase by exposing the browser's live animationName contract. */
function retainDialogDuringExit() {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computedStyle(element, pseudo);
    if (element.matches('[data-task-overlay="dialog"]')) {
      Object.defineProperty(style, "animationName", {
        configurable: true,
        get: () =>
          element.getAttribute("data-state") === "closed"
            ? "task-exit"
            : "none",
      });
    }
    return style;
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
}
function finishDialogExit(dialog: HTMLElement) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "task-exit" });
  fireEvent(dialog, event);
}
it("retains endpoint presentation while its exit is mounted and rejects closed-task submission", async () => {
  retainDialogDuringExit();
  const node: NodeRecord = {
    id: "n1",
    name: "Closing endpoint",
    host: "edge.example.test",
    port: 443,
    protocol: "socks",
  };
  const writes = mount(node);
  const opener = await screen.findByRole("button", {
    name: /^Closing endpoint/,
  });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "编辑端点" });
  await userEvent.keyboard("{Escape}");
  expect(dialog.isConnected).toBe(true);
  expect(dialog.getAttribute("data-state")).toBe("closed");
  expect(
    within(dialog).getByRole("heading", { name: "编辑端点" }),
  ).toBeTruthy();
  expect(within(dialog).getByLabelText("端点名称")).toHaveProperty(
    "value",
    "Closing endpoint",
  );
  expect(within(dialog).queryByLabelText("用户名称")).toBeNull();
  fireEvent.submit(within(dialog).getByLabelText("端点名称").closest("form")!);
  expect(writes).toHaveLength(0);
  finishDialogExit(dialog);
  await waitFor(() => expect(dialog.isConnected).toBe(false));
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
it("does not let a closing endpoint presentation replace a reopened task", async () => {
  retainDialogDuringExit();
  const node: NodeRecord = {
    id: "n1",
    name: "Old endpoint",
    host: "edge.example.test",
    port: 443,
    protocol: "socks",
  };
  const writes = mount(node);
  await screen.findByRole("button", { name: /^Old endpoint/ });
  const add = screen.getByRole("button", { name: "添加端点" });
  await userEvent.click(screen.getByRole("button", { name: /^Old endpoint/ }));
  const closing = await screen.findByRole("dialog", { name: "编辑端点" });
  await userEvent.keyboard("{Escape}");
  expect(closing.getAttribute("data-state")).toBe("closed");
  // An owner may open a new task before the previous exit has completed.
  // The fading modal is inert; this models that parent transition directly.
  fireEvent.click(add);
  const reopened = await screen.findByRole("dialog", { name: "添加端点" });
  expect(within(reopened).getByLabelText("端点名称")).toHaveProperty(
    "value",
    "",
  );
  finishDialogExit(closing);
  expect(reopened.getAttribute("data-state")).toBe("open");
  expect(screen.getByRole("dialog", { name: "添加端点" })).toBe(reopened);
  expect(within(reopened).getByLabelText("端点名称")).toHaveProperty(
    "value",
    "",
  );
  expect(writes).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  expect(reopened.getAttribute("data-state")).toBe("closed");
  expect(
    within(reopened).getByRole("heading", { name: "添加端点" }),
  ).toBeTruthy();
  finishDialogExit(reopened);
  await waitFor(() => expect(reopened.isConnected).toBe(false));
});

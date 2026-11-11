// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  setToken("");
  setCSRF("");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  history.replaceState(null, "", "/#settings");
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
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
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      postMessage() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(save?: (body: Record<string, string>) => Promise<Response>) {
  const writes: { path: string; body: Record<string, string> }[] = [];
  const me: () => Promise<Response> = async () =>
    json({
      user: { id: "admin", name: "Admin", role: "admin" },
      csrfToken: "fixture",
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      if (init?.method && init.method !== "GET") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (path === "/api/settings" && init.method === "PUT" && save)
          return save(body);
        throw new Error(`Unexpected write: ${path}`);
      }
      if (path.endsWith("/auth/me")) return me();
      if (path.endsWith("/state"))
        return json({
          users: [],
          nodes: [],
          routes: [],
          capabilities: [],
          revisions: [],
        });
      if (path.endsWith("/settings"))
        return json({
          name: "RouteWeaver",
          registration: "invite",
          timezone: "UTC+8",
        });
      if (path === "/api/admin/subscription-origin")
        return json({
          revision: 1,
          configuredRevision: 1,
          draftOrigin: "",
          effectiveRevision: 1,
          effectiveOrigin: "",
          defaultOrigin: "",
          currentLinkExample: "/feed/{existing-token}",
          proposedLinkExample: "/feed/{existing-token}",
          verificationStatus: "not-required",
          tokensUnchanged: true,
        });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <App />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes };
}

// Public seam: the actual App/session boundary and basic-settings name task.
// HTTP and browser platform APIs are synthetic; no private component mocks.
it("returns an invalid name save to its retained field in the actual settings workspace", async () => {
  const { writes } = mount(async (body) => json(body));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const form = within(screen.getByRole("form", { name: "平台基本设置" }));
  const name = form.getByRole("textbox", { name: "平台名称" });
  const domain = screen.getByRole("textbox", { name: "订阅域名草稿" });
  fireEvent.change(domain, { target: { value: "https://draft.example.test" } });
  await user.clear(name);
  await user.click(form.getByRole("button", { name: "保存设置" }));
  const error = await form.findByText("请填写平台名称");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(name.getAttribute("aria-describedby")?.split(/\s+/)).toContain(
    error.id,
  );
  expect(name).toHaveProperty("value", "");
  expect(domain).toHaveProperty("value", "https://draft.example.test");
  expect(writes).toEqual([]);
  expect(document.activeElement).toBe(name);
  await user.click(form.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.type(name, "Corrected platform");
  await user.click(form.getByRole("button", { name: "保存设置" }));
  await form.findByText("平台设置已保存");
  expect(writes).toEqual([
    {
      path: "/api/settings",
      body: {
        name: "Corrected platform",
        registration: "invite",
        timezone: "UTC+8",
      },
    },
  ]);
  expect(domain).toHaveProperty("value", "https://draft.example.test");
});

it("cancels invalid name edits and reopens the accepted name without discarding the domain draft", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  const edit = await screen.findByRole("button", { name: "编辑平台名称" });
  await user.click(edit);
  const name = screen.getByRole("textbox", { name: "平台名称" });
  const domain = screen.getByRole("textbox", { name: "订阅域名草稿" });
  fireEvent.change(domain, { target: { value: "https://draft.example.test" } });
  await user.clear(name);
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText("请填写平台名称");
  await user.click(screen.getByRole("button", { name: "取消名称修改" }));
  expect(document.activeElement).toBe(edit);
  await user.click(edit);
  expect(screen.getByRole("textbox", { name: "平台名称" })).toHaveProperty(
    "value",
    "RouteWeaver",
  );
  expect(screen.queryByText("请填写平台名称")).toBeNull();
  expect(domain).toHaveProperty("value", "https://draft.example.test");
  expect(writes).toEqual([]);
});

it("keeps a newer draft and domain focus when an earlier name save finishes", async () => {
  let finish!: (response: Response) => void;
  const { writes } = mount(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const name = screen.getByRole("textbox", { name: "平台名称" });
  fireEvent.change(name, { target: { value: "Submitted name" } });
  const save = screen.getByRole("button", { name: "保存设置" });
  await user.click(save);
  await user.click(save);
  expect(writes).toHaveLength(1);
  expect(screen.getByRole("button", { name: "取消名称修改" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.change(name, { target: { value: "Newer draft" } });
  const domain = screen.getByRole("textbox", { name: "订阅域名草稿" });
  await user.click(domain);
  await act(async () => finish(json(writes[0].body)));
  await screen.findByText("提交的设置已保存，当前修改尚未保存");
  expect(document.activeElement).toBe(domain);
  expect(name).toHaveProperty("value", "Newer draft");
  await user.click(screen.getByRole("button", { name: "取消名称修改" }));
  await user.click(screen.getByRole("button", { name: "编辑平台名称" }));
  expect(screen.getByRole("textbox", { name: "平台名称" })).toHaveProperty(
    "value",
    "Submitted name",
  );
});

it.each(["domain", "backup"] as const)(
  "does not reclaim %s focus after an invalid name submission",
  async (destination) => {
    mount();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "编辑平台名称" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "平台名称" }));
    const save = screen.getByRole("button", { name: "保存设置" });
    const next =
      destination === "domain"
        ? screen.getByRole("textbox", { name: "订阅域名草稿" })
        : screen.getByRole("tab", { name: "备份与恢复" });
    act(() => {
      save.focus();
      fireEvent.click(save);
      next.focus();
      fireEvent.click(next);
    });
    await screen.findByText("请填写平台名称");
    expect(document.activeElement).toBe(next);
  },
);

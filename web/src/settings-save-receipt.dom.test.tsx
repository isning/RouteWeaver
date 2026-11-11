// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  cleanup,
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
function mount(
  save?: (body: Record<string, string>) => Promise<Response>,
  read?: () => Promise<Response>,
) {
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
        return read
          ? read()
          : json({
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

// Public seam: real App/session UI; only HTTP and browser APIs are synthetic.
// A malformed successful receipt must not replace the accepted baseline.
it.each([
  ["missing fields", () => json({})],
  ["empty body", () => new Response(null, { status: 204 })],
  ["invalid JSON", () => new Response("<html>upstream</html>")],
  [
    "mismatched name",
    () =>
      json({
        name: "Other platform",
        timezone: "UTC+8",
        registration: "invite",
      }),
  ],
  [
    "unsupported policy",
    () =>
      json({ name: "Draft platform", timezone: "UTC", registration: "invite" }),
  ],
] as const)(
  "preserves the name draft until explicit reconciliation after a successful response with %s",
  async (_label, receipt) => {
    const { writes } = mount(async () => receipt());
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "编辑平台名称" }),
    );
    const form = within(screen.getByRole("form", { name: "平台基本设置" }));
    await user.clear(form.getByRole("textbox", { name: "平台名称" }));
    await user.type(
      form.getByRole("textbox", { name: "平台名称" }),
      "Draft platform",
    );
    await user.click(form.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await form.findByRole("alert");
    expect(form.queryByText("平台设置已保存")).toBeNull();
    expect(
      (form.getByRole("textbox", { name: "平台名称" }) as HTMLInputElement)
        .value,
    ).toBe("Draft platform");
    expect(form.getByRole("alert").textContent).toContain("保存结果尚未确认");
    expect(
      form.getByRole("button", { name: "保存设置" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      form
        .getByRole("button", { name: "取消名称修改" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(form.getByRole("button", { name: "核对当前设置" }));
    await form.findByRole("status");
    await user.click(form.getByRole("button", { name: "取消名称修改" }));
    expect(form.getByText("RouteWeaver", { exact: true })).toBeTruthy();
    expect(writes).toHaveLength(1);
  },
);

it.each(["lost response", "server error"])(
  "warns that leaving cannot undo an unconfirmed settings write after %s",
  async (outcome) => {
    let current = {
      name: "RouteWeaver",
      registration: "invite",
      timezone: "UTC+8",
    };
    const { writes } = mount(
      async (body) => {
        current = { ...current, ...body };
        if (outcome === "server error")
          return json({ message: "upstream failed" }, 503);
        throw new TypeError("Connection lost after commit");
      },
      async () => json(current),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "编辑平台名称" }),
    );
    const form = within(screen.getByRole("form", { name: "平台基本设置" }));
    fireEvent.change(form.getByRole("textbox", { name: "平台名称" }), {
      target: { value: "Committed platform" },
    });
    await user.click(form.getByRole("button", { name: "保存设置" }));
    await form.findByRole("alert");
    await act(async () => {
      location.hash = "#resources";
    });
    const leave = within(await screen.findByRole("alertdialog"));
    expect(leave.getByText(/保存可能已完成/).textContent).toContain(
      "离开不会撤销",
    );
    expect(leave.queryByText(/当前编辑尚未保存/)).toBeNull();
    expect(writes).toHaveLength(1);
  },
);

it("reconciles the current server value after response loss without claiming a save receipt", async () => {
  let current = {
    name: "RouteWeaver",
    registration: "invite",
    timezone: "UTC+8",
  };
  const { writes } = mount(
    async (body) => {
      current = { ...current, ...body };
      throw new TypeError("Lost after commit");
    },
    async () => json(current),
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const form = within(screen.getByRole("form", { name: "平台基本设置" }));
  fireEvent.change(form.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "Committed platform" },
  });
  await user.click(form.getByRole("button", { name: "保存设置" }));
  await form.findByRole("alert");
  await user.click(form.getByRole("button", { name: "核对当前设置" }));
  expect((await form.findByRole("status")).textContent).toBe(
    "已核对当前平台设置",
  );
  expect(form.queryByRole("textbox", { name: "平台名称" })).toBeNull();
  expect(form.getByText("Committed platform", { exact: true })).toBeTruthy();
  expect(writes).toHaveLength(1);
  await act(async () => {
    location.hash = "#resources";
  });
  await screen.findByRole("heading", { name: "规则资源", level: 1 });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps newer name and independent domain input when reconciliation fails and later reads current settings", async () => {
  let reads = 0;
  let finishRead!: (response: Response) => void;
  const { writes } = mount(
    async () => {
      throw new TypeError("Lost");
    },
    async () => {
      reads++;
      if (reads === 1)
        return json({
          name: "RouteWeaver",
          timezone: "UTC+8",
          registration: "invite",
        });
      if (reads === 2) return json({});
      return new Promise<Response>((resolve) => {
        finishRead = resolve;
      });
    },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const form = within(screen.getByRole("form", { name: "平台基本设置" }));
  const name = form.getByRole("textbox", { name: "平台名称" });
  const domain = screen.getByRole("textbox", { name: "订阅域名草稿" });
  fireEvent.change(name, { target: { value: "Submitted platform" } });
  fireEvent.change(domain, { target: { value: "https://draft.example.test" } });
  await user.click(form.getByRole("button", { name: "保存设置" }));
  await form.findByRole("alert");
  await user.click(form.getByRole("button", { name: "核对当前设置" }));
  await form.findByText("无法核对当前平台设置。当前输入已保留，请重试核对。");
  expect(form.queryByRole("status")).toBeNull();
  expect(
    form.getByRole("button", { name: "保存设置" }).hasAttribute("disabled"),
  ).toBe(true);
  await user.click(form.getByRole("button", { name: "核对当前设置" }));
  await waitFor(() => expect(reads).toBe(3));
  fireEvent.change(name, { target: { value: "Newer platform draft" } });
  await act(async () =>
    finishRead(
      json({
        name: "Server platform",
        timezone: "UTC+8",
        registration: "invite",
      }),
    ),
  );
  expect((await form.findByRole("status")).textContent).toBe(
    "已核对当前平台设置，当前修改尚未保存",
  );
  expect((name as HTMLInputElement).value).toBe("Newer platform draft");
  expect((domain as HTMLInputElement).value).toBe("https://draft.example.test");
  await user.click(form.getByRole("button", { name: "取消名称修改" }));
  expect(form.getByText("Server platform", { exact: true })).toBeTruthy();
  expect((domain as HTMLInputElement).value).toBe("https://draft.example.test");
  expect(writes).toHaveLength(1);
});

it("keeps a known validation refusal editable and retries only on an explicit save", async () => {
  let attempts = 0;
  const { writes } = mount(async (body) =>
    ++attempts === 1
      ? json({ message: "名称不可用，请修改" }, 400)
      : json(body),
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  const form = within(screen.getByRole("form", { name: "平台基本设置" }));
  fireEvent.change(form.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "Refused name" },
  });
  await user.click(form.getByRole("button", { name: "保存设置" }));
  expect((await form.findByRole("alert")).textContent).toContain(
    "名称不可用，请修改",
  );
  expect(form.queryByRole("button", { name: "核对当前设置" })).toBeNull();
  expect(writes).toHaveLength(1);
  fireEvent.change(form.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "Accepted name" },
  });
  await user.click(form.getByRole("button", { name: "保存设置" }));
  expect((await form.findByRole("status")).textContent).toBe("平台设置已保存");
  expect(form.getByText("Accepted name", { exact: true })).toBeTruthy();
  expect(writes).toHaveLength(2);
});

it("departed reconciliation cannot replace a newer saved settings receipt", async () => {
  let current = {
    name: "RouteWeaver",
    timezone: "UTC+8",
    registration: "invite",
  };
  let reads = 0;
  let writesCount = 0;
  let finishOldRead!: (r: Response) => void;
  mount(
    async (body) => {
      current = { ...current, ...body };
      if (++writesCount === 1) throw new TypeError("Lost");
      return json(current);
    },
    async () => {
      if (++reads === 2)
        return new Promise<Response>((resolve) => {
          finishOldRead = resolve;
        });
      return json(current);
    },
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(screen.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "First" },
  });
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText(/保存结果尚未确认/);
  await user.click(screen.getByRole("button", { name: "核对当前设置" }));
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => {
    location.hash = "#resources";
  });
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "仍然离开",
    }),
  );
  await screen.findByRole("heading", { name: "规则资源", level: 1 });
  await act(async () => {
    location.hash = "#settings";
  });
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(screen.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "Second" },
  });
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText("平台设置已保存");
  await act(async () =>
    finishOldRead(
      json({ name: "First", timezone: "UTC+8", registration: "invite" }),
    ),
  );
  await act(async () => {
    location.hash = "#resources";
  });
  await screen.findByRole("heading", { name: "规则资源", level: 1 });
  await act(async () => {
    location.hash = "#settings";
  });
  const form = within(
    await screen.findByRole("form", { name: "平台基本设置" }),
  );
  expect(form.getByText("Second", { exact: true })).toBeTruthy();
});

it("admits only one reconciliation on a fast double click before a later name save", async () => {
  let reads = 0,
    writes = 0;
  let finishOldRead!: (r: Response) => void;
  let current = {
    name: "RouteWeaver",
    timezone: "UTC+8",
    registration: "invite",
  };
  mount(
    async (body) => {
      current = { ...current, ...body };
      if (++writes === 1) throw new TypeError("Lost");
      return json(current);
    },
    async () => {
      if (++reads === 2)
        return new Promise<Response>((resolve) => {
          finishOldRead = resolve;
        });
      return json(current);
    },
  );
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(screen.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "First" },
  });
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText(/保存结果尚未确认/);
  await user.dblClick(screen.getByRole("button", { name: "核对当前设置" }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByText("已核对当前平台设置")).toBeNull();
  await act(async () =>
    finishOldRead(
      json({ name: "First", timezone: "UTC+8", registration: "invite" }),
    ),
  );
  await screen.findByText("已核对当前平台设置");
  await user.click(screen.getByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(screen.getByRole("textbox", { name: "平台名称" }), {
    target: { value: "Second" },
  });
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText("平台设置已保存");
  expect(reads).toBe(2);
  const form = within(screen.getByRole("form", { name: "平台基本设置" }));
  expect(form.getByText("Second", { exact: true })).toBeTruthy();
});

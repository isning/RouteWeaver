// @vitest-environment jsdom
// Public render seams; the editor module gate is intentionally controlled.
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import { SubscriptionsPage } from "./Subscriptions";
const editor = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release, requested: false };
});
vi.mock("./Profiles", async (importOriginal) => {
  editor.requested = true;
  await editor.gate;
  return importOriginal<typeof import("./Profiles")>();
});
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
const createClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return client;
};
const state = {
  users: [],
  nodes: [],
  routes: [],
  revisions: [],
  capabilities: [],
  services: [],
  settings: {},
  publishedRoutes: [],
};
it("explains an empty endpoint list through the chain configurations that consume it", () => {
  const client = createClient();
  client.setQueryData(["admin-state"], state);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="nodes" />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(
    screen.getByRole("heading", { name: "连接端点", level: 1 }),
  ).toBeTruthy();
  expect(
    screen.getByText("维护连接端点，供链路配置引用。"),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "暂无连接端点" })).toBeTruthy();
  expect(
    screen.queryByText("管理可复用的连接参数，供链路配置引用。"),
  ).toBeNull();
  expect(
    screen.queryByText("管理可复用的连接参数，供转发路径引用。"),
  ).toBeNull();
});
it.each(["settings", "nodes"] as const)(
  "reserves the pending %s page's form or table geometry",
  (page) => {
    const client = createClient();
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        methods.push(init?.method || "GET");
        return new Promise<Response>(() => {});
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <AdminPage page={page} />
        </UIProviders>
      </QueryClientProvider>,
    );
    const pending = screen.getByRole("status", { name: "正在加载" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(
      pending.querySelector(
        page === "settings" ? ".settings-skeleton" : ".min-h-16",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(page === "settings" ? "保存设置" : "暂无连接端点"),
    ).toBeNull();
    expect(methods.every((method) => method === "GET")).toBe(true);
  },
);
it("shows a named form skeleton while the editor module loads, then retains the unsaved draft through canceled departure", async () => {
  const user = userEvent.setup();
  const client = createClient();
  const writes: string[] = [];
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes.push(url);
      return new Response(
        JSON.stringify(
          url.endsWith("/overview") ? { status: "active", routes: [] } : [],
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "新建分流配置" }));
  try {
    await waitFor(() => expect(editor.requested).toBe(true));
    const pending = await screen.findByRole("status", { name: "正在打开配置" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.querySelector(".sm\\:grid-cols-2")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
    expect(writes).toEqual([]);
  } finally {
    await act(async () => editor.release());
  }
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  expect(screen.queryByRole("status", { name: "正在打开配置" })).toBeNull();
  await user.type(name, "Unsent module-transition draft");
  await user.click(screen.getByRole("button", { name: "返回" }));
  const discard = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await user.click(within(discard).getByRole("button", { name: "继续编辑" }));
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Unsent module-transition draft");
  expect(writes).toEqual([]);
});

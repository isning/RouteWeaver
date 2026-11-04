// @vitest-environment jsdom
// Focus ownership through the public resource task; browser geometry is separate.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourcesPage } from "./Resources";
import { PublishedRoutesPage } from "./PublishedRoutes";

const clients: QueryClient[] = [];
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === "/api/me/resources" &&
        (!init?.method || init.method === "GET")
      )
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
        });
      throw new Error(`Unexpected request: ${init?.method || "GET"} ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
it.each(["file", "reference"] as const)(
  "offers one keyboard-reachable %s action in the resource empty state",
  async (kind) => {
    mount(<ResourcesPage />);
    await screen.findByText("暂无规则资源");
    const user = userEvent.setup();
    const name = kind === "file" ? "导入规则文件" : "添加公开引用";
    const action = screen.getByRole("button", { name });
    await user.tab();
    if (kind === "file") await user.tab();
    expect(document.activeElement).toBe(action);
    await user.keyboard("{Enter}");
    const title = kind === "file" ? "导入规则文件" : "添加公开规则引用";
    const dialog = await screen.findByRole("dialog", { name: title });
    expect(
      within(dialog).getByRole("textbox", {
        name: kind === "file" ? "导入资源名称" : "资源名称",
      }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(action));
  },
);
it.each([false, true])(
  "offers one contextual line creation action with transfer path %s",
  async (hasPath) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("/server-deployments") && hasPath
                ? [
                    {
                      id: "path",
                      name: "Office path",
                      status: "draft",
                      ir: { id: "path", programs: [] },
                    },
                  ]
                : [],
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    mount(<PublishedRoutesPage />);
    await screen.findByText("暂无线路");
    const user = userEvent.setup();
    const action = screen.getByRole(hasPath ? "button" : "link", {
      name: hasPath ? "配置公开线路" : "创建转发路径",
    });
    await user.tab();
    expect(document.activeElement).toBe(action);
    if (!hasPath) {
      expect(action.getAttribute("href")).toBe("#routes");
      expect(screen.getByText("需先建立服务器转发路径。")).toBeTruthy();
    } else {
      await user.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "配置公开线路" });
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "配置公开线路" }),
        ).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(action));
    }
  },
);

it("keeps resource creation in the populated list and after a read failure", async () => {
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            failed
              ? { detail: "Resources unavailable" }
              : [
                  {
                    id: "rules",
                    name: "Office rules",
                    format: "mihomo-yaml",
                    location: "remote",
                    updatePolicy: "pinned",
                  },
                ],
          ),
          {
            status: failed ? 503 : 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ),
  );
  mount(<ResourcesPage />);
  await screen.findByRole("button", { name: "Office rules" });
  expect(screen.getByRole("button", { name: "导入规则文件" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加公开引用" })).toBeTruthy();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
  cleanup();
  failed = true;
  mount(<ResourcesPage />);
  await screen.findByText("暂时无法加载");
  expect(screen.getByRole("button", { name: "导入规则文件" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "添加公开引用" })).toBeTruthy();
  expect(screen.queryByText("暂无规则资源")).toBeNull();
});

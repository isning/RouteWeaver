// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const removalError of [false, true]) {
  it(`supersedes a failed route check without claiming pending success; unrelated removal error: ${removalError}`, async (test) => {
    const owner = ownedClickScenario(test);
    let attempts = 0;
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.method === "DELETE")
          return json({ error: "此链路仍被服务方案引用" }, 409);
        if (String(url) === "/api/routes/route/validate") {
          attempts++;
          if (attempts === 1) return json({ error: "检查服务暂时不可用" }, 503);
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return json(
          String(url) === "/api/state"
            ? {
                nodes: [],
                users: [],
                routes: [
                  {
                    id: "route",
                    name: "测试链路",
                    engine: "xray",
                    hops: [],
                    userIds: [],
                  },
                ],
                capabilities: [],
                revisions: [],
              }
            : [],
        );
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
          <AdminPage page="legacy-routes" />
        </UIProviders>
      </QueryClientProvider>,
    );
    if (removalError) {
      await owner.click(() =>
        screen.findByRole("button", { name: "更多操作 测试链路" }),
      );
      await owner.click(() =>
        screen.getByRole("menuitem", { name: "删除链路配置 测试链路" }),
      );
      const removal = await screen.findByRole("alertdialog");
      await owner.click(() =>
        within(removal).getByRole("button", { name: "删除" }),
      );
      await within(removal).findByText("此链路仍被服务方案引用");
      await owner.click(() =>
        within(removal).getByRole("button", { name: "保留" }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByText("此链路仍被服务方案引用")).toBeTruthy();
    }
    await owner.click(() =>
      screen.findByRole("button", { name: "校验 测试链路" }),
    );
    await screen.findByText("检查服务暂时不可用");
    await owner.click(() =>
      screen.getByRole("button", { name: "校验 测试链路" }),
    );
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() =>
      expect(screen.queryByText("检查服务暂时不可用")).toBeNull(),
    );
    expect(screen.queryByText("配置结构校验完成")).toBeNull();
    if (removalError)
      expect(screen.getByText("此链路仍被服务方案引用")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "校验 测试链路" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    finish(json({ valid: true, diagnostics: [], artifacts: [] }));
    const dialog = await screen.findByRole("dialog", {
      name: "测试链路的配置检查",
    });
    expect(within(dialog).getByText("配置结构校验完成")).toBeTruthy();
    if (removalError)
      expect(screen.getByText("此链路仍被服务方案引用")).toBeTruthy();
    expect(screen.queryByText("检查服务暂时不可用")).toBeNull();
  });
}

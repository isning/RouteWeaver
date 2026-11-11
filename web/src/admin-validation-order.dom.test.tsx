// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
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

for (const scenario of [
  {
    name: "preserves the newer result when the older check finishes last",
    olderFirst: false,
    dismiss: false,
    olderFails: false,
    currentFails: false,
  },
  {
    name: "keeps the newer check pending without opening the older result",
    olderFirst: true,
    dismiss: false,
    olderFails: false,
    currentFails: false,
  },
  {
    name: "does not reopen a dismissed newer result for an older completion",
    olderFirst: false,
    dismiss: true,
    olderFails: false,
    currentFails: false,
  },
  {
    name: "does not replace the newer result with an older request failure",
    olderFirst: false,
    dismiss: false,
    olderFails: true,
    currentFails: false,
  },
  {
    name: "preserves the latest request error when an older check succeeds",
    olderFirst: false,
    dismiss: false,
    olderFails: false,
    currentFails: true,
  },
]) {
  it(scenario.name, async (test) => {
    const owner = ownedClickScenario(test);
    const finish = new Map<string, (response: Response) => void>();
    let stateReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = String(url);
        if (path.endsWith("/validate")) {
          return new Promise<Response>((resolve) => {
            finish.set(path, resolve);
          });
        }
        if (path === "/api/state") {
          stateReads++;
          return json({
            nodes: [],
            users: [],
            capabilities: [],
            revisions: [],
            routes: [
              {
                id: "a",
                name: "先前链路",
                engine: "xray",
                hops: [],
                userIds: [],
              },
              {
                id: "b",
                name: "当前链路",
                engine: "xray",
                hops: [],
                userIds: [],
              },
            ],
          });
        }
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
          <AdminPage page="legacy-routes" />
        </UIProviders>
      </QueryClientProvider>,
    );

    await owner.click(() =>
      screen.findByRole("button", { name: "校验 先前链路" }),
    );
    await waitFor(() =>
      expect(finish.has("/api/routes/a/validate")).toBe(true),
    );
    await owner.click(() =>
      screen.getByRole("button", { name: "校验 当前链路" }),
    );
    await waitFor(() =>
      expect(finish.has("/api/routes/b/validate")).toBe(true),
    );
    const completeOlder = async () => {
      const reads = stateReads;
      await act(async () => {
        finish.get("/api/routes/a/validate")!(
          scenario.olderFails
            ? json({ error: "先前请求暂时失败" }, 503)
            : json({ valid: true, diagnostics: [], artifacts: [] }),
        );
      });
      if (!scenario.olderFails) {
        // Observe the older completion's HTTP refresh, including when its sheet is suppressed.
        await waitFor(() => expect(stateReads).toBeGreaterThan(reads));
      }
    };
    if (scenario.olderFirst) {
      await completeOlder();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "校验 当前链路" })
          .getAttribute("aria-busy"),
      ).toBe("true");
      expect(screen.queryByText("配置结构校验完成")).toBeNull();
    }
    await act(async () => {
      finish.get("/api/routes/b/validate")!(
        scenario.currentFails
          ? json({ error: "当前检查服务暂时不可用" }, 503)
          : json({
              valid: false,
              diagnostics: ["当前链路需要补充端点"],
              artifacts: [],
            }),
      );
    });
    if (scenario.currentFails) {
      await screen.findByText("当前检查服务暂时不可用");
      await completeOlder();
      expect(screen.getByText("当前检查服务暂时不可用")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "校验 当前链路" })
          .getAttribute("aria-busy"),
      ).not.toBe("true");
      return;
    }
    const current = await screen.findByRole("dialog", {
      name: "当前链路的配置检查",
    });
    expect(
      within(current).getAllByText("当前链路需要补充端点").length,
    ).toBeGreaterThan(0);
    if (scenario.dismiss) {
      await owner.click(() =>
        within(current).getByRole("button", { name: "关闭" }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    if (!scenario.olderFirst) await completeOlder();
    if (scenario.dismiss) {
      expect(screen.queryByRole("dialog")).toBeNull();
    } else {
      const stillCurrent = screen.getByRole("dialog");
      expect(stillCurrent.textContent).toContain("当前链路的配置检查");
      expect(
        within(stillCurrent).getAllByText("当前链路需要补充端点").length,
      ).toBeGreaterThan(0);
      expect(within(stillCurrent).queryByText("配置结构校验完成")).toBeNull();
    }
    expect(screen.queryByText("先前请求暂时失败")).toBeNull();
  });
}

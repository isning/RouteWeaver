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
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";

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

function openRouteChecks(names = ["测试链路"]) {
  const pending: { path: string; finish: (response: Response) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (
        init?.method === "POST" &&
        /^\/api\/routes\/route-\d+\/validate$/.test(path)
      )
        return new Promise<Response>((finish) =>
          pending.push({ path, finish }),
        );
      if (path === "/api/state")
        return json({
          nodes: [],
          users: [],
          capabilities: [],
          revisions: [],
          routes: names.map((name, index) => ({
            id: `route-${index}`,
            name,
            engine: "xray",
            hops: [],
            userIds: [],
          })),
        });
      if (
        ["/api/services", "/api/settings", "/api/published-routes"].includes(
          path,
        )
      )
        return json([]);
      throw new Error(`Unexpected HTTP request ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="legacy-routes" />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const tabTo = async (target: HTMLElement) => {
    for (let step = 0; step < 15 && document.activeElement !== target; step++)
      await user.tab();
    expect(document.activeElement).toBe(target);
  };
  return { user, pending, tabTo };
}

it.each(["clipped", "visible", "search"] as const)(
  "reveals only an owned clipped retry after failure (%s)",
  async (state) => {
    const { user, pending, tabTo } = openRouteChecks();
    const check = await screen.findByRole("button", { name: "校验 测试链路" });
    await tabTo(check);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pending).toHaveLength(1));
    // Browser layout is the system boundary: jsdom cannot paint/scroll. These
    // values reproduce the original 390x560 CI failure, not native proof.
    vi.stubGlobal("innerHeight", 560);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(check, "getBoundingClientRect").mockReturnValue({
      x: 265, y: state === "visible" ? 400 : 528.5,
      left: 265, right: 309, width: 44, height: 44,
      top: state === "visible" ? 400 : 528.5,
      bottom: state === "visible" ? 444 : 572.5,
      toJSON: () => ({}),
    });
    const reveal = vi.fn();
    check.scrollIntoView = reveal;
    const search = screen.getByRole("textbox", { name: "搜索链路配置" });
    if (state === "search") await user.click(search);
    await act(async () =>
      pending[0].finish(json({ error: "检查服务暂时不可用" }, 503)),
    );
    await screen.findByText("检查服务暂时不可用");
    expect(document.activeElement).toBe(state === "search" ? search : check);
    if (state === "clipped")
      expect(reveal).toHaveBeenCalledWith({
        block: "nearest", inline: "nearest", behavior: "instant",
      });
    else expect(reveal).not.toHaveBeenCalled();
  },
);

it("keeps a pending route check keyboard-reachable and blocks duplicate activation through repeated failure and retry", async () => {
  const { user, pending, tabTo } = openRouteChecks();
  const check = await screen.findByRole("button", { name: "校验 测试链路" });
  await tabTo(check);
  for (let cycle = 0; cycle < 2; cycle++) {
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pending).toHaveLength(cycle * 2 + 1));
    await waitFor(() => expect(check.getAttribute("aria-busy")).toBe("true"));
    expect(check.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter} ");
    expect(pending).toHaveLength(cycle * 2 + 1);
    // jsdom does not blur newly disabled buttons. Ordinary Tab out and back
    // instead verifies the public focusability contract; CI owns native retention.
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "更多操作 测试链路" }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(check);
    await act(async () =>
      pending[cycle * 2].finish(json({ error: "检查服务暂时不可用" }, 503)),
    );
    await screen.findByText("检查服务暂时不可用");
    expect(document.activeElement).toBe(check);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pending).toHaveLength(cycle * 2 + 2));
    await waitFor(() =>
      expect(screen.queryByText("检查服务暂时不可用")).toBeNull(),
    );
    expect(check.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Enter} ");
    expect(pending).toHaveLength(cycle * 2 + 2);
    await act(async () =>
      pending[cycle * 2 + 1].finish(
        json({ valid: true, diagnostics: [], artifacts: [] }),
      ),
    );
    const result = await screen.findByRole("dialog", {
      name: "测试链路的配置检查",
    });
    expect(within(result).getByText("配置结构校验完成")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(check));
  }
  expect(pending.map((request) => request.path)).toEqual(
    Array(4).fill("/api/routes/route-0/validate"),
  );
});

it("does not reclaim focus when the user moves to search before a failed check settles", async () => {
  const { user, pending, tabTo } = openRouteChecks();
  const check = await screen.findByRole("button", { name: "校验 测试链路" });
  await tabTo(check);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(pending).toHaveLength(1));
  const search = screen.getByRole("textbox", { name: "搜索链路配置" });
  await user.click(search);
  expect(document.activeElement).toBe(search);
  await act(async () =>
    pending[0].finish(json({ error: "检查服务暂时不可用" }, 503)),
  );
  await screen.findByText("检查服务暂时不可用");
  expect(document.activeElement).toBe(search);
  expect(check.getAttribute("aria-busy")).not.toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("leaves keyboard focus with the newer route check when the older request fails", async () => {
  const { user, pending, tabTo } = openRouteChecks(["先前链路", "新的链路"]);
  const older = await screen.findByRole("button", { name: "校验 先前链路" });
  const newer = screen.getByRole("button", { name: "校验 新的链路" });
  await tabTo(older);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(pending).toHaveLength(1));
  await tabTo(newer);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(pending).toHaveLength(2));
  await waitFor(() => expect(newer.getAttribute("aria-busy")).toBe("true"));
  await act(async () =>
    pending[0].finish(json({ error: "先前检查失败" }, 503)),
  );
  expect(document.activeElement).toBe(newer);
  expect(newer.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("先前检查失败")).toBeNull();
  await user.keyboard("{Enter} ");
  expect(pending).toHaveLength(2);
  await act(async () =>
    pending[1].finish(json({ error: "新的检查失败" }, 503)),
  );
  await screen.findByText("新的检查失败");
  expect(document.activeElement).toBe(newer);
  expect(screen.queryByText("先前检查失败")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(pending.map((request) => request.path)).toEqual([
    "/api/routes/route-0/validate",
    "/api/routes/route-1/validate",
  ]);
});

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

async function beginConcurrentChecks() {
  const session = openRouteChecks(["链路 A", "链路 B"]);
  const a = await screen.findByRole("button", { name: "校验 链路 A" });
  const b = screen.getByRole("button", { name: "校验 链路 B" });
  await session.tabTo(a);
  await session.user.keyboard("{Enter}");
  await waitFor(() => expect(session.pending).toHaveLength(1));
  await waitFor(() => expect(a.getAttribute("aria-busy")).toBe("true"));
  await session.tabTo(b);
  await session.user.keyboard("{Enter}");
  await waitFor(() => expect(session.pending).toHaveLength(2));
  await waitFor(() => expect(b.getAttribute("aria-busy")).toBe("true"));
  // Return through the ordinary keyboard tab order; no focus or handler calls.
  for (let step = 0; step < 15 && document.activeElement !== a; step++)
    await session.user.tab({ shift: true });
  expect(document.activeElement).toBe(a);
  return { ...session, a, b };
}

it("blocks another activation of A while both A and B checks are outstanding", async () => {
  const { user, pending, a } = await beginConcurrentChecks();
  await user.keyboard("{Enter}");
  expect(pending.map((request) => request.path)).toEqual([
    "/api/routes/route-0/validate",
    "/api/routes/route-1/validate",
  ]);
  expect(a.getAttribute("aria-busy")).toBe("true");
});

for (const latestFails of [false, true]) {
  it(`keeps latest A ${latestFails ? "error" : "result"} owned by its retry after A settles and B finishes last`, async () => {
    const { user, pending, a, b, tabTo } = await beginConcurrentChecks();
    expect(a.getAttribute("aria-busy")).toBe("true");
    expect(a.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    expect(pending).toHaveLength(2);
    await act(async () =>
      pending[0].finish(json({ error: "原始 A 检查失败" }, 503)),
    );
    await waitFor(() => expect(a.getAttribute("aria-busy")).not.toBe("true"));
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("原始 A 检查失败")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(pending.map((request) => request.path)).toEqual([
        "/api/routes/route-0/validate",
        "/api/routes/route-1/validate",
        "/api/routes/route-0/validate",
      ]),
    );
    await waitFor(() => expect(a.getAttribute("aria-busy")).toBe("true"));
    expect(b.getAttribute("aria-busy")).toBe("true");
    await act(async () =>
      pending[2].finish(
        latestFails
          ? json({ error: "最新 A 检查失败" }, 503)
          : json({
              valid: false,
              diagnostics: ["最新 A 缺少端点"],
              artifacts: [],
            }),
      ),
    );
    if (latestFails) await screen.findByText("最新 A 检查失败");
    else await screen.findByRole("dialog", { name: "链路 A的配置检查" });
    await act(async () =>
      pending[1].finish(json({ error: "较早 B 检查失败" }, 503)),
    );

    await waitFor(() => expect(b.getAttribute("aria-busy")).not.toBe("true"));
    expect(b.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.queryByText("较早 B 检查失败")).toBeNull();
    if (latestFails) {
      expect(screen.getByText("最新 A 检查失败")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    } else {
      const result = screen.getByRole("dialog", { name: "链路 A的配置检查" });
      expect(
        within(result).getAllByText("最新 A 缺少端点").length,
      ).toBeGreaterThan(0);
    }
    // The latest A presentation has been verified. Start a new user task only
    // after closing its sheet, so retrying B does not mask ownership evidence.
    if (!latestFails) {
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(a));
    }
    await tabTo(b);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(pending[3].path).toBe("/api/routes/route-1/validate");
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    await act(async () =>
      pending[3].finish(json({ error: "重试 B 检查失败" }, 503)),
    );
    await screen.findByText("重试 B 检查失败");
    expect(b.getAttribute("aria-busy")).not.toBe("true");
    expect(b.getAttribute("aria-disabled")).not.toBe("true");
  });
}

it("releases completed A without moving newer B focus or ending B work, then permits another settled A check", async () => {
  const { user, pending, a, b, tabTo } = await beginConcurrentChecks();
  await tabTo(b);
  await act(async () =>
    pending[0].finish(json({ valid: true, diagnostics: [], artifacts: [] })),
  );
  await waitFor(() => expect(a.getAttribute("aria-busy")).not.toBe("true"));
  expect(document.activeElement).toBe(b);
  expect(b.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{Enter}");
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].finish(json({ error: "B 检查失败" }, 503)));
  await screen.findByText("B 检查失败");
  expect(document.activeElement).toBe(b);
  for (let step = 0; step < 15 && document.activeElement !== a; step++)
    await user.tab({ shift: true });
  expect(document.activeElement).toBe(a);
  for (let cycle = 0; cycle < 2; cycle++) {
    await user.keyboard("{Enter}");
    await waitFor(() => expect(pending).toHaveLength(3 + cycle));
    await user.keyboard("{Enter}");
    expect(pending).toHaveLength(3 + cycle);
    await act(async () =>
      pending[2 + cycle].finish(
        json({ valid: true, diagnostics: [], artifacts: [] }),
      ),
    );
    await screen.findByRole("dialog", { name: "链路 A的配置检查" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(a));
  }
});

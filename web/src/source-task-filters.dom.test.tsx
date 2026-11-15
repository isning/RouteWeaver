// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { SourcesPage } from "./Sources";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
it("filters saved source tasks without refreshing providers or accepting candidates", async () => {
  const sources = [
    {
      id: "candidate",
      name: "北区候选",
      enabled: true,
      refreshStatus: "review-required",
      candidate: { endpoints: [] },
    },
    {
      id: "failed",
      name: "南区失败",
      enabled: true,
      refreshStatus: "failed",
      lastErrorCode: "source_fetch_failed",
    },
    {
      id: "unknown",
      name: "未知来源",
      enabled: true,
      refreshStatus: "future",
      lastError: "old failure",
    },
    { id: "paused", name: "暂停来源", enabled: false, refreshStatus: "failed" },
    {
      id: "good",
      name: "正常来源",
      enabled: true,
      refreshStatus: "accepted",
      lastError: "stale error",
    },
  ].map((s) => ({ ...s, kind: "url", snapshot: { endpoints: [] } }));
  const fetcher = vi.fn(
    async (_url: unknown) =>
      new Response(JSON.stringify(sources), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourcesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: /^正常来源/ });
  fireEvent.click(screen.getByRole("button", { name: "有更新" }));
  expect(screen.getByRole("button", { name: /^北区候选/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^南区失败/ })).toBeNull();
  expect(screen.getByRole("button", { name: "查看变化" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "更新失败" }));
  expect(screen.getByRole("button", { name: /^南区失败/ })).toBeTruthy();
  for (const name of ["北区候选", "未知来源", "暂停来源", "正常来源"])
    expect(
      screen.queryByRole("button", { name: new RegExp("^" + name) }),
    ).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索来源" }), {
    target: { value: "北区" },
  });
  expect(screen.getByText("没有符合条件的来源")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  await screen.findByRole("button", { name: /^正常来源/ });
  expect(
    (screen.getByRole("textbox", { name: "搜索来源" }) as HTMLInputElement)
      .value,
  ).toBe("");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(
    fetcher.mock.calls.every((call) => String(call[0]).endsWith("/me/sources")),
  ).toBe(true);
});

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
import {
  SubscriptionFetchAlerts,
  type FetchHistory,
} from "./SubscriptionFetchAlerts";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
const history: FetchHistory = { items: [], limit: 100, windowDays: 30 };
function mount(value = history) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  const refresh = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SubscriptionFetchAlerts
        history={value}
        names={{ phone: "手机订阅" }}
        refresh={refresh}
      />
    </QueryClientProvider>,
  );
  return refresh;
}
it("does not collect by default and explains consent before enabling", async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ ...history, trackSourceIps: true })),
  );
  vi.stubGlobal("fetch", fetch);
  const refresh = mount();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("未开启，查看设置"));
  expect(screen.getByText(/已有备份不会同步清除/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "开启并记录来源 IP" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0][0]).toBe("/api/me/subscription-fetches/tracking");
  expect(fetch.mock.calls[0][1].body).toBe('{"enabled":true}');
});
it("shows real bounded alerts and can clear addresses", async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(history)),
  );
  vi.stubGlobal("fetch", fetch);
  const refresh = mount({
    ...history,
    trackSourceIps: true,
    items: [
      {
        outputId: "phone",
        at: "2026-11-14T10:00:00Z",
        delivery: "feed",
        sourceIp: "192.0.2.4",
        newSource: true,
      },
    ],
  });
  expect(screen.getByText("手机订阅")).toBeTruthy();
  expect(screen.getByText(/新拉取地址/)).toBeTruthy();
  expect(screen.getByText("192.0.2.4")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭并清除地址" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetch.mock.calls[0][1].body).toBe('{"enabled":false}');
});
it("keeps the existing state when saving fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const refresh = mount();
  fireEvent.click(screen.getByText("未开启，查看设置"));
  fireEvent.click(screen.getByRole("button", { name: "开启并记录来源 IP" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "尚未确认保存结果",
  );
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "刷新设置" }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

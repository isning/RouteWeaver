// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionFetchAlerts } from "./SubscriptionFetchAlerts";
import { UIProviders } from "./ui-patterns/providers";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps tracking controls collapsed and can disable without an opt-in prompt", async () => {
  const history = {items: [], trackSourceIps: true, limit:100, windowDays:30};
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({...history,trackSourceIps:false}), {status:200,headers:{"Content-Type":"application/json"}}));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({defaultOptions:{mutations:{retry:false}}});
  const refresh = vi.fn();
  render(<QueryClientProvider client={client}><UIProviders><SubscriptionFetchAlerts history={history} names={{}} refresh={refresh}/></UIProviders></QueryClientProvider>);
  expect(screen.queryByText("新 IP 拉取提醒")).toBeNull();
  expect(screen.queryByText("未开启，查看设置")).toBeNull();
  expect(screen.getByText("拉取记录设置").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("关闭并清除地址"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({enabled:false}));
  client.clear();
});

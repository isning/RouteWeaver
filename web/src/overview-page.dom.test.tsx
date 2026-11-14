// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import Workspace from "./App";
import { OverviewPage } from "./OverviewPage";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
function mount(fail = false, shell = false, namesFail = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me"))
        return json({
          user: { id: "u", name: "Test", role: "member" },
          csrfToken: "synthetic",
        });
      if (
        namesFail &&
        (url.endsWith("/me/overview") || url.endsWith("/me/outputs"))
      )
        return json({ error: "Names unavailable" }, 503);
      if (url.endsWith("/me/overview"))
        return json({
          status: "active",
          quotaBytes: 1024,
          user: { id: "u" },
          usage: { rawBytes: 256, weightedBytes: 512 },
          routes: [{ id: "r", name: "东京" }],
          cycle: { timezone: "UTC+8" },
        });
      if (url.endsWith("/me/profiles"))
        return json([
          { id: "draft", name: "旅行配置" },
          { id: "ready", name: "工作配置" },
        ]);
      if (url.endsWith("/me/outputs"))
        return json([
          {
            id: "output",
            name: "工作订阅",
            profileId: "ready",
            status: "published",
            target: { adapterId: "mihomo" },
            mode: "nodes-only",
          },
        ]);
      if (url.endsWith("/me/output-usage"))
        return json({ error: "usage unavailable" }, 503);
      if (url.endsWith("/me/outputs/independent")) return json({ items: [] });
      if (url.endsWith("/me/subscription-fetches"))
        return json({
          items: [
            {
              outputId: "output",
              at: "2026-11-14T07:00:00Z",
              delivery: "feed",
            },
          ],
          limit: 100,
          windowDays: 30,
        });
      if (url.endsWith("/me/insights"))
        return fail
          ? json({ error: "temporarily unavailable" }, 503)
          : json({
              asOf: "2026-11-14T07:00:00Z",
              timezone: "UTC+8",
              daily: [
                { date: "2026-11-14", rawBytes: 256, weightedBytes: 512 },
              ],
              routes: [{ routeId: "r", rawBytes: 256, weightedBytes: 512 }],
              admission: {
                available: true,
                asOf: "2026-11-14T07:00:00Z",
                maxLeaseSeconds: 30,
                onlineIps: ["192.0.2.7"],
                activeStreams: 2,
              },
              limits: {
                onlineIpLimit: 4,
                connectionLimit: 10,
                entryRateBps: 100000000,
              },
            });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{shell ? <Workspace /> : <OverviewPage />}</UIProviders>
    </QueryClientProvider>,
  );
}
it("shows current-account overview and navigates to an unpublished configuration without claiming per-subscription traffic", async () => {
  mount();
  expect(await screen.findByText("192.0.2.7")).toBeTruthy();
  expect(screen.getByText("100 Mbps")).toBeTruthy();
  expect(screen.getByText("东京")).toBeTruthy();
  expect(
    screen.getByRole("table", { name: "线路用量" }).getAttribute("data-slot"),
  ).toBe("table");
  expect(
    screen
      .getByRole("table", { name: "订阅用量与最近拉取" })
      .getAttribute("data-slot"),
  ).toBe("table");
  expect(screen.getByRole("columnheader", { name: "实际流量" })).toBeTruthy();
  expect(screen.getByText("旅行配置 尚未发布")).toBeTruthy();
  expect(await screen.findByText("工作订阅")).toBeTruthy();
  expect(screen.queryByText("工作配置")).toBeNull();
  expect(
    within(screen.getByRole("list", { name: "每日额度消耗" })).getByText(
      /2026-11-14：额度消耗/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("本周期剩余额度").closest('[data-slot="card"]')).toBe(
    screen.getByText("近 14 天每日用量").closest('[data-slot="card"]'),
  );
  expect(screen.getByTestId("overview-primary-grid").children).toHaveLength(2);
  expect(screen.getByTestId("overview-secondary-grid").children).toHaveLength(
    2,
  );
  fireEvent.click(screen.getByRole("button", { name: "去发布" }));
  expect(location.hash).toBe("#subscriptions?profile=draft");
  fireEvent.click(screen.getByRole("button", { name: "管理全部订阅" }));
  expect(location.hash).toBe("#subscriptions");
  expect(screen.getByText("用量暂不可用，以下不按用量排序。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试订阅用量" })).toBeTruthy();
});
it("does not invent zero online IPs or daily usage when the bounded query fails", async () => {
  mount(true);
  await screen.findAllByText(/temporarily unavailable/);
  expect(screen.queryByText("暂无活跃 IP")).toBeNull();
  expect(screen.queryByRole("list", { name: "每日额度消耗" })).toBeNull();
  expect(screen.getByText("本周期剩余额度")).toBeTruthy();
});

it("keeps unavailable admission distinct from an empty online list", async () => {
  mount();
  await screen.findByText("192.0.2.7");
  const client = clients.at(-1)!;
  const current = client.getQueryData<{ admission: object }>([
    "personal-insights",
  ]);
  client.setQueryData(["personal-insights"], {
    ...current,
    admission: { available: false },
  });
  expect(
    await screen.findByText("在线情况暂不可用，请稍后刷新。"),
  ).toBeTruthy();
  expect(screen.queryByText("暂无活跃 IP")).toBeNull();
});

it("separates the overview landing route from subscription management", async () => {
  history.replaceState(null, "", "#overview");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((media: string) => ({
      media,
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mount(false, true);
  expect(
    await screen.findByRole("heading", { name: "概览", level: 1 }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "管理全部订阅" }));
  expect(
    await screen.findByRole("heading", { name: "我的订阅", level: 1 }),
  ).toBeTruthy();
  expect(screen.queryByText("本周期剩余额度")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "RouteWeaver 首页" }));
  expect(
    await screen.findByRole("heading", { name: "概览", level: 1 }),
  ).toBeTruthy();
});

it("does not label unknown names as deleted subscriptions or historical routes", async () => {
  mount(false, false, true);
  expect(
    (await screen.findAllByText("Names unavailable")).length,
  ).toBeGreaterThan(0);
  expect(await screen.findByText("线路名称暂不可用")).toBeTruthy();
  expect(screen.queryByText("已删除的订阅")).toBeNull();
  expect(screen.queryByText("历史线路")).toBeNull();
});

it("renders only the database's reported IP metadata, not an inferred device location", async () => {
  mount();
  await screen.findByText("192.0.2.7");
  expect(screen.getByText("IP 归属资料暂不可用")).toBeTruthy();
  const client = clients.at(-1)!;
  client.setQueryData(["personal-insights"], (current: object) => ({
    ...current,
    ipMetadata: {
      available: true,
      truncated: false,
      sources: [
        {
          kind: "asn",
          databaseType: "Example ASN",
          builtAt: "2026-11-14T00:00:00Z",
        },
      ],
      items: [
        {
          ip: "192.0.2.7",
          status: "available",
          countryCode: "DE",
          asn: 64500,
          organization: "Example Network",
        },
      ],
    },
  }));
  expect(
    await screen.findByText("德国 (DE) · Example Network · AS64500"),
  ).toBeTruthy();
  expect(screen.getByText(/不代表设备的实际位置或运营商/)).toBeTruthy();
  expect(screen.queryByText("IP 归属资料暂不可用")).toBeNull();
});

it("distinguishes no database match, non-public IP and unavailable metadata", async () => {
  mount();
  await screen.findByText("192.0.2.7");
  const client = clients.at(-1)!;
  for (const [status, label] of [
    ["not-found", "归属未知"],
    ["non-public", "非公网地址，无公网归属资料"],
    ["unavailable", "归属资料暂不可用"],
  ]) {
    client.setQueryData(["personal-insights"], (current: object) => ({
      ...current,
      ipMetadata: {
        available: true,
        sources: [],
        truncated: false,
        items: [{ ip: "192.0.2.7", status }],
      },
    }));
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByText(/国家\/地区/)).toBeNull();
  }
});

it("shows zero only for independent subscriptions and keeps shared traffic unassigned", async () => {
  mount();
  await screen.findByText("工作订阅");
  const client = clients.at(-1)!;
  const existing = client.getQueryData<object[]>(["outputs"])![0];
  client.setQueryData(
    ["outputs"],
    [
      existing,
      {
        ...existing,
        id: "independent",
        name: "独立订阅",
        trafficAttribution: "independent-managed",
      },
    ],
  );
  client.setQueryData(["output-usage"], {
    period: "current-cycle",
    complete: true,
    outputs: [],
    unattributedRawBytes: 1024,
    unattributedWeightedBytes: 1024,
  });
  const independent = await screen.findByText("独立订阅");
  expect(within(independent.closest("tr")!).getByText("0 B")).toBeTruthy();
  expect(
    within(screen.getByText("工作订阅").closest("tr")!).getByText("未单独计量"),
  ).toBeTruthy();
  expect(screen.getByText(/共用凭据流量，无法分配/)).toBeTruthy();
});

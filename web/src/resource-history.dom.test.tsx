// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResourceHistory, type ResourceHistoryView } from "./ResourceHistory";
const end = new Date().toISOString(),
  start = new Date(Date.now() - 24 * 3600000).toISOString();
const fixture = (): ResourceHistoryView => ({
  nodeId: "host",
  available: true,
  intervalSeconds: 300,
  windowStart: start,
  windowEnd: end,
  points: [
    {
      observedAt: new Date(Date.now() - 600000).toISOString(),
      cpuPercent: 0,
      memoryUsedPercent: 50,
      receiveBytesPerSecond: 0,
      transmitBytesPerSecond: null,
      breakBefore: true,
    },
    {
      observedAt: new Date(Date.now() - 300000).toISOString(),
      cpuPercent: 25,
      memoryUsedPercent: 60,
      receiveBytesPerSecond: 1024,
      transmitBytesPerSecond: null,
      breakBefore: true,
    },
  ],
});
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ResourceHistory nodeId="host" />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("plots actual zeros but does not join restart gaps or turn unknown rates into zeros", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(fixture())),
  );
  mount();
  const chart = await screen.findByRole("img", {
    name: "计费网卡流量，最近24小时实际采样趋势",
  });
  expect(chart.querySelectorAll("circle")).toHaveLength(2);
  expect(chart.querySelectorAll("text")).toHaveLength(0); // axis labels stay HTML-sized on narrow screens
  expect(
    chart.parentElement?.parentElement?.querySelector("span")?.className,
  ).toContain("whitespace-nowrap");
  expect(chart.querySelectorAll('line[stroke="currentColor"]')).toHaveLength(0);
  expect(
    screen
      .getByRole("slider", { name: "计费网卡流量采样时间" })
      .getAttribute("aria-valuetext"),
  ).toContain("0 B/s");
  expect(chart.querySelector("title")).toBeNull();
});
it("distinguishes capacity, empty history and errors while retaining prior real samples", async () => {
  let value = fixture();
  value.points = [];
  value.available = false;
  const fetcher = vi.fn(async () => response(value));
  vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByText("历史存储容量已满，当前资源数据仍可查看。");
  value = { ...value, available: true };
  await userEvent.click(screen.getByRole("button", { name: "刷新资源趋势" }));
  await screen.findByText(/最近 24小时没有历史数据/);
  value = fixture();
  await userEvent.click(screen.getByRole("button", { name: "刷新资源趋势" }));
  await screen.findByRole("img", { name: /CPU 与内存/ });
  fetcher.mockImplementation(async () => response({}, 503));
  await userEvent.click(screen.getByRole("button", { name: "刷新资源趋势" }));
  await screen.findByText("趋势刷新失败，保留上次读取的数据。");
  expect(screen.getByRole("img", { name: /CPU 与内存/ })).toBeTruthy();
});
it("never displays another node's history", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ ...fixture(), nodeId: "other" })),
  );
  mount();
  await screen.findByText("趋势数据尚未确定，请重试。");
  expect(screen.queryByRole("img")).toBeNull();
});
it("requests hourly seven-day history without relabeling cached daily samples", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return response(
      url.includes("window=7d")
        ? {
            ...fixture(),
            intervalSeconds: 3600,
            windowStart: new Date(Date.now() - 7 * 24 * 3600000).toISOString(),
          }
        : fixture(),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  await screen.findByRole("img", { name: /计费网卡流量，最近24小时/ });
  await userEvent.click(screen.getByRole("tab", { name: "7 天" }));
  await screen.findByRole("img", { name: /计费网卡流量，最近7天/ });
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("window=7d")),
  ).toBe(true);
  expect(screen.queryByRole("img", { name: /最近24小时/ })).toBeNull();
});
it("lets keyboard and touch controls inspect exact samples without replacing missing rates with zero", async () => {
  const data = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(data)),
  );
  mount();
  const slider = await screen.findByRole("slider", {
    name: "计费网卡流量采样时间",
  });
  expect(slider.getAttribute("aria-valuetext")).toContain(
    "接收 0 B/s (0 B/s)，发送 无数据",
  );
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(slider, { target: { value: "1" } });
  expect(slider.getAttribute("aria-valuetext")).toContain(
    "接收 1 KiB/s (1,024 B/s)，发送 无数据",
  );
  expect(screen.getByText("1 KiB/s (1,024 B/s)")).toBeTruthy();
  expect(screen.getByText("无数据")).toBeTruthy();
  fireEvent.change(slider, { target: { value: "0" } });
  expect(screen.getByText("0 B/s (0 B/s)")).toBeTruthy();
});
it("opens a real sample table without inventing values and can collapse it", async () => {
  const data = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(data)),
  );
  mount();
  await screen.findByRole("img", { name: /CPU 与内存/ });
  expect(screen.queryByRole("table", { name: "资源采样数据" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "查看采样数据（2 条）" }),
  );
  const table = screen.getByRole("table", { name: "资源采样数据" });
  const { within } = await import("@testing-library/react");
  const rows = within(table).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(
    within(rows[1])
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual([expect.any(String), "0%", "50%", "0 B/s", "无数据"]);
  expect(
    within(rows[2])
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual([expect.any(String), "25%", "60%", "1,024 B/s", "无数据"]);
  expect(table.querySelector("time")?.dateTime).toBe(data.points[0].observedAt);
  await userEvent.click(
    screen.getByRole("button", { name: "收起采样数据（2 条）" }),
  );
  expect(screen.queryByRole("table", { name: "资源采样数据" })).toBeNull();
});
it("shows a floating readout only while inspecting and dismisses it with Escape", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(fixture())),
  );
  mount();
  const slider = await screen.findByRole("slider", {
    name: "计费网卡流量采样时间",
  });
  expect(screen.queryByRole("tooltip")).toBeNull();
  const { fireEvent, within } = await import("@testing-library/react");
  fireEvent.focus(slider);
  const tip = screen.getByRole("tooltip");
  expect(slider.getAttribute("aria-describedby")).toBe(tip.id);
  expect(within(tip).getByText("接收")).toBeTruthy();
  expect(within(tip).getByText("无数据")).toBeTruthy();
  fireEvent.change(slider, { target: { value: "1" } });
  expect(within(tip).getByText("1 KiB/s (1,024 B/s)")).toBeTruthy();
  fireEvent.keyDown(slider, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("touch selects the nearest real sample and an outside touch dismisses without fetching", async () => {
  const data = fixture();
  const fetcher = vi.fn(async () => response(data));
  vi.stubGlobal("fetch", fetcher);
  mount();
  const chart = await screen.findByRole("img", { name: /计费网卡流量/ });
  vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 500,
    height: 160,
    right: 500,
    bottom: 160,
    x: 0,
    y: 0,
    toJSON() {},
  });
  const { fireEvent, within } = await import("@testing-library/react");
  const touch = new MouseEvent("pointerdown", {
    bubbles: true,
    clientX: 494,
    clientY: 60,
  });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(chart, touch);
  expect(
    within(screen.getByRole("tooltip")).getByText("1 KiB/s (1,024 B/s)"),
  ).toBeTruthy();
  expect(chart.querySelectorAll('line[stroke="currentColor"]')).toHaveLength(0);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not carry a selected sample into a replacement history window", async () => {
  let value = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(value)),
  );
  mount();
  const slider = await screen.findByRole("slider", {
    name: "计费网卡流量采样时间",
  });
  const { fireEvent, waitFor } = await import("@testing-library/react");
  fireEvent.change(slider, { target: { value: "1" } });
  expect(screen.getByRole("tooltip")).toBeTruthy();
  value = { ...value, points: [value.points[0]] };
  await userEvent.click(screen.getByRole("button", { name: "刷新资源趋势" }));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});
it("allows keyboard inspection of an entirely missing series without drawing zeros", async () => {
  const value = fixture();
  value.points = value.points.map((p) => ({
    ...p,
    receiveBytesPerSecond: null,
    transmitBytesPerSecond: null,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(value)),
  );
  mount();
  const slider = await screen.findByRole("slider", {
    name: "计费网卡流量采样时间",
  });
  expect(screen.queryByRole("img", { name: /计费网卡流量/ })).toBeNull();
  const { fireEvent, within } = await import("@testing-library/react");
  fireEvent.focus(slider);
  expect(
    within(screen.getByRole("tooltip")).getAllByText("无数据"),
  ).toHaveLength(2);
});
it("keeps keyboard inspection visible when the mouse leaves and closes on blur", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(fixture())),
  );
  mount();
  const slider = await screen.findByRole("slider", {
    name: "CPU 与内存采样时间",
  });
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.focus(slider);
  fireEvent.pointerLeave(slider.parentElement!.parentElement!, {
    pointerType: "mouse",
  });
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.blur(slider, { relatedTarget: document.body });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("keeps a readable sample selected when the rolling history expires the inspected point", async () => {
  const { act, fireEvent, waitFor } = await import("@testing-library/react");
  const data = fixture();
  vi.stubGlobal("fetch", vi.fn(async () => response(data)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ResourceHistory nodeId="host" /></QueryClientProvider>);
  const slider = await screen.findByRole("slider", { name: "计费网卡流量采样时间" });
  fireEvent.focus(slider);
  expect(screen.getByText("0 B/s (0 B/s)")).toBeTruthy();
  await act(async () => {
    client.setQueryData(["node-resource-history", "host", "24h"], {
      ...data, points: [data.points[1]],
    });
  });
  await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toContain("接收 1 KiB/s (1,024 B/s)"));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(slider);
  fireEvent.focus(slider);
  expect(screen.getByText("1 KiB/s (1,024 B/s)")).toBeTruthy();
  client.clear();
});

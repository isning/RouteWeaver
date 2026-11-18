// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NetworkMonitor } from "./NetworkMonitor";
import { hasUnsavedChanges } from "./navigation";
const host = { id: "host", name: "Test node", address: "8.8.8.8" };
const base = () => ({
  hostId: "host",
  revision: 0,
  enabled: false,
  notify: true,
  intervalMinutes: 5,
  protocol: "tcp",
  port: 443,
  target: host.address,
  currentTarget: host.address,
  requiresReview: false,
  queued: false,
  history: [] as any[],
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeAll(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  })),
);
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <NetworkMonitor host={host} />
      </UIProviders>
    </QueryClientProvider>,
  );
  return client;
}
it("never starts traffic by opening the monitor and saves the explicit consent before a manual check", async () => {
  let state = base();
  const writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method) {
        const body = JSON.parse(String(init.body));
        writes.push({ url: String(url), body });
        state = {
          ...state,
          ...(init.method === "PUT" ? body : { queued: true }),
          revision: state.revision + 1,
        };
        return json(state, init.method === "POST" ? 202 : 200);
      }
      return json(state);
    }),
  );
  mount();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "设置监控" });
  expect(writes).toEqual([]);
  expect(screen.queryByRole("button", { name: "立即检查" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "监控设置" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "设置监控" }));
  expect(screen.getByRole("dialog", { name: "监控设置" })).toBeTruthy();
  expect(
    screen.getByText(/监控地址和检测端口会提交给 Globalping/),
  ).toBeTruthy();
  await user.type(screen.getByLabelText("监控 IP"), "1.1.1.1");
  await user.click(screen.getByRole("button", { name: "添加探针" }));
  await user.type(screen.getByLabelText("探针 1 名称"), "北京电信");
  await user.type(screen.getByLabelText("探针 1 城市"), "Beijing");
  await user.type(screen.getByLabelText("探针 1 网络 ASN"), "4134");
  expect(screen.queryByRole("button", { name: "重新读取设置" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存监控设置" }));
  await screen.findByText("监控设置已保存");
  expect(screen.getByRole("heading", { name: "北京电信" })).toBeTruthy();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({
    enabled: false,
    notify: true,
    intervalMinutes: 5,
    protocol: "tcp",
    port: 443,
    monitorIp: "1.1.1.1",
    probes: [{ id: expect.any(String), name: "北京电信", country: "CN", city: "Beijing", asn: 4134 }],
    expectedRevision: 0,
  });
  await user.click(screen.getByRole("button", { name: "立即检查" }));
  await screen.findByText("已提交检查");
  expect(writes[1].url).toBe("/api/admin/hosts/host/network-monitor/check");
  expect(writes[1].body).toEqual({ expectedRevision: 1 });
  expect(screen.getByRole("button", { name: "检测中" })).toHaveProperty(
    "disabled",
    true,
  );
});
it.each([400, 409, 500])(
  "retains editing input after a %s failure without replaying",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) =>
        init?.method
          ? json({ detail: "failed" }, status)
          : json({ ...base(), revision: 1 }),
      ),
    );
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "设置监控" }));
    const input = await screen.findByLabelText("检测端口");
    fireEvent.change(input, { target: { value: "8443" } });
    await user.click(screen.getByRole("button", { name: "保存监控设置" }));
    await screen.findByRole("alert");
    expect(input).toHaveProperty("value", "8443");
    expect(hasUnsavedChanges()).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);

  },
);
it("does not replace the focused partial input when a background observation arrives", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ ...base(), revision: 1 })),
  );
  const client = mount();
  await userEvent.click(await screen.findByRole("button", { name: "设置监控" }));
  const input = await screen.findByLabelText("检测端口");
  input.focus();
  fireEvent.change(input, { target: { value: "8e" } });
  await act(async () =>
    client.setQueryData(["network-monitor", "host"], {
      ...base(),
      revision: 2,
      history: [
        {
          at: new Date().toISOString(),
          target: host.address,
          port: 443,
          protocol: "tcp",
          results: [{ carrier: "telecom", status: "up", latencyMs: 30 }],
        },
      ],
    }),
  );
  expect(screen.getByLabelText("检测端口")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input).toHaveProperty("value", "8e");
});
it("keeps missing probes distinct from failed nodes and excludes unknown results from availability", async () => {
  const at = new Date().toISOString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        ...base(),
        revision: 1,
        history: [
          {
            at,
            target: host.address,
            port: 443,
            protocol: "tcp",
            results: [
              { carrier: "telecom", status: "unknown", code: "no-probe" },
              { carrier: "unicom", status: "down", loss: 100 },
              {
                carrier: "mobile",
                status: "up",
                latencyMs: 25,
                city: "Guangzhou",
                asn: 9808,
              },
            ],
          },
        ],
      }),
    ),
  );
  mount();
  await screen.findByRole("heading", { name: "连通性监控" });
  const results = within(
    screen.getByRole("region", { name: "连通性检测结果" }),
  );
  expect(await results.findByRole("button", { name: /中国电信.*暂无匹配的探针/ })).toBeTruthy();
  expect(results.getByLabelText("中国电信观测可用率 —")).toBeTruthy();
  expect(results.getByLabelText("中国联通观测可用率 0.0%")).toBeTruthy();
  expect(results.getByLabelText("中国移动观测可用率 100.0%")).toBeTruthy();
  expect(results.getByText("Guangzhou")).toBeTruthy();
  expect(results.getByText("未连通")).toBeTruthy();
});
it("shows an actionable retry after a failed initial read rather than invented healthy states", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      fail ? json({ detail: "read unavailable" }, 503) : json(base()),
    ),
  );
  mount();
  await screen.findByText("read unavailable");
  expect(screen.queryByText("可达")).toBeNull();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "设置监控" });
});
it("changes checking frequency without losing the draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(base())),
  );
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "设置监控" }));
  await screen.findByLabelText("定时监控");
  await user.click(screen.getByLabelText("定时监控"));
  expect(screen.getByLabelText("定时监控").getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(hasUnsavedChanges()).toBe(true);
  expect(
    within(screen.getByRole("form", { name: "连通性监控设置" })).getByLabelText(
      "检查频率",
    ),
  ).toBeTruthy();
});
it("draws latency trends with gaps and never substitutes zero latency for unknown observations", async () => {
  const now = Date.now();
  const history = [20, undefined, 40].map((ms, i) => ({
    at: new Date(now - (2 - i) * 300000).toISOString(),
    target: host.address,
    port: 443,
    protocol: "tcp",
    results: [
      {
        carrier: "telecom",
        status: ms === undefined ? "unknown" : "up",
        ...(ms === undefined ? { code: "no-probe" } : { latencyMs: ms }),
      },
    ],
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ ...base(), revision: 1, history })),
  );
  mount();
  const chart = await screen.findByRole("img", { name: /各探针延迟对比/ });
  expect(
    chart
      .querySelector('[data-series="telecom"] path')!
      .getAttribute("d")
      ?.match(/M/g),
  ).toHaveLength(2);
  expect(
    chart.querySelector('[data-series="telecom"] path')!.getAttribute("d"),
  ).not.toContain("L");
  expect(
    chart.querySelector('[data-series="mobile"] path')!.getAttribute("d"),
  ).toBe("");
  expect(chart.querySelectorAll('[data-series="mobile"] circle')).toHaveLength(
    0,
  );
  expect(screen.queryByText(/次有效检测/)).toBeNull();
  expect(screen.queryByRole("slider")).toBeNull();
  fireEvent.focus(chart);
  fireEvent.keyDown(chart, { key: "ArrowLeft" });
  expect(screen.getByRole("tooltip").textContent).toContain("中国电信无结果");
  fireEvent.keyDown(chart, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

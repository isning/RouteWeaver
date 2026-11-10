// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ProviderMeasurementForm } from "./ObservationForms";
import type { NodeObservationView } from "./observability-model";

const initial: NodeObservationView = {
  nodeId: "host", config: {
    revision: 1, observerInstanceId: "core", billedInterfaces: ["eth0"],
    provider: { name: "Example provider", mode: "limited", allowance: 2, unit: "TB", cycleId: "cycle",
      cycleStart: "2026-11-01T00:00:00Z", cycleEnd: "2026-12-01T00:00:00Z", notificationSource: "nic_estimate", exhaustionAction: "advisory" },
  },
  latest: { digest: "sample-one", observedAt: "2026-11-10T12:00:00Z", receivedAt: "2026-11-10T12:00:00Z", source: "linux_procfs", continuity: "initial",
    cpuPercent: null, receiveBytesPerSecond: null, transmitBytesPerSecond: null,
    metrics: { memoryTotalBytes: 4096, memoryAvailableBytes: 2048, load1: 0, load5: 0, load15: 0, interfaces: [] },
  },
  provider: { source: "nic_estimate", coverage: "partial", statusReason: "initial_observation_requires_baseline", fresh: true,
    observedAt: "2026-11-10T12:00:00Z", observedSince: null, observedNicBytes: 0, totalBytes: 2000000000000, usedBytes: null, remainingBytes: null, exhaustionAction: "advisory", notificationEligible: false },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(kind: "baseline" | "statement" = "baseline") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const close = vi.fn();
  render(<QueryClientProvider client={client}><UIProviders><ProviderMeasurementForm initial={initial} kind={kind} onClose={close} /></UIProviders></QueryClientProvider>);
  return close;
}
async function acknowledge() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("本周期实际已用"), "5");
  await user.type(screen.getByLabelText("核对依据与说明"), "Checked supplier usage at the displayed sample");
  await user.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "保存核对结果" })).toHaveProperty("disabled", false);
  return user;
}

it("retires the acknowledged sample as soon as a re-read starts and keeps it retired after failure", async () => {
  let finish!: (value: Response) => void;
  const writes: unknown[] = [];
  const fetcher = vi.fn((_url, init) => {
    if (init?.method === "POST") { writes.push(JSON.parse(init.body)); return Promise.resolve(json(initial)); }
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const user = await acknowledge();
  await user.click(screen.getByRole("button", { name: "读取最新采样用于核对" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const confirmation = screen.getByRole("checkbox");
  expect(confirmation.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("最新采样尚未确认。读取成功后，请重新核对输入用量。")).toBeTruthy();
  expect(confirmation).toHaveProperty("disabled", true);
  await user.click(confirmation);
  fireEvent.submit(screen.getByLabelText("本周期实际已用").closest("form")!);
  await act(async () => { finish(json({ error: "无法读取最新采样" }, 503)); });
  expect(await screen.findByText("无法读取最新采样")).toBeTruthy();
  expect(confirmation.getAttribute("aria-checked")).toBe("false");
  expect(confirmation).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "保存核对结果" })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("本周期实际已用")).toHaveProperty("value", "5");
  expect(screen.getByLabelText("核对依据与说明")).toHaveProperty("value", "Checked supplier usage at the displayed sample");
  fireEvent.submit(screen.getByLabelText("本周期实际已用").closest("form")!);
  await act(async () => {});
  expect(writes).toEqual([]);
});

it.each(["failed read", "changed cycle", "missing sample"])("requires a successful replacement and a new acknowledgement after %s", async (failure) => {
  const changedCycle = structuredClone(initial);
  changedCycle.config.provider!.cycleId = "replacement-cycle";
  const latest = { ...initial, latest: { ...initial.latest!, digest: "sample-two", observedAt: "2026-11-10T12:01:00Z" } };
  let reads = 0;
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") { expect(url).toBe("/api/admin/nodes/host/observability/baseline"); bodies.push(JSON.parse(init.body)); return json(latest); }
    reads++;
    if (reads > 1) return json(latest);
    return failure === "failed read" ? json({ error: "采样读取失败，请重试" }, 503)
      : json(failure === "changed cycle" ? changedCycle : { ...initial, latest: null });
  }));
  const close = mount();
  const user = await acknowledge();
  const refresh = screen.getByRole("button", { name: "读取最新采样用于核对" });
  const save = screen.getByRole("button", { name: "保存核对结果" });
  await user.click(refresh);
  await waitFor(() => expect(refresh.getAttribute("aria-busy")).not.toBe("true"));
  if (failure === "changed cycle") expect(await screen.findByText("供应商周期已变更，请关闭窗口，刷新服务器资源后重新核对。")).toBeTruthy();
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(save).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("checkbox"));
  fireEvent.submit(screen.getByLabelText("本周期实际已用").closest("form")!);
  await act(async () => {});
  expect(bodies).toEqual([]);
  await user.click(refresh);
  await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("disabled", false));
  expect(reads).toBe(2);
  expect(save).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(screen.getByLabelText("本周期实际已用")).toHaveProperty("value", "5");
  expect(bodies).toEqual([]);
  await user.click(screen.getByRole("checkbox"));
  await user.click(save);
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(bodies).toEqual([{ cycleId: "cycle", usedBytes: 5000000000, reportDigest: "sample-two", reason: "Checked supplier usage at the displayed sample" }]);
});

it("does not carry an old save error into a different failed sample read", async () => {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") return json({ error: "采样已变化，请重新核对" }, 409);
    reads++;
    return json({ error: "最新采样暂时读取失败" }, 503);
  }));
  mount();
  const user = await acknowledge();
  await user.click(screen.getByRole("button", { name: "保存核对结果" }));
  await screen.findByText("采样已变化，请重新核对");
  await user.click(screen.getByRole("button", { name: "读取最新采样用于核对" }));
  expect(await screen.findByText("最新采样暂时读取失败")).toBeTruthy();
  expect(screen.queryByText("采样已变化，请重新核对")).toBeNull();
  expect(reads).toBe(1);
  expect(screen.getByRole("button", { name: "保存核对结果" })).toHaveProperty("disabled", true);
});

it("keeps manual supplier statements independent of sample review", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    expect(url).toBe("/api/admin/nodes/host/observability/provider-statement");
    bodies.push(JSON.parse(init.body));
    return json(initial);
  }));
  const close = mount("statement");
  fireEvent.change(screen.getByLabelText("本周期实际已用"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("供应商用量的统计时间（浏览器当地时间）"), { target: { value: "2026-11-10T12:00" } });
  fireEvent.change(screen.getByLabelText("账单或控制台记录引用"), { target: { value: "supplier receipt" } });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "读取最新采样用于核对" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "保存核对结果" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(bodies).toEqual([{ cycleId: "cycle", usedBytes: 5000000000, observedAt: new Date("2026-11-10T12:00").toISOString(), reference: "supplier receipt" }]);
});


it("does not let a departed read change a reopened baseline decision", async () => {
  let finish!: (value: Response) => void;
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn((_url, init) => {
    if (init?.method === "POST") { bodies.push(JSON.parse(init.body)); return Promise.resolve(json(initial)); }
    return new Promise<Response>((resolve) => { finish = resolve; });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Owner() {
    const [open, setOpen] = useState(true);
    return <><button disabled={open} onClick={() => setOpen(true)}>重新打开核对</button>{open && <ProviderMeasurementForm initial={initial} kind="baseline" onClose={() => setOpen(false)} />}</>;
  }
  render(<QueryClientProvider client={client}><UIProviders><Owner /></UIProviders></QueryClientProvider>);
  const user = await acknowledge();
  await user.click(screen.getByRole("button", { name: "读取最新采样用于核对" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(await screen.findByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "重新打开核对" }));
  expect(screen.getByLabelText("本周期实际已用")).toHaveProperty("value", "");
  await user.type(screen.getByLabelText("本周期实际已用"), "9");
  await user.type(screen.getByLabelText("核对依据与说明"), "New decision");
  await user.click(screen.getByRole("checkbox"));
  await act(async () => { finish(json({ ...initial, latest: { ...initial.latest!, digest: "departed-sample" } })); });
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByLabelText("本周期实际已用")).toHaveProperty("value", "9");
  await user.click(screen.getByRole("button", { name: "保存核对结果" }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies).toEqual([{ cycleId: "cycle", usedBytes: 9000000000, reportDigest: "sample-one", reason: "New decision" }]);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerResourceOverview, CoreStatusSummary } from "./ServerOverview";
import type { NodeObservationView } from "./observability-model";
const host = { id: "host-1", name: "Tokyo", address: "tokyo.example.com" };
const view = (): NodeObservationView => ({
  nodeId: host.id,
  config: { revision: 1, observerInstanceId: "core-1", billedInterfaces: ["eth0"], provider: { name: "Example VPS", mode: "limited", allowance: 100, unit: "GB", notificationSource: "provider_statement", exhaustionAction: "advisory" } },
  latest: { digest: "sample", observedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), source: "agent", continuity: "continuous", cpuPercent: 0, receiveBytesPerSecond: 0, transmitBytesPerSecond: null, metrics: { memoryTotalBytes: 1073741824, memoryAvailableBytes: 536870912, load1: 0, load5: 0, load15: 0, interfaces: [] } },
  provider: { source: "provider_statement", coverage: "cycle", statusReason: "operator_entered_provider_statement", fresh: false, observedAt: "2026-01-01T00:00:00Z", observedSince: null, observedNicBytes: 0, totalBytes: 100000000000, usedBytes: 20000000000, remainingBytes: 80000000000, exhaustionAction: "advisory", notificationEligible: false },
});
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function mount(content: React.ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); render(<QueryClientProvider client={client}>{content}</QueryClientProvider>); return client; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows actual zero measurements and distinguishes fresh resources from older provider balance", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond(view())));
  mount(<ServerResourceOverview host={host} onOpenResources={vi.fn()} />);
  expect(await screen.findByText("0.0%", { exact: true })).toBeTruthy();
  expect(screen.getByText("0 B/s", { exact: true })).toBeTruthy();
  expect(within(screen.getByRole("group", { name: "计费网卡流量" })).getByText("发送 等待连续采样", { exact: true })).toBeTruthy();
  const quota = screen.getByRole("group", { name: "供应商剩余额度" });
  expect(within(quota).getByText("较早的用量记录")).toBeTruthy();
  expect(within(quota).getByText("手工录入的供应商账单")).toBeTruthy();
  expect(screen.queryByText("服务器在线")).toBeNull();
});
it("retains the last resource sample after a failed refresh and provides a retry", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(respond(view())).mockResolvedValue(respond({ error: "temporary" }, 503));
  vi.stubGlobal("fetch", fetcher);
  mount(<ServerResourceOverview host={host} onOpenResources={vi.fn()} />);
  await screen.findByText("0.0%", { exact: true });
  await userEvent.click(screen.getByRole("button", { name: "刷新资源概览" }));
  expect(await screen.findByText("资源刷新失败，以下保留上次读取的数据。")).toBeTruthy();
  expect(screen.getByText("0.0%", { exact: true })).toBeTruthy();
});
it("makes a missing observation actionable without inventing metrics", async () => {
  const data = view(); data.latest = null; data.config.observerInstanceId = ""; data.config.provider = null;
  const open = vi.fn(); vi.stubGlobal("fetch", vi.fn(async () => respond(data)));
  mount(<ServerResourceOverview host={host} onOpenResources={open} />);
  expect(await screen.findByText("尚未设置资源采集")).toBeTruthy();
  expect(screen.queryByText("0.0%")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "设置采集与额度" }));
  expect(open).toHaveBeenCalledOnce();
});
it("keeps a provider admission restriction visible even with a fresh resource sample", async () => {
  const data = view(); data.provider.managedAdmissionReason = "provider-exhausted"; data.config.provider!.exhaustionAction = "suspend-managed";
  vi.stubGlobal("fetch", vi.fn(async () => respond(data)));
  mount(<ServerResourceOverview host={host} onOpenResources={vi.fn()} />);
  expect(await screen.findByText("供应商额度已耗尽")).toBeTruthy();
  expect(screen.getByText("托管线路暂停新连接与续期。请核对供应商周期与用量。")).toBeTruthy();
});
it("uses the current pending generation instead of claiming an older failure is current", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond({ instanceId: "core-1", phase: "pending-new-generation", state: { phase: "apply_failed", recoveryRequired: true, nativeChecked: true }, serviceIntent: { running: true, status: "running", automaticAttempts: 0 } })));
  mount(<CoreStatusSummary instanceId="core-1" />);
  expect(await screen.findByText("等待最新配置")).toBeTruthy();
  expect(screen.queryByText("应用失败")).toBeNull();
  expect(screen.queryByText("运行中")).toBeNull();
});
it("does not turn a failed or malformed status read into an offline core", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond([], 200)));
  mount(<CoreStatusSummary instanceId="core-1" />);
  await waitFor(() => expect(screen.getByText("状态待核对")).toBeTruthy());
  expect(screen.queryByText("离线")).toBeNull();
});

it("keeps older samples visibly historical without claiming a live reading", async () => {
  const data = view(); data.latest!.observedAt = "2026-01-01T00:00:00Z";
  vi.stubGlobal("fetch", vi.fn(async () => respond(data)));
  mount(<ServerResourceOverview host={host} onOpenResources={vi.fn()} />);
  expect(await screen.findByText(/较早的采样/)).toBeTruthy();
  expect(screen.getByText("该采样不在最近 15 分钟内，以上数值不代表当前资源使用情况。")).toBeTruthy();
});
it("does not report unconfigured collection when an observation belongs to another server", async () => {
  const data = view(); data.nodeId = "another-host";
  vi.stubGlobal("fetch", vi.fn(async () => respond(data)));
  mount(<ServerResourceOverview host={host} onOpenResources={vi.fn()} />);
  expect(await screen.findByText("资源数据尚未确定，请刷新重试。")).toBeTruthy();
  expect(screen.queryByText("尚未设置资源采集")).toBeNull();
  expect(screen.queryByText("0.0%")).toBeNull();
});

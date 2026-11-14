// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreDiagnosticsPanel } from "./CoreDiagnosticsPanel";
const host = { id: "node", name: "Tokyo", address: "example.invalid" };
const cores = [{ id: "one", hostId: "node", name: "Entry", adapterId: "routeweaver/xray", version: "26.3.27" }, { id: "two", hostId: "node", name: "Relay", adapterId: "routeweaver/sing-box", version: "1.14.3" }];
const view = (instanceId = "one") => ({ instanceId, supported: true, collectionState: "recent", lastReceivedAt: "2026-11-14T07:00:00Z", events: [{ adapterId: "routeweaver/xray", version: "26.3.27", code: "listener_address_in_use", observedAt: "2026-11-14T06:59:00Z", receivedAt: "2026-11-14T07:00:00Z" }], omitted: 2, dropped: 1, retentionHours: 24, historyLimit: 128 });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<QueryClientProvider client={client}><CoreDiagnosticsPanel host={host} instances={cores} /></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows fixed fault categories and collection limits without raw logs or export controls", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(view())));
  mount();
  expect(await screen.findByText("监听地址已被占用")).toBeTruthy();
  expect(screen.getByText(/2 行未识别，1 行因采集限制丢弃/)).toBeTruthy();
  expect(screen.getByText(/不包含原始日志/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "导出" })).toBeNull();
});
it("isolates core switching and rejects another core's response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(view())));
  mount();
  await screen.findByText("监听地址已被占用");
  await userEvent.click(screen.getByRole("combobox", { name: "诊断核心" }));
  await userEvent.click(screen.getByRole("option", { name: "Relay" }));
  expect(await screen.findByText("无法读取诊断记录，请重试。")).toBeTruthy();
  expect(screen.queryByText("监听地址已被占用")).toBeNull();
});
it("retains last records with a visible refresh error instead of claiming no faults", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(view())).mockResolvedValue(response({}, 503)));
  mount();
  await screen.findByText("监听地址已被占用");
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect(await screen.findByText("诊断记录刷新失败，以下保留上次读取的记录。")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "故障记录" })).getByText("监听地址已被占用")).toBeTruthy();
});

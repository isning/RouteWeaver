// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RawCoreLogsPanel } from "./RawCoreLogsPanel";
const view = (empty = false) => ({
  instanceId: "core", collectionState: "recent", lastReceivedAt: "2026-11-17T00:00:00Z",
  events: empty ? [] : [{ adapterId: "xray", version: "1", stream: "stderr", text: "Synthetic log",
    observedAt: "2026-11-17T00:00:00Z", receivedAt: "2026-11-17T00:00:00Z" }],
  dropped: 0, retentionSeconds: 3600, historyLimit: 128, lineBytesLimit: 4096,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><RawCoreLogsPanel
    host={{ id: "host", name: "Host", address: "example.test" }}
    instances={[{ id: "core", hostId: "host", adapterId: "xray", version: "1" }]} /></UIProviders></QueryClientProvider>);
}
it("hands keyboard focus to revealed controls once, not on a later response", async () => {
  let deliver!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { deliver = resolve; });
  const reads: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/admin/instances/core/core-logs" || (init?.method && init.method !== "GET")) throw new Error("Unexpected request");
    reads.push(url); return pending;
  }));
  mount();
  expect(reads).toEqual([]);
  screen.getByRole("button", { name: "查看日志原文" }).focus();
  await userEvent.keyboard("{Enter}");
  const keyword = screen.getByRole("textbox", { name: "原文关键词" });
  expect(document.activeElement).toBe(keyword);
  const stream = screen.getByRole("combobox", { name: "输出通道" });
  stream.focus();
  await act(async () => deliver(json(view())));
  await screen.findByText("Synthetic log");
  expect(document.activeElement).toBe(stream);
  expect(reads).toHaveLength(1);
});
it("clears an applied zero-result filter explicitly, restores controls and never writes or exports", async () => {
  const reads: string[] = [], unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url, "https://example.test");
    if (parsed.pathname !== "/api/admin/instances/core/core-logs" ||
      (init?.method && init.method !== "GET") ||
      [...parsed.searchParams.keys()].some(key => !["stream", "q", "since"].includes(key))) {
      unexpected.push(url); throw new Error("Unexpected request");
    }
    reads.push(url);
    return json(view(parsed.searchParams.size > 0));
  }));
  mount();
  expect(reads).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await screen.findByText("Synthetic log");
  expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  const stream = screen.getByRole("combobox", { name: "输出通道" });
  await userEvent.click(stream);
  await userEvent.click(screen.getByRole("option", { name: "stderr" }));
  const period = screen.getByRole("combobox", { name: "采集时间" });
  await userEvent.click(period);
  await userEvent.click(screen.getByRole("option", { name: "最近15分钟" }));
  const keyword = screen.getByRole("textbox", { name: "原文关键词" });
  await userEvent.type(keyword, "absent");
  expect(reads).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "筛选" }));
  await screen.findByText("当前筛选下没有日志记录。");
  await userEvent.type(keyword, " draft");
  await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(keyword);
  expect(keyword).toHaveProperty("value", "");
  expect(stream.textContent).toContain("全部通道");
  expect(period.textContent).toContain("全部保留记录");
  expect(screen.queryByText("筛选条件已更改，请先点击筛选。")).toBeNull();
  await screen.findByText("Synthetic log");
  expect(reads.at(-1)).toBe("/api/admin/instances/core/core-logs");
  expect(unexpected).toEqual([]);
});

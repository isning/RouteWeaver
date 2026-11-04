// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
for (const status of ["rendered", "unknown-future-status"]) {
  it(`shows ${status} as a historical record, never a fresh successful validation`, async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      requests.push(`${init?.method || "GET"} ${url}`);
      const data = String(url) === "/api/state" ? {
        nodes: [], users: [], routes: [{ id: "route", name: "历史线路", engine: "xray", hops: [], userIds: [] }], capabilities: [],
        revisions: [{ id: "revision", routeId: "route", engine: "xray", status, createdAt: "2026-10-29T10:00:00Z", artifacts: [{ path: "config.json", content: '{"log":{}}' }], digest: "digest", nativeChecked: false }],
      } : [];
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
    render(<QueryClientProvider client={client}><UIProviders><AdminPage page="activity" /></UIProviders></QueryClientProvider>);
    const opener = await screen.findByRole("button", { name: "查看" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "历史线路的生成记录" });
    expect(within(dialog).getByText("历史配置记录")).toBeTruthy();
    expect(within(dialog).queryByText("配置结构校验完成")).toBeNull();
    expect(within(dialog).getByText("此处展示当时保存的配置记录。检查当前配置请重新校验；服务器应用情况请查看节点确认状态。" )).toBeTruthy();
    if (status !== "rendered") expect(within(dialog).getByText(status)).toBeTruthy();
    for (let attempt = 0; attempt < 2; attempt++) {
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
      if (attempt === 0) {
        await userEvent.click(opener);
        await screen.findByRole("dialog", { name: "历史线路的生成记录" });
      }
    }
    expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  });
}

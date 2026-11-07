// @vitest-environment jsdom
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RateSettings } from "./Rates";

const epoch = Date.parse("2026-11-06T00:00:00Z");
const clients: QueryClient[] = [];
const rate = (id: string, offset: number) => ({ id, routeId: id, micros: 1_000_000, effectiveAt: new Date(epoch + offset).toISOString() });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(rows: ReturnType<typeof rate>[], onCommit = () => {}) {
  const fetcher = vi.fn(() => { throw new Error("Unexpected rates request"); });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  clients.push(client);
  client.setQueryData(["rates"], rows);
  const view = render(<QueryClientProvider client={client}><UIProviders><Profiler id="rates" onRender={onCommit}><RateSettings routes={[]} /></Profiler></UIProviders></QueryClientProvider>);
  return { client, fetcher, ...view };
}
const pending = (id: string) => within(screen.getByRole("row", { name: new RegExp(id) })).queryByText("待生效");

// Synthetic clock and cached read model; these tests do not observe billing enforcement.
it("retires only the due pending labels at successive boundaries without a request", async () => {
  const { fetcher } = mount([rate("first-route", 1000), rate("later-route", 3000), rate("past-route", -1000)]);
  expect(pending("first-route")).not.toBeNull();
  expect(pending("later-route")).not.toBeNull();
  expect(pending("past-route")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(pending("first-route")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(pending("first-route")).toBeNull();
  expect(pending("later-route")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.queryByText("待生效")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(30 * 86400000); });
  expect(fetcher).not.toHaveBeenCalled();
});
it("replaces a scheduled boundary when cached rates change", async () => {
  const { client, fetcher } = mount([rate("old-route", 1000)]);
  act(() => { client.setQueryData(["rates"], [rate("new-route", 2000)]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(pending("new-route")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(pending("new-route")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("handles a far future boundary without overflowing the timer", async () => {
  const offset = 2_147_483_647 + 1000;
  const { fetcher } = mount([rate("far-route", offset)]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_147_483_647); });
  expect(pending("far-route")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(pending("far-route")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("rechecks wall time if a clock setback leaves the boundary in the future", async () => {
  mount([rate("clock-route", 1000)]);
  vi.setSystemTime(epoch - 5000);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(pending("clock-route")).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(pending("clock-route")).toBeNull();
});

it("retires a boundary crossed between render and passive effects", async () => {
  const { fetcher } = mount([rate("commit-route", 1000)], () => {
    // React commits the rendered pending label before passive effects run.
    vi.setSystemTime(epoch + 1000);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(pending("commit-route")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

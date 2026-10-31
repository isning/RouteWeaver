// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AccountingRecovery } from "./AccountingRecovery";

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccountingRecovery instanceId="demo-instance" />
      </UIProviders>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("shows pending automatic recovery without asking an operator to establish a counter baseline", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify([
          {
            receiptId: "pending-1",
            reason: "missing baseline",
            createdAt: "2026-10-30T00:00:00Z",
            batch: {
              digest: "demo",
              samples: [
                {
                  sampleId: "sample-1",
                  subjectId: "user-1",
                  cumulativeBytes: "100",
                  observedAt: "2026-10-30T00:00:00Z",
                },
              ],
            },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  mount();
  expect(await screen.findByText("等待节点恢复上报")).toBeTruthy();
  expect(screen.getByText(/无法确定归属的历史流量不会补扣/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "核对计数起点" })).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("hides the status automatically after the node successfully replays its pending data", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { receiptId: "pending-1", reason: "legacy", batch: { samples: [] } },
        ]),
        { status: 200 },
      ),
    )
    .mockImplementation(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(screen.getByText("等待节点恢复上报")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_020);
  });
  expect(screen.queryByText("等待节点恢复上报")).toBeNull();
  expect(screen.queryByText("流量统计")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.every(
      ([, options]) => !options?.method || options.method === "GET",
    ),
  ).toBe(true);
});

it("offers only a read retry on failure and never submits a baseline or resets usage", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "offline" }), { status: 503 }),
    )
    .mockResolvedValueOnce(new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  mount();
  expect(await screen.findByText("流量统计状态暂不可用")).toBeTruthy();
  expect(screen.queryByText("等待节点恢复上报")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() =>
    expect(screen.queryByText("流量统计状态暂不可用")).toBeNull(),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    fetcher.mock.calls.every(
      ([, options]) => !options?.method || options.method === "GET",
    ),
  ).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps the failed read card and retry focus while a repeated read is pending", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "offline" }), { status: 503 }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  mount();
  const retry = await screen.findByRole("button", { name: "重新读取" });
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByText("流量统计状态暂不可用")).toBeTruthy();
  expect(retry.isConnected).toBe(true);
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  expect(retry.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(retry);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish(
      new Response(JSON.stringify({ error: "still offline" }), { status: 503 }),
    );
  });
  await waitFor(() =>
    expect((retry as HTMLButtonElement).disabled).toBe(false),
  );
  expect(screen.getByRole("button", { name: "重新读取" })).toBe(retry);
  expect(document.activeElement).toBe(retry);
});

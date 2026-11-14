// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RawCoreLogsPanel } from "./RawCoreLogsPanel";
import type { HostRecord, CoreInstance } from "./types";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("does not read raw logs before the administrator acknowledges sensitive content and renders text literally", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          instanceId: "core",
          collectionState: "recent",
          lastReceivedAt: "2026-11-14T00:00:00Z",
          events: [
            {
              adapterId: "sing-box",
              version: "1",
              stream: "stderr",
              text: "<img src=x onerror=alert(1)> token=synthetic",
              observedAt: "2026-11-14T00:00:00Z",
              receivedAt: "2026-11-14T00:00:00Z",
            },
          ],
          dropped: 0,
          retentionSeconds: 3600,
          historyLimit: 128,
          lineBytesLimit: 4096,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RawCoreLogsPanel
          host={{ id: "host" } as HostRecord}
          instances={[
            {
              id: "core",
              hostId: "host",
              adapterId: "sing-box",
              version: "1",
            } as CoreInstance,
          ]}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByText(/可能包含/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  expect(
    await screen.findByText("<img src=x onerror=alert(1)> token=synthetic"),
  ).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  client.clear();
});
it("applies keyword filters explicitly and blocks exporting stale filter selections", async () => {
  const { waitFor } = await import("@testing-library/react");
  const fetch = vi.fn(
    async (_url: string) =>
      new Response(
        JSON.stringify({
          instanceId: "core",
          collectionState: "recent",
          lastReceivedAt: null,
          events: [
            {
              adapterId: "sing-box",
              version: "1",
              stream: "stdout",
              text: "synthetic row",
              observedAt: "2026-11-14T00:00:00Z",
              receivedAt: "2026-11-14T00:00:00Z",
            },
          ],
          dropped: 0,
          retentionSeconds: 3600,
          historyLimit: 128,
          lineBytesLimit: 4096,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RawCoreLogsPanel
          host={{ id: "host" } as HostRecord}
          instances={[
            {
              id: "core",
              hostId: "host",
              adapterId: "sing-box",
              version: "1",
            } as CoreInstance,
          ]}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await screen.findByText("synthetic row");
  fireEvent.change(screen.getByLabelText("原文关键词"), {
    target: { value: "domain & name" },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole("button", { name: "导出当前筛选" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "筛选" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls[1][0]).toBe(
    "/api/admin/instances/core/core-logs?q=domain+%26+name",
  );
  fireEvent.change(screen.getByLabelText("原文关键词"), {
    target: { value: "中".repeat(43) },
  });
  expect(screen.getByText("关键词过长，请缩短后再筛选。")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "筛选" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  client.clear();
});

it("does not download a late raw log export after its panel closes", async () => {
  const { within, waitFor } = await import("@testing-library/react");
  let settle!: (response: Response) => void;
  const createObjectURL = vi.fn(() => "blob:synthetic");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("format=ndjson"))
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      return new Response(
        JSON.stringify({
          instanceId: "core",
          collectionState: "recent",
          lastReceivedAt: null,
          events: [
            {
              adapterId: "sing-box",
              version: "1",
              stream: "stdout",
              text: "synthetic row",
              observedAt: "2026-11-14T00:00:00Z",
              receivedAt: "2026-11-14T00:00:00Z",
            },
          ],
          dropped: 0,
          retentionSeconds: 3600,
          historyLimit: 128,
          lineBytesLimit: 4096,
        }),
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const shell = (open: boolean) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        {open && (
          <RawCoreLogsPanel
            host={{ id: "host" } as HostRecord}
            instances={[
              {
                id: "core",
                hostId: "host",
                adapterId: "sing-box",
                version: "1",
              } as CoreInstance,
            ]}
          />
        )}
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(shell(true));
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await screen.findByText("synthetic row");
  fireEvent.click(screen.getByRole("button", { name: "导出当前筛选" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "导出 NDJSON" }));
  await waitFor(() => expect(settle).toBeTypeOf("function"));
  view.rerender(shell(false));
  settle(
    new Response("synthetic sensitive record", {
      headers: { "Content-Type": "application/x-ndjson" },
    }),
  );
  // Let the deliberately late body settle before asserting no download side effect.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  click.mockRestore();
  client.clear();
});

it("hides previously read raw records when a refresh denies access", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ++calls > 1
        ? new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
        : new Response(
            JSON.stringify({
              instanceId: "core",
              collectionState: "recent",
              lastReceivedAt: null,
              events: [
                {
                  adapterId: "sing-box",
                  version: "1",
                  stream: "stdout",
                  text: "synthetic private record",
                  observedAt: "2026-11-14T00:00:00Z",
                  receivedAt: "2026-11-14T00:00:00Z",
                },
              ],
              dropped: 0,
              retentionSeconds: 3600,
              historyLimit: 128,
              lineBytesLimit: 4096,
            }),
          ),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RawCoreLogsPanel
          host={{ id: "host" } as HostRecord}
          instances={[
            {
              id: "core",
              hostId: "host",
              adapterId: "sing-box",
              version: "1",
            } as CoreInstance,
          ]}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await screen.findByText("synthetic private record");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByText("无权读取原文日志，请确认当前管理员登录。");
  expect(screen.queryByText("synthetic private record")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "导出当前筛选" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  client.clear();
});

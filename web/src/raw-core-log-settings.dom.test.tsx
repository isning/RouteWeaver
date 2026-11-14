// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { StrictMode } from "react";
import { RawCoreLogsPanel } from "./RawCoreLogsPanel";
import type { HostRecord, CoreInstance } from "./types";
import { RawCoreLogSettings } from "./RawCoreLogSettings";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("requires explicit confirmation and sends revision while clearing the old view after save", async () => {
  const changed = vi.fn();
  const fetch = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          instanceId: "core",
          enabled: init?.method === "PUT",
          retentionSeconds: 3600,
          revision: init?.method === "PUT" ? "next" : "",
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
        <StrictMode>
          <RawCoreLogSettings instanceId="core" onChanged={changed} />
        </StrictMode>
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "采集设置" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "允许平台接收日志原文" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/保存会清除当前平台已收集的日志/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "确认保存并清除现有日志" }),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(
    JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string),
  ).toEqual({ expectedRevision: "", enabled: true, retentionSeconds: 3600 });
  expect(
    await screen.findByText(
      "设置已保存；是否正在采集，仍取决于节点配置与上报。",
    ),
  ).toBeTruthy();
  client.clear();
});
it("preserves choices after a CAS conflict and requires an explicit reread before another confirmation", async () => {
  let revision = "old";
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      revision = "new";
      return new Response(JSON.stringify({ error: "conflict" }), {
        status: 409,
      });
    }
    return new Response(
      JSON.stringify({
        instanceId: "core",
        enabled: false,
        retentionSeconds: 3600,
        revision,
        historyLimit: 128,
        lineBytesLimit: 4096,
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RawCoreLogSettings instanceId="core" onChanged={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "采集设置" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "允许平台接收日志原文" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  fireEvent.click(
    screen.getByRole("button", { name: "确认保存并清除现有日志" }),
  );
  expect(await screen.findByText(/设置已被修改/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "重新读取设置" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  fireEvent.click(
    screen.getByRole("button", { name: "确认保存并清除现有日志" }),
  );
  await waitFor(() =>
    expect(fetch.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(
      2,
    ),
  );
  expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({
    expectedRevision: "new",
    enabled: true,
    retentionSeconds: 3600,
  });
  client.clear();
});
it("does not update a new core view when a save finishes after leaving", async () => {
  let finish!: (response: Response) => void;
  const changed = vi.fn();
  const value = {
    instanceId: "core",
    enabled: false,
    retentionSeconds: 3600,
    revision: "before",
    historyLimit: 128,
    lineBytesLimit: 4096,
  };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "PUT"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : new Response(JSON.stringify(value)),
  );
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RawCoreLogSettings instanceId="core" onChanged={changed} />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "采集设置" }));
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  fireEvent.click(
    screen.getByRole("button", { name: "确认保存并清除现有日志" }),
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.unmount();
  const { act } = await import("@testing-library/react");
  await act(async () =>
    finish(new Response(JSON.stringify({ ...value, revision: "after" }))),
  );
  expect(changed).not.toHaveBeenCalled();
  client.clear();
});
it("does not resurrect deleted raw text while a fresh post-save log read is pending", async () => {
  let logs = 0;
  let lateRead: ((value: Response) => void) | undefined;
  const settings = {
    instanceId: "core",
    enabled: false,
    retentionSeconds: 3600,
    revision: "one",
    historyLimit: 128,
    lineBytesLimit: 4096,
  };
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/settings"))
      return new Response(
        JSON.stringify({
          ...settings,
          revision: init?.method === "PUT" ? "two" : "one",
        }),
      );
    if (++logs === 2)
      return new Promise<Response>((resolve) => {
        lateRead = resolve;
      });
    if (logs > 2) return new Promise<Response>(() => {});
    return new Response(
      JSON.stringify({
        instanceId: "core",
        collectionState: "recent",
        lastReceivedAt: null,
        events: [
          {
            adapterId: "xray",
            version: "1",
            stream: "stderr",
            text: "old sensitive text",
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
  });
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
              adapterId: "xray",
              version: "1",
            } as CoreInstance,
          ]}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await screen.findByText("old sensitive text");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(lateRead).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "采集设置" }));
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  fireEvent.click(
    screen.getByRole("button", { name: "确认保存并清除现有日志" }),
  );
  await screen.findByText("设置已保存；是否正在采集，仍取决于节点配置与上报。");
  fireEvent.click(screen.getByRole("button", { name: "查看日志原文" }));
  await waitFor(() => expect(logs).toBe(3));
  const { act } = await import("@testing-library/react");
  await act(async () =>
    lateRead!(
      new Response(
        JSON.stringify({
          instanceId: "core",
          collectionState: "recent",
          lastReceivedAt: null,
          events: [
            {
              adapterId: "xray",
              version: "1",
              stream: "stderr",
              text: "late sensitive text",
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
  expect(screen.queryByText("late sensitive text")).toBeNull();
  expect(screen.queryByText("old sensitive text")).toBeNull();
  client.clear();
});

// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InboxPage } from "./Notifications";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountInbox() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <InboxPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  return client;
}

it("names read state without color and keeps an unread message unread until its acknowledgement succeeds", async () => {
  let acknowledged = false;
  let settle!: (response: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(url);
        return new Promise<Response>((resolve) => {
          settle = resolve;
        });
      }
      if (url === "/api/me/notifications")
        return json([
          {
            eventId: "read",
            title: "已查看公告",
            body: "维护安排已确认。",
            createdAt: "2026-10-25T10:00:00Z",
            readAt: "2026-10-25T11:00:00Z",
          },
          {
            eventId: "unread",
            title: "额度提醒",
            body: "当月流量已使用 80%。",
            createdAt: "2026-10-26T09:00:00Z",
            ...(acknowledged ? { readAt: "2026-10-26T10:00:00Z" } : {}),
          },
        ]);
      throw new Error(`Unexpected inbox request: ${url}`);
    }),
  );
  mountInbox();
  const read = await screen.findByRole("button", { name: /已查看公告.*已读/ });
  const unread = screen.getByRole("button", { name: /额度提醒.*未读/ });
  expect(within(read).getByText("已读")).toBeTruthy();
  expect(within(unread).getByText("未读")).toBeTruthy();
  expect(unread.textContent).toContain("当月流量已使用 80%。");
  const user = userEvent.setup();
  await user.click(unread);
  await screen.findByRole("dialog", { name: "额度提醒" });
  expect(writes).toEqual(["/api/me/notifications/unread/read"]);
  expect(within(unread).getByText("未读")).toBeTruthy();
  acknowledged = true;
  settle(json({}));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /额度提醒.*已读/, hidden:true })).toBeTruthy(),
  );
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.click(read);
  expect(writes).toHaveLength(1);
});

it("retains the unread status and full message when marking it read fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url === "/api/me/notifications/unread/read" &&
        init?.method === "POST"
      )
        return json({ message: "暂时无法更新已读状态，请稍后重试。" }, 503);
      if (url === "/api/me/notifications")
        return json([
          {
            eventId: "unread",
            title: "额度提醒",
            body: "当月流量已使用 80%。",
            createdAt: "2026-10-26T09:00:00Z",
          },
        ]);
      throw new Error(`Unexpected inbox request: ${url}`);
    }),
  );
  mountInbox();
  const unread = await screen.findByRole("button", { name: /额度提醒.*未读/ });
  await userEvent.setup().click(unread);
  const dialog = await screen.findByRole("dialog", { name: "额度提醒" });
  expect(
    await within(dialog).findByText("暂时无法更新已读状态，请稍后重试。"),
  ).toBeTruthy();
  expect(within(dialog).getByText("当月流量已使用 80%。")).toBeTruthy();
  expect(within(unread).getByText("未读")).toBeTruthy();
});

it("describes an empty inbox without implying only unread messages are listed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  mountInbox();
  expect(await screen.findByText("暂无消息")).toBeTruthy();
  expect(screen.queryByText("暂时没有新消息")).toBeNull();
});


it("keeps the full dismissed message visible but inert until the sheet exit completes", async () => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computedStyle(element);
    if (element.matches('[data-task-overlay="sheet"]')) {
      Object.defineProperty(style, "animationName", {
        configurable: true,
        get: () => element.getAttribute("data-state") === "closed" ? "inbox-exit" : "none",
      });
    }
    return style;
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const body = "完整消息内容，不因列表摘要或关闭动画丢失。";
  vi.stubGlobal("fetch", vi.fn(async () => json([{ eventId: "message", title: "维护安排", body, createdAt: "2026-10-29T10:00:00Z", readAt: "2026-10-29T11:00:00Z" }])));
  mountInbox();
  const opener = await screen.findByRole("button", { name: /维护安排.*已读/ });
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "维护安排" });
  await userEvent.keyboard("{Escape}");
  expect(dialog.isConnected).toBe(true);
  expect(dialog.getAttribute("data-state")).toBe("closed");
  expect(dialog.hasAttribute("inert")).toBe(true);
  expect(within(dialog).getByText(body)).toBeTruthy();
  expect(within(dialog).getByRole("heading", { name: "维护安排" })).toBeTruthy();
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "animationName", { value: "inbox-exit" });
  fireEvent(dialog, event);
  await waitFor(() => expect(dialog.isConnected).toBe(false));
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("separates inbox loading and load failure from an empty inbox and recovers on explicit retry", async () => {
  let release!: (response: Response) => void;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      reads++;
      if (reads === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return json([]);
    }),
  );
  mountInbox();
  expect(screen.getByLabelText("正在加载").getAttribute("aria-busy")).toBe(
    "true",
  );
  expect(screen.queryByText("暂无消息")).toBeNull();
  release(json({ message: "消息暂时不可用" }, 503));
  await screen.findByText("消息暂时不可用");
  expect(screen.queryByText("暂无消息")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("暂无消息");
  expect(screen.queryByText("消息暂时不可用")).toBeNull();
});

it("does not attach a failed acknowledgement to another message after repeated keyboard dismissal", async () => {
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(url);
        return json({ message: "第一条消息未能标记已读" }, 503);
      }
      return json([
        {
          eventId: "first",
          title: "第一条提醒",
          body: "第一条正文",
          createdAt: "2026-11-01T10:00:00Z",
        },
        {
          eventId: "second",
          title: "已读维护通知",
          body: "第二条正文",
          createdAt: "2026-11-01T11:00:00Z",
          readAt: "2026-11-01T12:00:00Z",
        },
      ]);
    }),
  );
  mountInbox();
  const first = await screen.findByRole("button", { name: /第一条提醒.*未读/ });
  await userEvent.click(first);
  await screen.findByText("第一条消息未能标记已读");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(first));
  const second = screen.getByRole("button", { name: /已读维护通知.*已读/ });
  for (let attempt = 0; attempt < 2; attempt++) {
    second.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "已读维护通知" });
    expect(within(dialog).getByText("第二条正文")).toBeTruthy();
    expect(within(dialog).queryByText("第一条消息未能标记已读")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(second));
  }
  expect(writes).toEqual(["/api/me/notifications/first/read"]);
});


it.each([200, 503])("keeps message B active when message A acknowledgement settles late with %s", async (status) => {
  let settle!: (response: Response) => void;
  let acknowledged = false;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(url);
      return new Promise<Response>((resolve) => { settle = resolve; });
    }
    return json([
      { eventId: "first", title: "待确认提醒", body: "第一条正文", createdAt: "2026-11-01T10:00:00Z", ...(acknowledged ? { readAt: "2026-11-01T12:00:00Z" } : {}) },
      { eventId: "second", title: "已读维护通知", body: "第二条正文", createdAt: "2026-11-01T11:00:00Z", readAt: "2026-11-01T12:00:00Z" },
    ]);
  }));
  mountInbox();
  await userEvent.click(await screen.findByRole("button", { name: /待确认提醒.*未读/ }));
  await screen.findByRole("dialog", { name: "待确认提醒" });
  await userEvent.keyboard("{Escape}");
  const second = screen.getByRole("button", { name: /已读维护通知.*已读/ });
  await userEvent.click(second);
  const dialog = await screen.findByRole("dialog", { name: "已读维护通知" });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  close.focus();
  acknowledged = status === 200;
  await act(async () => { settle(json(status === 200 ? {} : { message: "旧消息确认失败" }, status)); });
  expect(within(dialog).getByText("第二条正文")).toBeTruthy();
  expect(within(dialog).queryByText("旧消息确认失败")).toBeNull();
  expect(document.activeElement).toBe(close);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(second));
  // Closing a presentation does not cancel the legitimate acknowledgement.
  await screen.findByRole("button", { name: status === 200 ? /待确认提醒.*已读/ : /待确认提醒.*未读/ });
  expect(writes).toEqual(["/api/me/notifications/first/read"]);
});


it("retries acknowledgement in the open message without losing its body", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      attempts++;
      return json(attempts === 1 ? { message: "已读更新失败" } : {}, attempts === 1 ? 503 : 200);
    }
    return json([{ eventId: "retry", title: "需要重试的消息", body: "保留完整正文", createdAt: "2026-11-01T10:00:00Z", ...(attempts > 1 ? { readAt: "2026-11-01T11:00:00Z" } : {}) }]);
  }));
  mountInbox();
  await userEvent.click(await screen.findByRole("button", { name: /需要重试的消息.*未读/ }));
  const dialog = await screen.findByRole("dialog", { name: "需要重试的消息" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "重试标记已读" }));
  await waitFor(() => expect(within(dialog).queryByText("已读更新失败")).toBeNull());
  expect(within(dialog).getByText("保留完整正文")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await screen.findByRole("button", { name: /需要重试的消息.*已读/ });
  expect(attempts).toBe(2);
});


it("updates an open message from the latest list and labels a removed message as previous content", async () => {
  let body = "之前正文";
  let removed = false;
  vi.stubGlobal("fetch", vi.fn(async () => json(removed ? [] : [{ eventId: "fresh", title: "更新公告", body, createdAt: "2026-11-01T10:00:00Z", readAt: "2026-11-01T11:00:00Z" }])));
  const client = mountInbox();
  await userEvent.click(await screen.findByRole("button", { name: /更新公告.*已读/ }));
  const dialog = await screen.findByRole("dialog", { name: "更新公告" });
  body = "修订正文";
  await act(async () => { await client.invalidateQueries({ queryKey: ["inbox"] }); });
  // Query completion precedes its scheduled observer render. Wait for the
  // visible revision before removing the message from the next response.
  expect(await within(dialog).findByText("修订正文")).toBeTruthy();
  removed = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["inbox"] }); });
  expect(await within(dialog).findByText("此消息已不在当前列表中，以下为之前读取的内容。")).toBeTruthy();
  expect(within(dialog).getByText("修订正文")).toBeTruthy();
});

it("labels cached inbox contents while a refresh is pending and does not call them empty on failure", async () => {
  let refresh = false;
  let settle!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async () => refresh
    ? new Promise<Response>((resolve) => { settle = resolve; })
    : json([{ eventId: "cache", title: "缓存消息", body: "正文", createdAt: "2026-11-01T10:00:00Z", readAt: "2026-11-01T11:00:00Z" }])));
  mountInbox();
  await screen.findByRole("button", { name: /缓存消息.*已读/ });
  refresh = true;
  await userEvent.click(screen.getByRole("button", { name: "刷新" }));
  expect((await screen.findByText("正在刷新消息，列表仍为上次读取结果。")).closest('[role="status"]')).toBeTruthy();
  await act(async () => { settle(json({ message: "刷新不可用" }, 503)); });
  await screen.findByText("刷新不可用");
  expect(screen.queryByText("暂无消息")).toBeNull();
});


it.each([false, true])("retains A acknowledgement failure after reopening it with another pending message: %s", async (openB) => {
  const pending = new Map<string, (response: Response) => void>();
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes.push(url);
      return new Promise<Response>((resolve) => { pending.set(url, resolve); });
    }
    return json([
      { eventId: "a", title: "消息A", body: "A完整正文", createdAt: "2026-11-01T10:00:00Z" },
      { eventId: "b", title: "消息B", body: "B完整正文", createdAt: "2026-11-01T11:00:00Z" },
    ]);
  }));
  mountInbox();
  const a = await screen.findByRole("button", { name: /消息A.*未读/ });
  await userEvent.click(a);
  await screen.findByRole("dialog", { name: "消息A" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(a));
  if (openB) {
    const b = screen.getByRole("button", { name: /消息B.*未读/ });
    await userEvent.click(b);
    await screen.findByRole("dialog", { name: "消息B" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(b));
  }
  await userEvent.click(a);
  const dialog = await screen.findByRole("dialog", { name: "消息A" });
  expect(writes.filter((url) => url.endsWith("/a/read"))).toHaveLength(1);
  await act(async () => { pending.get("/api/me/notifications/a/read")!(json({ message: "A已读更新失败" }, 503)); });
  expect(await within(dialog).findByText("A已读更新失败")).toBeTruthy();
  if (openB) {
    await act(async () => { pending.get("/api/me/notifications/b/read")!(json({ message: "B已读更新失败" }, 503)); });
    expect(within(dialog).queryByText("B已读更新失败")).toBeNull();
  }
  expect(within(dialog).getByText("A完整正文")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "重试标记已读" }));
  expect(writes.filter((url) => url.endsWith("/a/read"))).toHaveLength(2);
  await act(async () => { pending.get("/api/me/notifications/a/read")!(json({ message: "A再次失败" }, 503)); });
  expect(await within(dialog).findByText("A再次失败")).toBeTruthy();
});

it.each(["removed", "failed"])("blocks acknowledgement retry while list refresh is pending and after it is %s", async (outcome) => {
  let refreshing = false;
  let settle!: (response: Response) => void;
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      return json({ message: "已读确认失败" }, 503);
    }
    if (refreshing) return new Promise<Response>((resolve) => { settle = resolve; });
    return json([{ eventId: "guard", title: "保留消息", body: "仍可查看正文", createdAt: "2026-11-01T10:00:00Z" }]);
  }));
  const client = mountInbox();
  await userEvent.click(await screen.findByRole("button", { name: /保留消息.*未读/ }));
  const dialog = await screen.findByRole("dialog", { name: "保留消息" });
  const retry = await within(dialog).findByRole("button", { name: "重试标记已读" });
  refreshing = true;
  let refresh!: Promise<void>;
  act(() => { refresh = client.invalidateQueries({ queryKey: ["inbox"] }); });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(true));
  await userEvent.click(retry);
  expect(writes).toBe(1);
  await act(async () => {
    settle(outcome === "removed" ? json([]) : json({ message: "刷新失败" }, 503));
    await refresh;
  });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(retry);
  expect(writes).toBe(1);
  expect(within(dialog).getByText("仍可查看正文")).toBeTruthy();
});


it("offers explicit mark-read after opening an unread message during a background refresh without writing before freshness", async () => {
  let refresh = false;
  let acknowledged = false;
  let settle!: (response: Response) => void;
  let writes = 0;
  const item = () => ({ eventId: "fresh-action", title: "等待更新的消息", body: "完整消息仍可阅读", createdAt: "2026-11-01T10:00:00Z", ...(acknowledged ? { readAt: "2026-11-01T11:00:00Z" } : {}) });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      acknowledged = true;
      return json({});
    }
    if (refresh) return new Promise<Response>((resolve) => { settle = resolve; });
    return json([item()]);
  }));
  const client = mountInbox();
  const opener = await screen.findByRole("button", { name: /等待更新的消息.*未读/ });
  refresh = true;
  let readback!: Promise<void>;
  act(() => { readback = client.invalidateQueries({ queryKey: ["inbox"] }); });
  expect((await screen.findByText("正在刷新消息，列表仍为上次读取结果。")).closest('[role="status"]')).toBeTruthy();
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "等待更新的消息" });
  expect(within(dialog).getByText("正在核对消息，当前显示上次读取内容。").closest('[role="status"]')).toBeTruthy();
  const mark = within(dialog).getByRole("button", { name: "标记已读" });
  expect((mark as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(mark);
  expect(writes).toBe(0);
  refresh = false;
  await act(async () => { settle(json([item()])); await readback; });
  await waitFor(() => expect((mark as HTMLButtonElement).disabled).toBe(false));
  expect(writes).toBe(0);
  expect(within(dialog).getByText("完整消息仍可阅读")).toBeTruthy();
  await userEvent.click(mark);
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: "标记已读" })).toBeNull());
  expect(writes).toBe(1);
  await userEvent.keyboard("{Escape}");
  await screen.findByRole("button", { name: /等待更新的消息.*已读/ });
});

it("recovers a failed inbox refresh by keyboard from the open message", async () => {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    reads++;
    if (reads === 2) return json({ message: "读取失败" }, 503);
    return json([{ eventId: "recover", title: "维护消息", body: reads > 2 ? "最新完整正文" : "之前完整正文", createdAt: "2026-11-01T10:00:00Z", readAt: "2026-11-01T11:00:00Z" }]);
  }));
  const client = mountInbox();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /维护消息.*已读/ }));
  const dialog = await screen.findByRole("dialog", { name: "维护消息" });
  await act(async () => { await client.invalidateQueries({ queryKey: ["inbox"] }); });
  expect((await within(dialog).findByText("消息刷新失败，当前显示上次读取内容。")).closest('[role="alert"]')).toBeTruthy();
  const retry = within(dialog).getByRole("button", { name: "重试刷新" });
  within(dialog).getByRole("button", { name: "关闭" }).focus();
  for (let step = 0; step < 4 && document.activeElement !== retry; step++) await user.tab();
  expect(document.activeElement).toBe(retry);
  await user.keyboard("{Enter}");
  expect(await within(dialog).findByText("最新完整正文")).toBeTruthy();
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(within(dialog).queryByText("消息刷新失败，当前显示上次读取内容。")).toBeNull();
  expect(reads).toBe(3);
});

it.each([false, true])("removes obsolete acknowledgement errors when the message is confirmed read, with late failure: %s", async (lateFailure) => {
  let acknowledged = false;
  let settle!: (response: Response) => void;
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      return new Promise<Response>((resolve) => { settle = resolve; });
    }
    return json([{ eventId: "confirmed", title: "状态已同步的消息", body: "保留正文", createdAt: "2026-11-01T10:00:00Z", ...(acknowledged ? { readAt: "2026-11-01T11:00:00Z" } : {}) }]);
  }));
  const client = mountInbox();
  await userEvent.click(await screen.findByRole("button", { name: /状态已同步的消息.*未读/ }));
  const dialog = await screen.findByRole("dialog", { name: "状态已同步的消息" });
  if (!lateFailure) {
    await act(async () => { settle(json({ message: "旧的已读更新失败" }, 503)); });
    await within(dialog).findByText("旧的已读更新失败");
  }
  acknowledged = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["inbox"] }); });
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: /标记已读/ })).toBeNull());
  if (lateFailure) await act(async () => { settle(json({ message: "旧的已读更新失败" }, 503)); });
  await waitFor(() => expect(within(dialog).queryByText("旧的已读更新失败")).toBeNull());
  expect(within(dialog).getByText("保留正文")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: /状态已同步的消息.*已读/ }));
  expect(within(screen.getByRole("dialog")).queryByText("旧的已读更新失败")).toBeNull();
  expect(writes).toBe(1);
});

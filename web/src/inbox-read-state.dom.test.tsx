// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
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

// @vitest-environment jsdom
// App/session and controlled HTTP boundary; no live notification delivery.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";

const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
beforeAll(async () => { await import("./Notifications"); });
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");
});

it("keeps populated inbox messages readable after refresh failure and recovers the selected message without premature acknowledgement", async () => {
  history.replaceState(null, "", "/#inbox");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let reads = 0;
  let writes = 0;
  let acknowledged = false;
  let release!: (response: Response) => void;
  const unexpected: string[] = [];
  const messages = () => [
    { eventId: "maintenance", title: "维护安排", body: "维护完整正文", createdAt: "2026-11-01T10:00:00Z", readAt: "2026-11-01T11:00:00Z" },
    { eventId: "quota", title: "额度提醒", body: reads > 2 ? "最新额度正文" : "之前额度正文", createdAt: "2026-11-01T12:00:00Z", ...(acknowledged ? { readAt: "2026-11-01T13:00:00Z" } : {}) },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return json({ user: { id: "reader", name: "Reader", role: "user", passwordChangeRequired: false }, csrfToken: "synthetic" });
    if (url === "/api/me/notifications/quota/read" && init?.method === "POST") {
      writes++; acknowledged = true; return json({});
    }
    if (url === "/api/me/notifications" && (!init?.method || init.method === "GET")) {
      reads++;
      if (reads === 2) return new Promise<Response>((resolve) => { release = resolve; });
      return json(messages());
    }
    unexpected.push(`${init?.method || "GET"} ${url}`);
    throw new Error(`Unexpected inbox request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  const user = userEvent.setup();
  const main = await screen.findByRole("main");
  const maintenanceOpener = await within(main).findByRole("button", { name: /维护安排.*已读/ });
  const refresh = within(main).getByRole("button", { name: "刷新" });
  await user.dblClick(refresh);
  expect(reads).toBe(2);
  await user.click(within(main).getByRole("button", { name: /维护安排.*已读/ }));
  const maintenance = await screen.findByRole("dialog", { name: "维护安排" });
  await act(async () => { release(json({ message: "列表读取暂不可用" }, 503)); });
  await within(maintenance).findByText("消息刷新失败，当前显示上次读取内容。");
  expect(within(maintenance).getByText("维护完整正文")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(maintenanceOpener));
  // A failed read must not remove previously loaded messages or their openers.
  const quota = within(main).getByRole("button", { name: /额度提醒.*未读/ });
  expect(within(main).queryByText("暂无消息")).toBeNull();
  await user.click(quota);
  const dialog = await screen.findByRole("dialog", { name: "额度提醒" });
  expect(within(dialog).getByText("之前额度正文")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "标记已读" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toBe(0);
  await user.click(within(dialog).getByRole("button", { name: "重试刷新" }));
  await within(dialog).findByText("最新额度正文");
  expect(reads).toBe(3);
  expect(within(main).getByRole("button", { name: /额度提醒.*未读/, hidden: true })).toBeTruthy();
  expect(writes).toBe(0);
  await user.dblClick(within(dialog).getByRole("button", { name: "标记已读" }));
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: "标记已读" })).toBeNull());
  expect(writes).toBe(1);
  await user.keyboard("{Escape}");
  await within(main).findByRole("button", { name: /额度提醒.*已读/ });
  await waitFor(() => expect(document.activeElement).toBe(quota));
  expect(unexpected).toEqual([]);
});


it.each([200, 503])("keeps cached empty results and replaces failure direction during a held retry returning %s", async (retryStatus) => {
  history.replaceState(null, "", "/#inbox");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let reads = 0;
  let releaseRetry!: (response: Response) => void;
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      unexpected.push(`${init.method} ${url}`); throw new Error("Read-only case");
    }
    if (url === "/api/auth/me") return json({ user: { id: "reader", name: "Reader", role: "user", passwordChangeRequired: false }, csrfToken: "synthetic" });
    if (url === "/api/me/notifications") {
      reads++;
      if (reads === 3) return new Promise<Response>((resolve) => { releaseRetry = resolve; });
      return reads === 2 ? json({ message: "刷新暂不可用" }, 503) : json([]);
    }
    unexpected.push(url); throw new Error(`Unexpected read ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  const main = await screen.findByRole("main");
  await within(main).findByText("暂无消息");
  const user = userEvent.setup();
  const refresh = within(main).getByRole("button", { name: "刷新" });
  await user.click(refresh);
  await within(main).findByText("刷新暂不可用");
  expect(within(main).getByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。")).toBeTruthy();
  expect(within(main).getByText("暂无消息")).toBeTruthy();
  await user.click(refresh);
  await within(main).findByText("正在刷新消息，列表仍为上次读取结果。");
  expect(within(main).queryByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。")).toBeNull();
  expect(within(main).queryByText("刷新暂不可用")).toBeNull();
  expect(within(main).getByText("暂无消息")).toBeTruthy();
  await user.click(refresh);
  expect(reads).toBe(3);
  await act(async () => { releaseRetry(retryStatus === 200 ? json([]) : json({ message: "重试仍不可用" }, 503)); });
  if (retryStatus === 503) {
    await within(main).findByText("重试仍不可用");
    expect(within(main).getByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。")).toBeTruthy();
    await user.click(refresh);
    await waitFor(() => expect(within(main).queryByText("重试仍不可用")).toBeNull());
  }
  await waitFor(() => expect(within(main).queryByText("正在刷新消息，列表仍为上次读取结果。")).toBeNull());
  expect(within(main).queryByText("消息刷新失败，仍显示上次读取的消息。请重试刷新。")).toBeNull();
  expect(within(main).getByText("暂无消息")).toBeTruthy();
  expect(reads).toBe(retryStatus === 200 ? 3 : 4);
  expect(unexpected).toEqual([]);
});

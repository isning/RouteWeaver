// @vitest-environment jsdom
// Controlled public-page/API-boundary coverage, not external delivery evidence.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";

const clients: QueryClient[] = [];
const deliveryFailure = "channel delivery failed; verify destination, credentials and TLS, then test again";
const exhausted = "delivery attempts exhausted; receiver acceptance may be unknown";
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function record(overrides: Record<string, unknown>) {
  return {
    eventId: "history-item", kind: "test", title: "邮件渠道测试", channel: "email",
    status: "retrying", attempts: 1, createdAt: "2026-11-07T10:00:00Z",
    nextAttemptAt: "2026-11-07T10:01:00Z", lastError: deliveryFailure,
    ...overrides,
  };
}
async function openHistory(records: unknown[], refresh?: () => Promise<Response>) {
  let historyReads = 0;
  const unexpected: string[] = [];
  const responses: Record<string, unknown> = {
    "/api/state": { users: [] },
    "/api/admin/announcements": [],
    "/api/admin/notifications/outbox": records,
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method && init.method !== "GET") || !Object.hasOwn(responses, url)) {
      unexpected.push(`${init?.method || "GET"} ${url}`);
      throw new Error("Unexpected controlled outbox request");
    }
    if (url === "/api/admin/notifications/outbox" && historyReads++ > 0 && refresh) return refresh();
    return json(responses[url]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><NotificationsAdminPage /></UIProviders></QueryClientProvider>);
  await userEvent.click(screen.getByRole("tab", { name: "发送记录" }));
  await screen.findByRole("columnheader", { name: "通知" });
  return unexpected;
}
function item(title: string) {
  const cell = screen.getByText(title, { exact: true }).closest("td");
  expect(cell).not.toBeNull();
  return within(cell!);
}

it("keeps notification, channel, retry time and recovery together without promising receiver acceptance", async () => {
  const unexpected = await openHistory([record({})]);
  const context = item("邮件渠道测试");
  expect(context.getByText("邮件", { exact: true })).toBeTruthy();
  expect(context.getByText("等待重试", { exact: true })).toBeTruthy();
  expect(context.getByText(/下次尝试不早于/)).toBeTruthy();
  const time = context.getByText("2026/11/07 18:01（北京时间）");
  expect(time.getAttribute("datetime")).toBe("2026-11-07T10:01:00Z");
  expect(context.getByText("接收方是否已接收尚未确认。")).toBeTruthy();
  expect(context.getByText("请在“提醒与渠道”检查该渠道的目标地址、凭据和 TLS 设置。")).toBeTruthy();
  const detail = context.getByText("技术详情", { exact: true }).closest("details");
  expect(detail?.open).toBe(false);
  expect(detail?.textContent).toContain(deliveryFailure);
  expect(screen.getByRole("columnheader", { name: "创建时间（北京时间）" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /发送.*测试|重试/ })).toBeNull();
  expect(unexpected).toEqual([]);
});

it.each([undefined, "0001-01-01T00:00:00Z", "invalid-date"])("does not invent a retry deadline for %s", async (nextAttemptAt) => {
  const unexpected = await openHistory([record({ nextAttemptAt })]);
  const context = item("邮件渠道测试");
  expect(context.getByText("等待重试", { exact: true })).toBeTruthy();
  expect(context.getByText("下次尝试时间未提供。")).toBeTruthy();
  expect(context.queryByText(/下次尝试不早于|北京时间/)).toBeNull();
  expect(unexpected).toEqual([]);
});

it("distinguishes queued, active, accepted, available and terminal records while ignoring stale deadlines", async () => {
  const unexpected = await openHistory([
    record({ eventId: "queued", title: "待发送通知", status: "queued", attempts: 0, lastError: undefined }),
    record({ eventId: "sending", title: "正在重试通知", status: "sending", attempts: 2 }),
    record({ eventId: "accepted", title: "渠道接收通知", status: "accepted", attempts: 2, lastError: undefined }),
    record({ eventId: "available", title: "站内通知", channel: "in-app", status: "available", lastError: undefined }),
    record({ eventId: "exhausted", title: "已用尽尝试通知", status: "failed", attempts: 5, lastError: exhausted }),
    record({ eventId: "failed", title: "最后尝试失败通知", status: "failed", attempts: 5 }),
    record({ eventId: "cancelled", title: "条件失效通知", channel: "in-app", status: "cancelled", attempts: 0, lastError: "recipient or validity is no longer eligible" }),
    record({ eventId: "changed", title: "渠道变更通知", status: "cancelled", attempts: 0, lastError: "channel settings or authorization changed; create a new explicit test" }),
  ]);
  expect(item("待发送通知").getByText("等待发送", { exact: true })).toBeTruthy();
  expect(item("待发送通知").getByText("2026/11/07 18:01（北京时间）")).toBeTruthy();
  expect(item("正在重试通知").getByText("发送中", { exact: true })).toBeTruthy();
  expect(item("正在重试通知").getByText("接收结果尚未确认。")).toBeTruthy();
  // A sending retry retains its previous error, not a new current failure.
  expect(item("正在重试通知").queryByText(/检查该渠道的目标地址/)).toBeNull();
  expect(item("渠道接收通知").getByText("渠道已接收", { exact: true })).toBeTruthy();
  expect(item("站内通知").getByText("站内已可读", { exact: true })).toBeTruthy();
  for (const title of ["已用尽尝试通知", "最后尝试失败通知"]) {
    expect(item(title).getByText("发送失败", { exact: true })).toBeTruthy();
    expect(item(title).getByText("已停止自动重试。接收方是否已接收尚未确认。")).toBeTruthy();
  }
  expect(item("已用尽尝试通知").getByText("请先核对接收方记录，再决定是否在“提醒与渠道”发送新的测试。")).toBeTruthy();
  expect(item("最后尝试失败通知").getByText("请在“提醒与渠道”检查该渠道的目标地址、凭据和 TLS 设置。")).toBeTruthy();
  expect(item("条件失效通知").getByText("接收对象或有效期已不符合发送条件。请核对通知的接收对象与有效期。")).toBeTruthy();
  expect(item("渠道变更通知").getByText("渠道设置或发送许可已变更。请在“提醒与渠道”核对设置，需要验证时另行发送测试。")).toBeTruthy();
  for (const title of ["正在重试通知", "渠道接收通知", "站内通知", "已用尽尝试通知", "最后尝试失败通知", "条件失效通知", "渠道变更通知"]) {
    expect(item(title).queryByText(/下次尝试|18:01/)).toBeNull();
  }
  expect(screen.queryByText(/已送达|收件人已读/)).toBeNull();
  expect(screen.getByText("渠道接收不等于收件人已经阅读。")).toBeTruthy();
  expect(unexpected).toEqual([]);
});

it("keeps unknown reasons and statuses honest with original technical detail instead of guessing a known channel", async () => {
  const unexpected = await openHistory([
    record({ title: "未知原因通知", status: "failed", attempts: 5, lastError: "constructor" }),
    record({ eventId: "unknown", title: "未知状态通知", channel: "push", status: "constructor", lastError: "unexpected delivery classification" }),
    record({ eventId: "no-reason", title: "原因缺失通知", status: "failed", attempts: 5, lastError: undefined }),
  ]);
  const failure = item("未知原因通知");
  expect(failure.getByText("原因尚未识别，请查看技术详情。")).toBeTruthy();
  const detail = failure.getByText("技术详情", { exact: true }).closest("details");
  expect(detail?.open).toBe(false);
  expect(within(detail!).getByText("constructor", { exact: true })).toBeTruthy();
  const unknown = item("未知状态通知");
  expect(unknown.getByText("push", { exact: true })).toBeTruthy();
  expect(unknown.queryByText("Webhook", { exact: true })).toBeNull();
  expect(unknown.getByText("未知状态", { exact: true })).toBeTruthy();
  expect(unknown.getByText("请刷新记录并查看技术详情。")).toBeTruthy();
  expect(unknown.queryByText("原因尚未识别，请查看技术详情。")).toBeNull();
  expect(unknown.queryByText(/下次尝试|已停止自动重试/)).toBeNull();
  expect(item("原因缺失通知").getByText("服务端未提供原因，请核对该通知与渠道的记录。")).toBeTruthy();
  expect(item("原因缺失通知").queryByText("技术详情", { exact: true })).toBeNull();
  expect(unexpected).toEqual([]);
});


it("refreshes records read-only with pending feedback and keeps open details through failure and recovery", async () => {
  let settle!: (response: Response) => void;
  const refresh = vi.fn(() => new Promise<Response>((resolve) => { settle = resolve; }));
  const unexpected = await openHistory([record({})], refresh);
  const detail = item("邮件渠道测试").getByText("技术详情", { exact: true }).closest("details")!;
  await userEvent.click(within(detail).getByText("技术详情", { exact: true }));
  expect(detail.open).toBe(true);
  const button = screen.getByRole("button", { name: "刷新记录" });
  await userEvent.click(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("status").textContent).toContain("正在刷新记录");
  expect(detail.isConnected && detail.open).toBe(true);
  await userEvent.click(button);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => settle(new Response("unavailable", { status: 503 })));
  expect(await screen.findByText("未能刷新发送记录，仍显示上次读取的记录。请重试刷新。")).toBeTruthy();
  expect(detail.isConnected && detail.open).toBe(true);
  expect(item("邮件渠道测试").getByText("等待重试", { exact: true })).toBeTruthy();
  expect(screen.queryByText("暂无发送记录")).toBeNull();
  await userEvent.click(button);
  await act(async () => settle(json([record({ attempts: 2 })])));
  await waitFor(() => expect(button.getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByText(/未能刷新发送记录/)).toBeNull();
  expect(detail.isConnected && detail.open).toBe(true);
  expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(unexpected).toEqual([]);
  expect(screen.queryByRole("button", { name: /发送.*测试|标为已读/ })).toBeNull();
});


it("keeps a cached refresh visibly waiting offline and resumes one read on reconnect", async () => {
  let settle!: (response: Response) => void;
  const refresh = vi.fn(() => new Promise<Response>((resolve) => { settle = resolve; }));
  const unexpected = await openHistory([record({})], refresh);
  const detail = item("邮件渠道测试").getByText("技术详情", { exact: true }).closest("details")!;
  await userEvent.click(within(detail).getByText("技术详情", { exact: true }));
  act(() => onlineManager.setOnline(false));
  const button = screen.getByRole("button", { name: "刷新记录" });
  await userEvent.click(button);
  expect(await screen.findByText("等待网络连接，恢复后将刷新记录。仍显示上次读取的记录。")).toBeTruthy();
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(detail.isConnected && detail.open).toBe(true);
  await userEvent.click(button);
  expect(refresh).not.toHaveBeenCalled();
  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/等待网络连接，恢复后将刷新记录/)).toBeNull();
  expect(detail.isConnected && detail.open).toBe(true);
  await act(async () => settle(json([record({ attempts: 2 })])));
  await waitFor(() => expect(button.getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
  expect(detail.isConnected && detail.open).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(unexpected).toEqual([]);
});

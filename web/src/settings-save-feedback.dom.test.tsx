// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast, Toaster } from "sonner";
import { AdminPage } from "./Admin";
import { ConfirmationProvider } from "./ui-patterns/confirmations";

const clients: QueryClient[] = [];
const noticeIDs: Array<string | number> = [];
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});
const activeNotices = () => toast.getToasts().map((notice) => "title" in notice ? notice.title : undefined);
beforeEach(() => {
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => computed(element));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  noticeIDs.splice(0).forEach((id) => toast.dismiss(id));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps settings successes inline through the next edit and activation decision without retiring unrelated nonexpiring notices", async () => {
  let settings = { name: "原平台", timezone: "UTC+8", registration: "invite" };
  let origin = {
    revision: 1, configuredRevision: 1, effectiveRevision: 1,
    draftOrigin: "https://old.example", effectiveOrigin: "https://old.example", defaultOrigin: "",
    verificationStatus: "verified", tokensUnchanged: true,
    currentLinkExample: "https://old.example/feed/{existing-token}",
    proposedLinkExample: "https://old.example/feed/{existing-token}",
    activatedAt: "2026-01-01T00:00:00Z",
  };
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== "GET") {
      writes.push(`${init.method} ${path}`);
      if (path === "/api/settings") {
        settings = JSON.parse(String(init.body));
        return json(settings);
      }
      if (path === "/api/admin/subscription-origin") {
        const draftOrigin = JSON.parse(String(init.body)).origin;
        origin = { ...origin, revision: origin.revision + 1, configuredRevision: origin.revision + 1,
          draftOrigin, proposedLinkExample: `${draftOrigin}/feed/{existing-token}`, verificationStatus: "unverified" };
      } else if (path.endsWith("/verify")) {
        origin = { ...origin, revision: origin.revision + 1, verificationStatus: "verified" };
      } else if (path.endsWith("/activate")) {
        origin = { ...origin, revision: origin.revision + 1, effectiveRevision: origin.configuredRevision,
          effectiveOrigin: origin.draftOrigin, currentLinkExample: origin.proposedLinkExample,
          activatedAt: "2026-01-02T00:00:00Z" };
      } else throw new Error(`Unexpected write: ${path}`);
      return json(origin);
    }
    if (path === "/api/settings") return json(settings);
    if (path === "/api/admin/subscription-origin") return json(origin);
    if (path === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [] });
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>
    <ConfirmationProvider><AdminPage page="settings" /></ConfirmationProvider>
    {/* Success cannot disappear merely because a timer expired. */}
    <Toaster duration={Infinity} expand />
  </QueryClientProvider>);
  const undo = vi.fn();
  act(() => {
    noticeIDs.push(toast.error("其他任务连接失败", { duration: Infinity }));
    noticeIDs.push(toast.success("其他任务已停用", { duration: Infinity, action: { label: "撤销其他任务", onClick: undo } }));
  });
  const user = userEvent.setup();
  const form = within(await screen.findByRole("form", { name: "平台基本设置" }));
  await user.click(form.getByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(form.getByRole("textbox", { name: "平台名称" }), { target: { value: "已保存的平台" } });
  await user.click(form.getByRole("button", { name: "保存设置" }));
  expect((await form.findByRole("status")).textContent).toBe("平台设置已保存");
  expect(activeNotices()).not.toContain("平台设置已保存");
  await user.click(form.getByRole("button", { name: "编辑平台名称" }));
  expect(form.queryByRole("status")).toBeNull();
  await user.click(form.getByRole("button", { name: "取消名称修改" }));
  expect(form.getByText("已保存的平台", { exact: true })).toBeTruthy();

  const domain = screen.getByLabelText("订阅域名草稿");
  const section = within(screen.getByRole("region", { name: "订阅域名设置" }));
  fireEvent.change(domain, { target: { value: "https://new.example" } });
  await user.click(section.getByRole("button", { name: "保存域名草稿" }));
  expect((await section.findByRole("status")).textContent).toBe("域名草稿已保存，当前订阅地址未改变");
  expect(activeNotices()).not.toContain("域名草稿已保存，当前订阅地址未改变");
  expect(section.getByText("https://old.example/feed/{existing-token}")).toBeTruthy();
  fireEvent.change(domain, { target: { value: "https://later.example" } });
  expect(section.queryByRole("status")).toBeNull();
  fireEvent.change(domain, { target: { value: "https://new.example" } });
  await user.click(section.getByRole("button", { name: "验证 HTTPS 与实例" }));
  expect((await section.findByRole("status")).textContent).toBe("已验证 HTTPS 地址属于当前实例");
  expect(activeNotices()).not.toContain("已验证 HTTPS 地址属于当前实例");
  await user.click(section.getByRole("button", { name: "启用已保存草稿" }));
  const review = within(await screen.findByRole("dialog", { name: "启用订阅地址" }));
  expect(section.queryByRole("status", { hidden: true })).toBeNull();
  expect(review.getByRole("button", { name: "确认启用" }).hasAttribute("disabled")).toBe(true);
  await user.click(review.getByRole("button", { name: "取消" }));
  expect(writes.filter((operation) => operation.endsWith("/activate"))).toEqual([]);
  await user.click(section.getByRole("button", { name: "启用已保存草稿" }));
  const reopened = within(await screen.findByRole("dialog", { name: "启用订阅地址" }));
  await user.click(reopened.getByRole("checkbox", { name: "我已确认域名配置与旧链接的访问安排" }));
  await user.click(reopened.getByRole("button", { name: "确认启用" }));
  expect((await section.findByRole("status")).textContent).toBe("新复制的订阅链接将使用所选地址");
  expect(activeNotices()).not.toContain("新复制的订阅链接将使用所选地址");
  expect(origin.effectiveOrigin).toBe("https://new.example");
  expect(activeNotices()).toContain("其他任务连接失败");
  expect(activeNotices()).toContain("其他任务已停用");
  expect(undo).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "撤销其他任务" }));
  expect(undo).toHaveBeenCalledOnce();
});

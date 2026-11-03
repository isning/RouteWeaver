// @vitest-environment jsdom
// Public UI tasks with fetch fixtures: decision help and preserved consequences.
// DOM structure is not rendered spacing or comprehension evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AccountSecurityPage } from "./AccountSecurity";
import { BackupSettings } from "./Backup";
import { InboxPage, NotificationsAdminPage } from "./Notifications";
import type { ReactNode } from "react";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});
let client: QueryClient;
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function mount(children: ReactNode) {
  return render(<QueryClientProvider client={client}><UIProviders>{children}</UIProviders></QueryClientProvider>);
}
function describedBy(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") || "").split(" ")
    .map(id => document.getElementById(id)?.textContent || "").join(" ");
}

it("explains the password byte constraint before submission without hiding session consequences", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  mount(<AccountSecurityPage session={{ user: { id: "person", name: "Person", role: "user" }, csrfToken: "fixture" }} onSessionChanged={() => {}} onSignedOut={() => {}} />);
  expect(describedBy(screen.getByLabelText("新密码"))).toContain("使用 12–72 个 UTF-8 字节；中文通常每字占 3 字节。");
  expect(screen.getByRole("button", { name: "修改密码" })).toBeTruthy();
  expect(screen.getByText("修改后保留当前会话，其他会话立即失效。已下载的连接凭据不会因此从节点撤销。")).toBeTruthy();
});

it("discloses backup upload at inspection and credential loss at creation, without uploading on selection", () => {
  const fetch = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetch);
  mount(<BackupSettings />);
  fireEvent.change(screen.getByLabelText("选择加密备份"), { target: { files: [new File(["fixture"], "sample.age")] } });
  expect(fetch).not.toHaveBeenCalled();
  expect(describedBy(screen.getByRole("button", { name: "校验备份并查看影响" })))
    .toContain("选择文件不会上传；校验时会将备份文件和密码发送到当前控制平面。");
  expect(screen.getByText("恢复到新数据库，不覆盖当前数据，也不会自动切换服务。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "创建加密备份" }));
  const dialog = screen.getByRole("dialog", { name: "创建加密备份" });
  expect(within(dialog).getByText("备份包含账号与订阅凭据，仅下载到你的设备，不发送到第三方。请将文件与密码分开保管；忘记密码无法恢复。")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "加密并下载" })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("groups backup creation and recovery in one named task region", () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({})));
  mount(<BackupSettings />);
  const region = screen.getByRole("region", { name: "备份与恢复" });
  expect(within(region).getByRole("heading", { name: "完整加密备份" })).toBeTruthy();
  expect(within(region).getByRole("heading", { name: "恢复备份" })).toBeTruthy();
  expect(within(region).getByRole("button", { name: "检查历史容量" })).toBeTruthy();
});

it("explains SMTP encryption where it is selected and keeps automatic-send scope visible", async () => {
  vi.stubGlobal("fetch", vi.fn(async url => {
    if (String(url).endsWith("/notification-settings")) return json({
      revision: 1, inApp: true, quotaPercent: [80], expiryHours: [24], providerRemainingPercent: [20], repeatHours: 24,
      email: { enabled: false, automatic: false, host: "smtp.example", port: 587, tlsMode: "starttls", username: "", from: "sender@example.test", to: [] },
      webhook: { enabled: false, automatic: false, url: "" }, smtpPasswordSet: false, webhookSecretSet: false,
    });
    return json(String(url).endsWith("/state") ? { users: [] } : []);
  }));
  mount(<NotificationsAdminPage />);
  const tab = screen.getByRole("tab", { name: "提醒与渠道" });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false }); fireEvent.click(tab);
  fireEvent.click(await screen.findByRole("button", { name: "邮件通知" }));
  expect(describedBy(screen.getByRole("combobox", { name: "传输安全" })))
    .toContain("STARTTLS 在连接后升级为加密；TLS 从连接开始加密。请按邮件服务商要求选择。");
  expect(screen.getByLabelText("允许自动发送管理员供应商提醒邮件")).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存通知设置" })).toBeTruthy();
});

it("keeps inbox content and refresh without a redundant outer card", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([{
    eventId: "fixture", title: "服务提醒", body: "维护安排。", createdAt: "2026-11-02T00:00:00Z",
  }])));
  mount(<InboxPage />);
  const message = await screen.findByRole("button", { name: /服务提醒.*未读/ });
  expect(message.textContent).toContain("维护安排。");
  expect(message.closest('[data-slot="card"]')).toBeNull();
  expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
});

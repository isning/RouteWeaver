// @vitest-environment jsdom
// Public form task -> HTTP payload. External delivery is intentionally not exercised.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
import { hasUnsavedChanges } from "./navigation";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 768,
  });
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});
const initial = {
  revision: 1,
  inApp: true,
  quotaPercent: [80],
  expiryHours: [24],
  providerRemainingPercent: [20],
  repeatHours: 24,
  email: {
    enabled: false,
    automatic: false,
    host: "smtp.example",
    port: 587,
    tlsMode: "starttls",
    username: "old-user",
    from: "old@example.test",
    to: ["recipient@example.test"],
  },
  webhook: { enabled: true, automatic: false, url: "https://old.example" },
  smtpPasswordSet: true,
  webhookSecretSet: true,
};
async function mount(failFirst = false) {
  const sent: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/notification-settings")) {
        if (init?.method === "PUT") {
          const value = JSON.parse(init.body);
          sent.push(value);
          if (failFirst && sent.length === 1)
            return json({ detail: "设置未保存，请重试" }, 503);
          return json({ ...initial, ...value, revision: 2 });
        }
        return json(initial);
      }
      if (String(url).endsWith("/notifications/test"))
        return json({ status: "queued" });
      return json(String(url).endsWith("/state") ? { users: [] } : []);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <NotificationsAdminPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  tab("提醒与渠道");
  await screen.findByRole("button", { name: "Webhook 通知" });
  return sent;
}
function tab(name: string) {
  const target = screen.getByRole("tab", { name });
  fireEvent.mouseDown(target, { button: 0, ctrlKey: false });
  fireEvent.click(target);
}
function change(name: string, value: string) {
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
}
function toggle(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "保存通知设置" }));
}
function describedBy(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") || "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent || "")
    .join(" ");
}
it("explains expiry reminder time buckets without promising a minimum interval or changing quota thresholds", async () => {
  const sent = await mount();
  const repeat = screen.getByLabelText("到期提醒重复周期（小时）");
  expect(describedBy(repeat)).toContain(
    "按距到期时间划分时段，同一提醒阈值每段最多生成一次；额度提醒沿用原设置。",
  );
  expect(screen.queryByLabelText("同类提醒最短间隔（小时）")).toBeNull();
  fireEvent.change(repeat, { target: { value: "12" } });
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].repeatHours).toBe(12);
  expect(sent[0].quotaPercent).toEqual(initial.quotaPercent);
  expect(sent[0].providerRemainingPercent).toEqual(
    initial.providerRemainingPercent,
  );
});
it("keeps threshold audiences and the in-app reminder scope beside their controls", async () => {
  const sent = await mount();
  expect(describedBy(screen.getByLabelText("已用额度提醒阈值（%）"))).toContain(
    "账号已用流量达到任一比例时提醒本人；每个计费周期、每个阈值生成一次。",
  );
  expect(describedBy(screen.getByLabelText("到期前提醒（小时）"))).toContain(
    "账号服务和供应商资源共用这些提前量；剩余时间进入范围后生成提醒。",
  );
  expect(describedBy(screen.getByLabelText("供应商剩余配额提醒（%）"))).toContain(
    "供应商剩余额度降至任一比例时提醒管理员。",
  );
  expect(screen.getByText("每类可设置多个阈值；清空即关闭该类提醒。")).toBeTruthy();
  const inApp = screen.getByRole("switch", { name: "站内提醒" });
  expect(describedBy(inApp)).toContain(
    "控制新生成的账号和供应商站内提醒；公告展示与手动测试照常可用。",
  );
  fireEvent.click(inApp);
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].inApp).toBe(false);
  expect(sent[0].email).toEqual(initial.email);
  expect(sent[0].webhook).toEqual(initial.webhook);
});
it("explains channel activation and destination requirements without exposing stored secrets", async () => {
  const sent = await mount();
  toggle("邮件通知");
  expect(describedBy(screen.getByLabelText("启用邮件渠道"))).toContain(
    "启用并保存后可发送测试；自动提醒由下方选项控制。",
  );
  expect(describedBy(screen.getByLabelText("允许自动发送管理员供应商提醒邮件"))).toContain(
    "勾选并保存后，供应商配额和到期提醒将自动发送至配置的收件地址。",
  );
  expect(describedBy(screen.getByLabelText("SMTP 主机"))).toContain(
    "填写邮件服务商提供的公网 SMTP 主机，不含协议或端口。",
  );
  expect(describedBy(screen.getByLabelText("用户名"))).toContain(
    "需要登录时填写；启用渠道时，填写用户名还须提供密码。",
  );
  expect(describedBy(screen.getByLabelText("收件地址"))).toContain(
    "管理员提醒与邮件测试发送到这些地址，最多 10 个。",
  );
  expect(
    (screen.getByLabelText("更新 SMTP 密码（留空保留已保存值）") as HTMLInputElement).value,
  ).toBe("");
  toggle("Webhook 通知");
  expect(describedBy(screen.getByLabelText("启用 Webhook 渠道"))).toContain(
    "启用并保存后可发送测试；自动提醒由下方选项控制。",
  );
  expect(describedBy(screen.getByLabelText("允许自动发送管理员供应商提醒 Webhook"))).toContain(
    "勾选并保存后，供应商配额和到期提醒将自动发送至配置的 Webhook。",
  );
  expect(describedBy(screen.getByLabelText("HTTPS Webhook 地址"))).toContain(
    "填写公网 HTTPS 接收地址，不含查询参数、片段或登录信息。",
  );
  const secret = screen.getByLabelText(
    "更新签名密钥（留空保留已保存值）",
  ) as HTMLInputElement;
  expect(describedBy(secret)).toContain("启用时至少 32 字节，用于接收方验证通知签名。");
  expect(secret.value).toBe("");
  expect(sent).toHaveLength(0);
});
it("discloses queued-send cancellation at Save while test confirmation uses the saved destination", async () => {
  const sent = await mount();
  const saveButton = screen.getByRole("button", { name: "保存通知设置" });
  expect(describedBy(saveButton)).toContain(
    "保存会取消此前排队或等待重试的外部发送；已开始发送的请求仍可能完成。",
  );
  toggle("Webhook 通知");
  change("HTTPS Webhook 地址", "https://draft.example");
  const testsSent = () =>
    vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      String(url).endsWith("/notifications/test") && init?.method === "POST",
    );
  fireEvent.click(screen.getByRole("button", { name: "发送 Webhook 测试" }));
  let confirmation = screen.getByRole("alertdialog", {
    name: "发送一条测试通知？",
  });
  expect(within(confirmation).getByText(
    "将向已保存的 Webhook https://old.example 发送测试内容。",
  )).toBeTruthy();
  expect(testsSent()).toHaveLength(0);
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect(testsSent()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "发送 Webhook 测试" }));
  confirmation = screen.getByRole("alertdialog", { name: "发送一条测试通知？" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "发送测试" }));
  await waitFor(() => expect(testsSent()).toHaveLength(1));
  expect(JSON.parse(String(testsSent()[0][1]?.body))).toEqual({ channel: "webhook" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].webhook.url).toBe("https://draft.example");
  expect(testsSent()).toHaveLength(1);
});
it("collapsing edited notification channel retains its submitted values", async () => {
  const sent = await mount();
  toggle("Webhook 通知");
  change("HTTPS Webhook 地址", "https://new.example");
  toggle("Webhook 通知");
  expect(
    screen
      .getByRole("button", { name: "Webhook 通知" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].webhook.url).toBe("https://new.example");
});
it("preserves never-opened channels without sending replacement secrets", async () => {
  const sent = await mount();
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].email).toEqual(initial.email);
  expect(sent[0].webhook).toEqual(initial.webhook);
  expect(sent[0]).not.toHaveProperty("smtpPassword");
  expect(sent[0]).not.toHaveProperty("webhookSecret");
  expect(sent[0]).not.toHaveProperty("smtpPasswordSet");
  expect(sent[0]).not.toHaveProperty("webhookSecretSet");
});
it("retains SMTP and webhook drafts, toggles and replacement secrets across collapse, tabs and a failed save", async () => {
  const sent = await mount(true);
  toggle("邮件通知");
  change("SMTP 主机", "new.smtp.example");
  change("用户名", "new-user");
  change("发件地址", "new@example.test");
  change("更新 SMTP 密码（留空保留已保存值）", "synthetic-new-smtp-secret");
  fireEvent.click(screen.getByLabelText("启用邮件渠道"));
  fireEvent.click(screen.getByLabelText("允许自动发送管理员供应商提醒邮件"));
  toggle("邮件通知");
  toggle("Webhook 通知");
  change("HTTPS Webhook 地址", "https://new.example");
  change("更新签名密钥（留空保留已保存值）", "synthetic-new-hook-secret");
  fireEvent.click(
    screen.getByLabelText("允许自动发送管理员供应商提醒 Webhook"),
  );
  toggle("Webhook 通知");
  tab("发送记录");
  tab("提醒与渠道");
  save();
  await screen.findByText("设置未保存，请重试");
  expect(hasUnsavedChanges()).toBe(true);
  toggle("邮件通知");
  expect((screen.getByLabelText("SMTP 主机") as HTMLInputElement).value).toBe(
    "new.smtp.example",
  );
  toggle("邮件通知");
  save();
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1].email).toEqual({
    ...initial.email,
    enabled: true,
    automatic: true,
    host: "new.smtp.example",
    username: "new-user",
    from: "new@example.test",
  });
  expect(sent[1].webhook).toEqual({
    ...initial.webhook,
    automatic: true,
    url: "https://new.example",
  });
  expect(sent[1].smtpPassword).toBe("synthetic-new-smtp-secret");
  expect(sent[1].webhookSecret).toBe("synthetic-new-hook-secret");
  await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
  expect(
    (
      screen.getByLabelText(
        "更新 SMTP 密码（留空保留已保存值）",
      ) as HTMLInputElement
    ).value,
  ).toBe("");
});
it("retains explicit secret removal after collapsing both channels", async () => {
  const sent = await mount();
  toggle("邮件通知");
  fireEvent.click(screen.getByLabelText("清除已保存的 SMTP 密码"));
  toggle("邮件通知");
  toggle("Webhook 通知");
  fireEvent.click(screen.getByLabelText("清除已保存的签名密钥"));
  toggle("Webhook 通知");
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].smtpPassword).toBe("");
  expect(sent[0].webhookSecret).toBe("");
});

it("keeps announcement fields in the sequential task scroll when viewport capacity is insufficient", async () => {
  await mount();
  tab("公告");
  fireEvent.click(
    await screen.findByRole("button", { name: "创建公告" }),
  );
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 200,
  });
  fireEvent(window, new Event("resize"));
  await waitFor(() =>
    expect(screen.getByRole("dialog").getAttribute("data-task-scroll")).toBe(
      "task",
    ),
  );
});

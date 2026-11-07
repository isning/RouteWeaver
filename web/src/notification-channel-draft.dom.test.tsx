// @vitest-environment jsdom
// Public form task -> HTTP payload. External delivery is intentionally not exercised.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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
async function mount(failFirst = false, firstSave?: Promise<void>, testFailure?: string) {
  const sent: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/notification-settings")) {
        if (init?.method === "PUT") {
          const value = JSON.parse(init.body);
          sent.push(value);
          if (firstSave && sent.length === 1) await firstSave;
          if (failFirst && sent.length === 1)
            return json({ detail: "设置未保存，请重试" }, 503);
          return json({ ...initial, ...value, revision: 2 });
        }
        return json(initial);
      }
      if (String(url).endsWith("/notifications/test"))
        return testFailure ? json({ detail: testFailure }, 503) : json({ status: "queued" });
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

it.each([
  ["邮件通知", "更新 SMTP 密码（留空保留已保存值）", "清除已保存的 SMTP 密码", "smtpPassword", "请选择更新或清除 SMTP 密码，不能同时操作。"],
  ["Webhook 通知", "更新签名密钥（留空保留已保存值）", "清除已保存的签名密钥", "webhookSecret", "请选择更新或清除签名密钥，不能同时操作。"],
] as const)("requires an explicit replace-or-clear choice for %s without losing the draft", async (channel, label, clearLabel, field, error) => {
  const sent = await mount();
  toggle(channel);
  change(label, "synthetic-replacement-secret-for-choice");
  fireEvent.click(screen.getByLabelText(clearLabel));
  toggle(channel);
  screen.getByRole("button", { name: "保存通知设置" }).focus();
  save();
  await screen.findByText(error);
  await waitFor(() => expect(document.activeElement === screen.getByLabelText(clearLabel)).toBe(true));
  expect(sent).toHaveLength(0);
  expect(hasUnsavedChanges()).toBe(true);
  expect(screen.getByRole("button", { name: channel }).getAttribute("aria-expanded")).toBe("true");
  expect((screen.getByLabelText(label) as HTMLInputElement).value === "synthetic-replacement-secret-for-choice").toBe(true);
  expect(screen.getByLabelText(clearLabel).getAttribute("aria-checked")).toBe("true");
  expect(describedBy(screen.getByLabelText(clearLabel))).toContain(error);
  fireEvent.click(screen.getByLabelText(clearLabel));
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0][field] === "synthetic-replacement-secret-for-choice").toBe(true);
});

it.each([
  ["邮件通知", "更新 SMTP 密码（留空保留已保存值）", "清除已保存的 SMTP 密码", "smtpPassword", "请选择更新或清除 SMTP 密码，不能同时操作。"],
  ["Webhook 通知", "更新签名密钥（留空保留已保存值）", "清除已保存的签名密钥", "webhookSecret", "请选择更新或清除签名密钥，不能同时操作。"],
] as const)("can choose explicit removal after correcting conflicting %s replacement", async (channel, label, clearLabel, field, error) => {
  const sent = await mount();
  toggle(channel);
  change(label, "synthetic-replacement-secret-for-choice");
  fireEvent.click(screen.getByLabelText(clearLabel));
  save();
  await screen.findByText(error);
  expect(sent).toHaveLength(0);
  change(label, "");
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0][field]).toBe("");
});

it("does not steal newer focus when secret-choice validation settles", async () => {
  const sent = await mount();
  toggle("邮件通知");
  change("更新 SMTP 密码（留空保留已保存值）", "synthetic-replacement-secret-for-choice");
  fireEvent.click(screen.getByLabelText("清除已保存的 SMTP 密码"));
  toggle("邮件通知");
  screen.getByRole("button", { name: "保存通知设置" }).focus();
  save();
  const newer = screen.getByRole("tab", { name: "发送记录" });
  newer.focus();
  await screen.findByText("请选择更新或清除 SMTP 密码，不能同时操作。");
  expect(document.activeElement === newer).toBe(true);
  expect(sent).toHaveLength(0);
});

it.each([false, true])("reveals a conflicting choice after expansion only if submission focus is still owned (interrupted: %s)", async (interrupted) => {
  const sent = await mount();
  toggle("Webhook 通知");
  change("更新签名密钥（留空保留已保存值）", "synthetic-replacement-secret-for-choice");
  const clear = screen.getByLabelText("清除已保存的签名密钥");
  fireEvent.click(clear);
  toggle("Webhook 通知");
  let finish!: () => void;
  const animation = new Promise<void>((resolve) => { finish = resolve; });
  const content = clear.closest('[data-slot="accordion-content"]')!;
  const field = clear.closest('[role="group"]')!;
  const revealField = vi.fn();
  Object.defineProperty(field, "scrollIntoView", { configurable: true, value: revealField });
  let observed = false;
  // Control only browser animation/scroll boundaries; form validation remains real.
  Object.defineProperty(content, "getAnimations", { configurable: true, value: () => {
    observed = true;
    return [{ finished: animation }];
  } });
  const submit = screen.getByRole("button", { name: "保存通知设置" });
  try {
    submit.focus();
    save();
    await waitFor(() => expect(observed).toBe(true));
    expect(document.activeElement === submit).toBe(true);
    expect(revealField).not.toHaveBeenCalled();
    if (interrupted) {
      // Focus only: do not change tabs or initiate a test notification.
      screen.getByRole("button", { name: "发送站内测试" }).focus();
      submit.focus();
    }
    expect(screen.getByRole("tab", { name: "提醒与渠道" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "提醒与渠道" }).hidden).toBe(false);
    await act(async () => { finish(); await animation; });
    expect(document.activeElement === (interrupted ? submit : clear)).toBe(true);
    expect(revealField).toHaveBeenCalledTimes(interrupted ? 0 : 1);
    if (!interrupted) {
      expect(revealField).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
      expect(field.contains(screen.getByText("请选择更新或清除签名密钥，不能同时操作。"))).toBe(true);
      expect(field.contains(screen.getByText("清除已保存的签名密钥"))).toBe(true);
    }
    expect(sent).toHaveLength(0);
  } finally {
    finish();
  }
});

it.each(["owned", "newer-focus", "away-and-back"] as const)("keeps a held save failure at the Save decision without taking newer focus (%s)", async (ownership) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sent = await mount(true, gate);
  toggle("邮件通知");
  change("更新 SMTP 密码（留空保留已保存值）", "synthetic-retained-failure-secret");
  change("到期提醒重复周期（小时）", "12");
  const decision = screen.getByRole("group", { name: "保存通知设置" });
  const reveal = vi.fn();
  Object.defineProperty(decision, "scrollIntoView", { configurable: true, value: reveal });
  const submit = screen.getByRole("button", { name: "保存通知设置" });
  const newer = screen.getByRole("button", { name: "发送站内测试" });
  try {
    submit.focus();
    save();
    await waitFor(() => expect(sent.length).toBe(1));
    await waitFor(() => expect(submit.getAttribute("aria-disabled")).toBe("true"));
    expect(submit.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement === submit).toBe(true);
    // Both repeated activation and an in-flight form submission stay one write.
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    await act(async () => {});
    expect(sent.length).toBe(1);
    if (ownership !== "owned") newer.focus();
    if (ownership === "away-and-back") submit.focus();
    await act(async () => { release(); await gate; });
    await within(decision).findByText("设置未保存，请重试");
    expect(screen.getAllByText("设置未保存，请重试").length).toBe(1);
    expect(document.activeElement === (ownership === "newer-focus" ? newer : submit)).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(ownership === "owned" ? 1 : 0);
    expect((screen.getByLabelText("更新 SMTP 密码（留空保留已保存值）") as HTMLInputElement).value === "synthetic-retained-failure-secret").toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/notifications/test")).length).toBe(0);
    submit.focus();
    save();
    await waitFor(() => expect(sent.length).toBe(2));
    expect(JSON.stringify(sent[1]) === JSON.stringify(sent[0])).toBe(true);
    await waitFor(() => expect(within(decision).queryByText("设置未保存，请重试")).toBeNull());
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
  } finally {
    release();
  }
});

it("keeps a separate test-delivery failure when a settings save also fails", async () => {
  await mount(true, undefined, "站内测试未完成，请查看发送记录");
  fireEvent.click(screen.getByRole("button", { name: "发送站内测试" }));
  const review = screen.getByRole("alertdialog", { name: "发送一条测试通知？" });
  fireEvent.click(within(review).getByRole("button", { name: "发送测试" }));
  await within(review).findByText("站内测试未完成，请查看发送记录");
  fireEvent.click(within(review).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  change("到期提醒重复周期（小时）", "12");
  save();
  const decision = screen.getByRole("group", { name: "保存通知设置" });
  await within(decision).findByText("设置未保存，请重试");
  expect(screen.getByText("站内测试未完成，请查看发送记录")).toBeTruthy();
  expect(within(decision).queryByText("站内测试未完成，请查看发送记录")).toBeNull();
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

// Recovery source regressions: these have not been executed in the source-only workspace.
it.each([
  ["到期提醒重复周期（小时）", "1e"],
  ["到期提醒重复周期（小时）", ""],
  ["到期提醒重复周期（小时）", "24.00000000000000000001"],
  ["到期提醒重复周期（小时）", "0"],
  ["到期提醒重复周期（小时）", "721"],
  ["到期提醒重复周期（小时）", "0x18"],
  ["到期提醒重复周期（小时）", " 24 "],
  ["端口", "1e"],
  ["端口", ""],
  ["端口", "587.00000000000000001"],
  ["端口", "65536"],
  ["端口", "0"],
])("retains and blocks invalid exact %s draft %s before HTTP", async (label, raw) => {
  const sent = await mount();
  if (label === "端口") toggle("邮件通知");
  change(label, raw);
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.blur(screen.getByLabelText(label));
  if (label === "端口") toggle("邮件通知");
  tab("发送记录");
  tab("提醒与渠道");
  save();
  await screen.findByText(label === "端口" ? "请输入 1–65535 之间的整数" : "请输入 1–720 之间的整数");
  if (label === "端口")
    expect(screen.getByRole("button", { name: "邮件通知" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByLabelText(label)).toHaveProperty("value", raw);
  expect(sent).toHaveLength(0);
  change(label, label === "端口" ? "5.87e2" : "7.2e2");
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(label === "端口" ? sent[0].email.port : sent[0].repeatHours).toBe(label === "端口" ? 587 : 720);
  expect(sent[0].revision).toBe(1);
  expect(sent[0]).not.toHaveProperty("smtpPassword");
});

it("retries exact scalar payloads without losing secrets, revision or raw spelling", async () => {
  const sent = await mount(true);
  toggle("邮件通知");
  change("端口", "000587.0");
  change("到期提醒重复周期（小时）", "+2.4e1");
  change("更新 SMTP 密码（留空保留已保存值）", "synthetic-secret");
  toggle("邮件通知");
  save();
  await screen.findByText("设置未保存，请重试");
  toggle("邮件通知");
  expect(screen.getByLabelText("端口")).toHaveProperty("value", "000587.0");
  expect(screen.getByLabelText("到期提醒重复周期（小时）")).toHaveProperty("value", "+2.4e1");
  expect(hasUnsavedChanges()).toBe(true);
  save();
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[1]).toMatchObject({ repeatHours: 24, email: { port: 587 }, revision: 1, smtpPassword: "synthetic-secret" });
});

async function addThreshold(label: string, token: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.change(await screen.findByRole("combobox", { name: "搜索选项" }), { target: { value: token } });
  fireEvent.click(await screen.findByRole("option", { name: `添加“${token}”` }));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索选项" }), { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("combobox", { name: label }).getAttribute("aria-expanded")).toBe("false"));
}
it.each([
  ["已用额度提醒阈值（%）", "80.000000000000000001", 100],
  ["已用额度提醒阈值（%）", "8e1", 100],
  ["已用额度提醒阈值（%）", "0x10", 100],
  ["已用额度提醒阈值（%）", "1e", 100],
  ["已用额度提醒阈值（%）", "0", 100],
  ["已用额度提醒阈值（%）", "101", 100],
  ["到期前提醒（小时）", "8785", 8784],
  ["到期前提醒（小时）", "24.000000000000000001", 8784],
  ["供应商剩余配额提醒（%）", "2e1", 100],
  ["供应商剩余配额提醒（%）", "100.00000000000000001", 100],
] as const)("blocks invalid or numerically duplicate %s token %s", async (label, token, max) => {
  const sent = await mount();
  await addThreshold(label, token);
  save();
  await screen.findByText(`最多设置 10 个不重复的 1–${max} 整数阈值`);
  expect(sent).toHaveLength(0);
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: `移除 ${token}` }));
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].quotaPercent).toEqual([80]);
  expect(sent[0].expiryHours).toEqual([24]);
  expect(sent[0].providerRemainingPercent).toEqual([20]);
});
it("preserves selected order, exact integer spellings and empty-list disable semantics", async () => {
  const sent = await mount();
  await addThreshold("已用额度提醒阈值（%）", "1e2");
  await addThreshold("已用额度提醒阈值（%）", "01.0");
  await addThreshold("到期前提醒（小时）", "8784");
  fireEvent.click(screen.getByRole("button", { name: "移除 20" }));
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].quotaPercent).toEqual([80, 100, 1]);
  expect(sent[0].expiryHours).toEqual([24, 8784]);
  expect(sent[0].providerRemainingPercent).toEqual([]);
});
it("allows ten thresholds and blocks an eleventh without dropping any chip", async () => {
  const sent = await mount();
  for (let n = 1; n <= 10; n++) await addThreshold("已用额度提醒阈值（%）", String(n));
  save();
  await screen.findByText("最多设置 10 个不重复的 1–100 整数阈值");
  expect(sent).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "移除 10" }));
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].quotaPercent).toEqual([80, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
it("reveals a collapsed sender address error and preserves optional native email semantics", async () => {
  const sent = await mount();
  toggle("邮件通知");
  change("发件地址", "not-an-email");
  toggle("邮件通知");
  save();
  await screen.findByText("请输入有效的发件地址");
  expect(screen.getByRole("button", { name: "邮件通知" }).getAttribute("aria-expanded")).toBe("true");
  expect(sent).toHaveLength(0);
  change("发件地址", "");
  save();
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].email.from).toBe("");
});

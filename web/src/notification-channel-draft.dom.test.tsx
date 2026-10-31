// @vitest-environment jsdom
// Public form task -> HTTP payload. External delivery is intentionally not exercised.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  change("更新 SMTP 密码（已保存，留空不变）", "synthetic-new-smtp-secret");
  fireEvent.click(screen.getByLabelText("启用邮件渠道"));
  fireEvent.click(screen.getByLabelText("允许自动发送管理员供应商提醒邮件"));
  toggle("邮件通知");
  toggle("Webhook 通知");
  change("HTTPS Webhook 地址", "https://new.example");
  change("更新签名密钥（已保存，留空不变）", "synthetic-new-hook-secret");
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
        "更新 SMTP 密码（已保存，留空不变）",
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

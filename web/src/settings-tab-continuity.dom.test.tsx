// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
import { AdminPage } from "./Admin";
import { hasUnsavedChanges } from "./navigation";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
const settings = {
  revision: 3,
  inApp: true,
  quotaPercent: [80, 100],
  expiryHours: [24],
  providerRemainingPercent: [10],
  repeatHours: 24,
  email: {
    enabled: false,
    automatic: false,
    host: "smtp.example.invalid",
    port: 587,
    tlsMode: "starttls",
    username: "fixture",
    from: "ops@example.invalid",
    to: ["ops@example.invalid"],
  },
  webhook: { enabled: false, automatic: false, url: "" },
  smtpPasswordSet: true,
  webhookSecretSet: false,
};
it("keeps the notification draft and disclosure while viewing records, without saving or prompting", async () => {
  const writes: unknown[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method && init.method !== "GET") writes.push(init.body);
      reads.push(String(url));
      return json(
        String(url) === "/api/admin/notification-settings"
          ? settings
          : String(url) === "/api/state"
            ? { users: [], nodes: [], routes: [] }
            : [],
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <NotificationsAdminPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  expect(reads).not.toContain("/api/admin/notification-settings");
  await user.click(screen.getByRole("tab", { name: "提醒与渠道" }));
  await user.click(await screen.findByRole("button", { name: "邮件通知" }));
  fireEvent.change(screen.getByRole("textbox", { name: "SMTP 主机" }), {
    target: { value: "draft.example.invalid" },
  });
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(screen.getByRole("tab", { name: "发送记录" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "SMTP 主机" })).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(screen.getByRole("tab", { name: "提醒与渠道" }));
  expect(
    (
      screen.queryByRole("textbox", {
        name: "SMTP 主机",
      }) as HTMLInputElement | null
    )?.value,
  ).toBe("draft.example.invalid");
  expect(writes).toEqual([]);
});

it("keeps platform and subscription-domain drafts while visiting the backup section", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method && init.method !== "GET") writes.push(init.body);
      if (url === "/api/state")
        return json({ users: [], nodes: [], routes: [], revisions: [] });
      if (url === "/api/settings")
        return json({
          name: "RouteWeaver",
          timezone: "UTC+8",
          registration: "invite",
        });
      if (url === "/api/admin/subscription-origin")
        return json({
          revision: 1,
          configuredRevision: 1,
          draftOrigin: "",
          effectiveRevision: 1,
          effectiveOrigin: "",
          defaultOrigin: "",
          currentLinkExample: "/feed/{existing-token}",
          proposedLinkExample: "/feed/{existing-token}",
          verificationStatus: "not-required",
          tokensUnchanged: true,
        });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="settings" />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
  fireEvent.change(await screen.findByLabelText("平台名称"), {
    target: { value: "未保存的平台名称" },
  });
  fireEvent.change(await screen.findByLabelText("订阅域名草稿"), {
    target: { value: "https://draft.example.invalid" },
  });
  await user.click(screen.getByRole("tab", { name: "备份与恢复" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "平台名称" })).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(screen.getByRole("tab", { name: "基本设置" }));
  expect((screen.getByLabelText("平台名称") as HTMLInputElement).value).toBe(
    "未保存的平台名称",
  );
  expect(
    (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
  ).toBe("https://draft.example.invalid");
  expect(writes).toEqual([]);
});

it.each(["notification", "platform"] as const)(
  "retains the %s draft when a background read fails and recovers",
  async (kind) => {
    let fail = false;
    const requestPath =
      kind === "notification"
        ? "/api/admin/notification-settings"
        : "/api/settings";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === requestPath && fail)
          return new Response(JSON.stringify({ detail: "设置读取暂时失败" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        if (url === "/api/admin/notification-settings") return json(settings);
        if (url === "/api/state")
          return json({ users: [], nodes: [], routes: [], revisions: [] });
        if (url === "/api/settings")
          return json({
            name: "RouteWeaver",
            timezone: "UTC+8",
            registration: "invite",
          });
        if (url === "/api/admin/subscription-origin")
          return json({
            revision: 1,
            configuredRevision: 1,
            draftOrigin: "",
            effectiveRevision: 1,
            effectiveOrigin: "",
            defaultOrigin: "",
            currentLinkExample: "/feed/{existing-token}",
            proposedLinkExample: "/feed/{existing-token}",
            verificationStatus: "not-required",
            tokensUnchanged: true,
          });
        return json([]);
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          {kind === "notification" ? (
            <NotificationsAdminPage />
          ) : (
            <AdminPage page="settings" />
          )}
        </UIProviders>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    if (kind === "notification") {
      await user.click(screen.getByRole("tab", { name: "提醒与渠道" }));
      await user.click(await screen.findByRole("button", { name: "邮件通知" }));
    }
    if (kind === "platform") await user.click(await screen.findByRole("button", { name: "编辑平台名称" }));
    const label = kind === "notification" ? "SMTP 主机" : "平台名称";
    fireEvent.change(await screen.findByRole("textbox", { name: label }), {
      target: { value: "unsaved-draft" },
    });
    fail = true;
    await act(async () => {
      await client.refetchQueries({
        queryKey: [
          kind === "notification" ? "notification-settings" : "admin-state",
        ],
      });
    });
    await screen.findByText("设置读取暂时失败");
    expect(
      (
        screen.queryByRole("textbox", {
          name: label,
        }) as HTMLInputElement | null
      )?.value,
    ).toBe("unsaved-draft");
    expect(hasUnsavedChanges()).toBe(true);
    fail = false;
    await user.click(screen.getByRole("button", { name: "重新读取设置" }));
    expect(
      (
        (await screen.findByRole("textbox", {
          name: label,
        })) as HTMLInputElement
      ).value,
    ).toBe("unsaved-draft");
  },
);

// @vitest-environment jsdom
// Real notification settings + confirmation; HTTP mocked, no external delivery.
import { afterEach, expect, it, vi } from "vitest";
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
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});
async function mount() {
  let settings = {
    revision: 1,
    inApp: true,
    quotaPercent: [80],
    expiryHours: [24],
    providerRemainingPercent: [20],
    repeatHours: 24,
    email: {
      enabled: true,
      automatic: false,
      host: "smtp.example",
      port: 587,
      tlsMode: "starttls",
      username: "",
      from: "from@example.test",
      to: ["old@example.test"],
    },
    webhook: { enabled: true, automatic: false, url: "https://old.example" },
    smtpPasswordSet: false,
    webhookSecretSet: true,
  };
  const writes: any[] = [];
  let read: () => Promise<Response> = async () => json(settings);
  let test: () => Promise<Response> = async () => json({ status: "queued" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/notifications/test") && init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return test();
      }
      if (init?.method && init.method !== "GET")
        throw new Error("Unexpected write");
      return url.endsWith("/notification-settings")
        ? read()
        : json(url.endsWith("/state") ? { users: [] } : []);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <NotificationsAdminPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("tab", { name: "提醒与渠道" }));
  await screen.findByRole("button", { name: "Webhook 通知" });
  return {
    client,
    writes,
    view,
    change: () => {
      settings = {
        ...settings,
        revision: 2,
        email: { ...settings.email, to: ["new@example.test"] },
        webhook: { ...settings.webhook, url: "https://new.example" },
      };
    },
    setRead: (r: typeof read) => {
      read = r;
    },
    setTest: (t: typeof test) => {
      test = t;
    },
    refresh: async () => {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["notification-settings"] });
      });
    },
  };
}
async function open(channel: "webhook" | "email") {
  await userEvent.click(
    screen.getByRole("button", {
      name: channel === "webhook" ? "Webhook 通知" : "邮件通知",
    }),
  );
  return screen.getByRole("button", {
    name: channel === "webhook" ? "发送 Webhook 测试" : "发送邮件测试",
  });
}
const modal = () =>
  screen.getByRole("alertdialog", { name: "发送一条测试通知？" });
it.each(["webhook", "email"] as const)(
  "uses current saved %s identity without replacing dirty draft",
  async (channel) => {
    const state = await mount();
    const trigger = await open(channel);
    const field = screen.getByLabelText(
      channel === "webhook" ? "HTTPS Webhook 地址" : "SMTP 主机",
    );
    fireEvent.change(field, { target: { value: "draft.example" } });
    state.change();
    await state.refresh();
    await userEvent.click(trigger);
    expect(modal().textContent).toContain(
      channel === "webhook" ? "https://new.example" : "new@example.test",
    );
    expect((field as HTMLInputElement).value).toBe("draft.example");
    await userEvent.click(
      within(modal()).getByRole("button", { name: "发送测试" }),
    );
    await waitFor(() =>
      expect(state.writes).toEqual([{ channel, expectedSettingsRevision: 2 }]),
    );
  },
);
it("does not silently retarget an already open confirmation", async () => {
  const state = await mount();
  const trigger = await open("webhook");
  await userEvent.click(trigger);
  state.change();
  await state.refresh();
  expect(modal().textContent).toContain("https://old.example");
  await userEvent.click(
    within(modal()).getByRole("button", { name: "发送测试" }),
  );
  await within(modal()).findByText(
    "已保存的通知设置已变更。请取消并重新确认发送目标。",
  );
  expect(state.writes).toEqual([]);
  await userEvent.click(within(modal()).getByRole("button", { name: "取消" }));
  await userEvent.click(trigger);
  expect(modal().textContent).toContain("https://new.example");
  await userEvent.click(within(modal()).getByRole("button", { name: "取消" }));
  expect(state.writes).toEqual([]);
});
it.each(["pending", "failed", "paused"] as const)(
  "blocks external tests during %s reads while preserving draft",
  async (mode) => {
    const state = await mount();
    const trigger = await open("webhook");
    const field = screen.getByLabelText("HTTPS Webhook 地址");
    fireEvent.change(field, { target: { value: "draft.example" } });
    if (mode === "paused") act(() => onlineManager.setOnline(false));
    state.setRead(
      mode === "failed"
        ? async () => json({ message: "读取失败" }, 503)
        : () => new Promise(() => {}),
    );
    act(() => {
      void state.client.invalidateQueries({
        queryKey: ["notification-settings"],
      });
    });
    await waitFor(() =>
      expect((trigger as HTMLButtonElement).disabled).toBe(true),
    );
    if (mode === "failed") await screen.findByText("读取失败");
    await userEvent.click(trigger);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(state.writes).toEqual([]);
    expect((field as HTMLInputElement).value).toBe("draft.example");
  },
);
it("fences a server-side change not yet observed by the browser and requires renewed confirmation", async () => {
  const state = await mount();
  const trigger = await open("webhook");
  await userEvent.click(trigger);
  state.change();
  state.setTest(async () =>
    json(
      { message: "notification settings changed; reload before saving" },
      409,
    ),
  );
  await userEvent.click(
    within(modal()).getByRole("button", { name: "发送测试" }),
  );
  await within(modal()).findByText(
    "已保存的通知设置已变更。请取消并重新确认发送目标。",
  );
  expect(state.writes).toEqual([
    { channel: "webhook", expectedSettingsRevision: 1 },
  ]);
  await userEvent.click(
    within(modal()).getByRole("button", { name: "发送测试" }),
  );
  expect(state.writes).toHaveLength(1);
});
it("dismisses a departed settings task confirmation without allowing a stale send", async () => {
  const state = await mount();
  await userEvent.click(await open("webhook"));
  state.view.rerender(
    <QueryClientProvider client={state.client}>
      <UIProviders>
        <p>New session</p>
      </UIProviders>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.writes).toEqual([]);
});
it("prevents duplicate tests while the acknowledged request is pending", async () => {
  const state = await mount();
  let settle!: (r: Response) => void;
  state.setTest(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  await userEvent.click(await open("webhook"));
  const send = within(modal()).getByRole("button", { name: "发送测试" });
  await userEvent.dblClick(send);
  expect(state.writes).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  expect(modal()).toBeTruthy();
  await act(async () => settle(json({ status: "queued" })));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});
it("blocks an open confirmation during a failed refresh without submitting", async () => {
  const state = await mount();
  const trigger = await open("webhook");
  await userEvent.click(trigger);
  state.setRead(async () => json({ message: "读取失败" }, 503));
  await state.refresh();
  await userEvent.click(
    within(modal()).getByRole("button", { name: "发送测试" }),
  );
  await within(modal()).findByText(
    "暂时无法核对已保存的发送目标。请取消，等待设置读取成功后重试。",
  );
  expect(state.writes).toEqual([]);
  await userEvent.click(within(modal()).getByRole("button", { name: "取消" }));
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
});
it("does not report a departed test outcome in a replacement settings task", async () => {
  const state = await mount();
  let settle!: (r: Response) => void;
  state.setTest(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  await userEvent.click(await open("webhook"));
  await userEvent.click(
    within(modal()).getByRole("button", { name: "发送测试" }),
  );
  expect(state.writes).toHaveLength(1);
  state.view.rerender(
    <QueryClientProvider client={state.client}>
      <UIProviders>
        <p>New session</p>
      </UIProviders>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await act(async () => settle(json({ status: "accepted" })));
  expect(
    screen.queryByText("通知已由发送渠道接收，请查看实际收件结果"),
  ).toBeNull();
  expect(state.writes).toHaveLength(1);
});
it.each([
  [
    "cancelled",
    "测试通知已取消。请在发送记录核对原因，检查渠道设置后重新确认测试。",
  ],
  ["queued", "测试通知已进入发送队列"],
  ["available", "测试通知已出现在站内消息"],
  ["accepted", "通知已由发送渠道接收，请查看实际收件结果"],
  ["retrying", "此次发送未成功，请在发送记录查看重试状态"],
  ["failed", "此次发送未成功，请在发送记录查看重试状态"],
])(
  "reports the actual %s test outcome from HTTP without automatically resending",
  async (status, outcome) => {
    const state = await mount();
    state.setTest(async () => json({ status, attempts: 0 }));
    await userEvent.click(await open("webhook"));
    await userEvent.click(
      within(modal()).getByRole("button", { name: "发送测试" }),
    );
    await screen.findByText(outcome);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(state.writes).toEqual([
      { channel: "webhook", expectedSettingsRevision: 1 },
    ]);
    if (status === "cancelled")
      expect(screen.queryByText("测试通知已进入发送队列")).toBeNull();
  },
);

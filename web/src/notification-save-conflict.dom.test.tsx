// @vitest-environment jsdom
// Real recovery task and mocked HTTP only. No live settings writes or sends.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
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
      enabled: false,
      automatic: false,
      host: "smtp.example",
      port: 587,
      tlsMode: "starttls",
      username: "",
      from: "from@example.test",
      to: ["old@example.test"],
    },
    webhook: { enabled: true, automatic: false, url: "https://old.example" },
    smtpPasswordSet: true,
    webhookSecretSet: true,
  };
  const writes: any[] = [];
  let read: () => Promise<Response> = async () => json(settings);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/notification-settings") && init?.method === "PUT") {
        const value = JSON.parse(String(init.body));
        writes.push(value);
        return value.revision === 1
          ? json(
              { detail: "notification settings changed; reload before saving" },
              409,
            )
          : json({ ...settings, ...value, revision: settings.revision + 1 });
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
  await userEvent.click(
    await screen.findByRole("button", { name: "Webhook 通知" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "邮件通知" }));
  fireEvent.change(screen.getByLabelText("HTTPS Webhook 地址"), {
    target: { value: "https://draft.example" },
  });
  fireEvent.change(screen.getByLabelText("更新签名密钥（留空保留已保存值）"), {
    target: { value: "draft-secret-not-for-display" },
  });
  await userEvent.click(
    screen.getByRole("checkbox", { name: "清除已保存的 SMTP 密码" }),
  );
  settings = {
    ...settings,
    revision: 2,
    email: { ...settings.email, to: ["concurrent@example.test"] },
    webhook: { ...settings.webhook, url: "https://current.example" },
  };
  await userEvent.click(screen.getByRole("button", { name: "保存通知设置" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await screen.findByText("通知设置已由其他操作更新，当前修改尚未保存。");
  return {
    client,
    writes,
    view,
    setRead: (r: typeof read) => {
      read = r;
    },
    latest: () => json(settings),
    advance: () => {
      settings = {
        ...settings,
        revision: 3,
        webhook: { ...settings.webhook, url: "https://newest.example" },
      };
    },
    refresh: async () => {
      await act(async () => {
        await client.invalidateQueries({ queryKey: ["notification-settings"] });
      });
    },
  };
}
const recovery = () => screen.getByRole("button", { name: "载入最新设置" });
const modal = () =>
  screen.getByRole("alertdialog", { name: "用最新设置替换当前修改？" });
function draft() {
  expect(
    (screen.getByLabelText("HTTPS Webhook 地址") as HTMLInputElement).value,
  ).toBe("https://draft.example");
  expect(
    (
      screen.getByLabelText(
        "更新签名密钥（留空保留已保存值）",
      ) as HTMLInputElement
    ).value,
  ).toBe("draft-secret-not-for-display");
  expect(
    screen
      .getByRole("checkbox", { name: "清除已保存的 SMTP 密码" })
      .getAttribute("aria-checked"),
  ).toBe("true");
}
it("keeps all draft values and secret intentions after a failed read and cancelled review", async () => {
  const state = await mount();
  state.setRead(async () => json({ detail: "最新设置读取失败" }, 503));
  await userEvent.click(recovery());
  await screen.findByText("最新设置读取失败");
  draft();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  state.setRead(async () => state.latest());
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  expect(modal().textContent).not.toContain("draft-secret-not-for-display");
  expect(modal().textContent).toContain("服务器上已保存的设置不会改变");
  await userEvent.click(
    within(modal()).getByRole("button", { name: "继续编辑" }),
  );
  draft();
  expect(state.writes).toHaveLength(1);
});
it("only explicit replacement resets fields and secrets; subsequent Save uses the exact reviewed revision", async () => {
  const state = await mount();
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  await userEvent.click(
    within(modal()).getByRole("button", { name: "替换当前修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (screen.getByLabelText("HTTPS Webhook 地址") as HTMLInputElement).value,
  ).toBe("https://current.example");
  expect(
    (
      screen.getByLabelText(
        "更新签名密钥（留空保留已保存值）",
      ) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(
    screen
      .getByRole("checkbox", { name: "清除已保存的 SMTP 密码" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(state.writes).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "保存通知设置" }));
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1]).toMatchObject({
    revision: 2,
    email: { to: ["concurrent@example.test"] },
    webhook: { url: "https://current.example" },
  });
  expect(state.writes[1]).not.toHaveProperty("webhookSecret");
  expect(state.writes[1]).not.toHaveProperty("smtpPassword");
});
it("rejects a changed review without replacing draft or saving", async () => {
  const state = await mount();
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  state.advance();
  await state.refresh();
  await userEvent.click(
    within(modal()).getByRole("button", { name: "替换当前修改" }),
  );
  await within(modal()).findByText(
    "最新设置已再次变化或尚未核对完成。请继续编辑，再重新载入最新设置。",
  );
  expect(state.writes).toHaveLength(1);
  await userEvent.click(
    within(modal()).getByRole("button", { name: "继续编辑" }),
  );
  draft();
});
it("does not open a recovery decision after its settings task departs", async () => {
  const state = await mount();
  let settle!: (r: Response) => void;
  state.setRead(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  await userEvent.click(recovery());
  state.view.rerender(
    <QueryClientProvider client={state.client}>
      <UIProviders>
        <p>Replacement task</p>
      </UIProviders>
    </QueryClientProvider>,
  );
  await act(async () => settle(state.latest()));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(state.writes).toHaveLength(1);
});
it("ends an open recovery decision when its settings task departs", async () => {
  const state = await mount();
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  state.view.rerender(
    <QueryClientProvider client={state.client}>
      <UIProviders>
        <p>Replacement task</p>
      </UIProviders>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(state.writes).toHaveLength(1);
});
it("allows cancelling a hanging fresh read without losing edits or opening a late decision", async () => {
  const state = await mount();
  let settle!: (r: Response) => void;
  state.setRead(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  await userEvent.click(recovery());
  await userEvent.click(
    await screen.findByRole("button", { name: "取消载入" }),
  );
  draft();
  expect(
    (screen.getByRole("button", { name: "保存通知设置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await act(async () => settle(state.latest()));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(state.writes).toHaveLength(1);
});
it("requires the same authoritative query identity, not just a matching revision", async () => {
  const state = await mount();
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  act(() =>
    state.client.setQueryData(["notification-settings"], (value: any) => ({
      ...value,
      webhook: { ...value.webhook, url: "https://another.example" },
    })),
  );
  await userEvent.click(
    within(modal()).getByRole("button", { name: "替换当前修改" }),
  );
  await within(modal()).findByText(
    "最新设置已再次变化或尚未核对完成。请继续编辑，再重新载入最新设置。",
  );
  await userEvent.click(
    within(modal()).getByRole("button", { name: "继续编辑" }),
  );
  draft();
  expect(state.writes).toHaveLength(1);
});
it("ignores an older already-pending read after fresh recovery and retains the reviewed baseline", async () => {
  const state = await mount();
  const oldResponse = state.latest();
  let settle!: (r: Response) => void;
  state.setRead(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  act(() => {
    void state.client.invalidateQueries({
      queryKey: ["notification-settings"],
    });
  });
  await waitFor(() => expect(settle).toBeTypeOf("function"));
  state.advance();
  state.setRead(async () => state.latest());
  await userEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  await userEvent.click(
    within(modal()).getByRole("button", { name: "替换当前修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  const field = screen.getByLabelText("HTTPS Webhook 地址");
  expect((field as HTMLInputElement).value).toBe("https://newest.example");
  fireEvent.change(field, {
    target: { value: "https://after-review.example" },
  });
  await act(async () => settle(oldResponse));
  expect((field as HTMLInputElement).value).toBe(
    "https://after-review.example",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "发送 Webhook 测试" }),
  );
  const testDecision = await screen.findByRole("alertdialog", {
    name: "发送一条测试通知？",
  });
  expect(testDecision.textContent).toContain("https://newest.example");
  await userEvent.click(
    within(testDecision).getByRole("button", { name: "取消" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "保存通知设置" }));
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1]).toMatchObject({
    revision: 3,
    webhook: { url: "https://after-review.example" },
  });
});
it("lets an immediate new load own recovery after cancel while the old response arrives late", async () => {
  const state = await mount();
  const oldResponse = state.latest();
  let settle!: (r: Response) => void;
  state.setRead(
    () =>
      new Promise((r) => {
        settle = r;
      }),
  );
  await userEvent.click(recovery());
  await waitFor(() => expect(settle).toBeTypeOf("function"));
  state.advance();
  state.setRead(async () => state.latest());
  fireEvent.click(screen.getByRole("button", { name: "取消载入" }));
  fireEvent.click(recovery());
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  await act(async () => settle(oldResponse));
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  // The underlying form is intentionally inaccessible while the modal is open;
  // its associated inputs still retain their exact values until confirmation.
  expect(
    (screen.getByLabelText("HTTPS Webhook 地址") as HTMLInputElement).value,
  ).toBe("https://draft.example");
  expect(
    (
      screen.getByLabelText(
        "更新签名密钥（留空保留已保存值）",
      ) as HTMLInputElement
    ).value,
  ).toBe("draft-secret-not-for-display");
  expect(
    screen
      .getByLabelText("清除已保存的 SMTP 密码")
      .getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(
    within(modal()).getByRole("button", { name: "替换当前修改" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (screen.getByLabelText("HTTPS Webhook 地址") as HTMLInputElement).value,
  ).toBe("https://newest.example");
  expect(state.writes).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "保存通知设置" }));
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1].revision).toBe(3);
});
it("keeps recovery and external-test confirmations mutually exclusive", async () => {
  const state = await mount();
  const load = recovery();
  const external = screen.getByRole("button", { name: "发送 Webhook 测试" });
  await userEvent.click(external);
  const testDecision = await screen.findByRole("alertdialog", {
    name: "发送一条测试通知？",
  });
  // A queued activation must not open another task behind the current modal.
  fireEvent.click(load);
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(
    screen.queryByRole("alertdialog", { name: "用最新设置替换当前修改？" }),
  ).toBeNull();
  await userEvent.click(
    within(testDecision).getByRole("button", { name: "取消" }),
  );
  await userEvent.click(load);
  await screen.findByRole("alertdialog", { name: "用最新设置替换当前修改？" });
  fireEvent.click(external);
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(
    screen.queryByRole("alertdialog", { name: "发送一条测试通知？" }),
  ).toBeNull();
  await userEvent.click(
    within(modal()).getByRole("button", { name: "继续编辑" }),
  );
  draft();
  expect(state.writes).toHaveLength(1);
});
it.each([
  "missing thresholds",
  "invalid thresholds",
  "missing channel",
  "missing secret state",
])(
  "rejects %s from the fresh recovery read without changing draft or secrets",
  async (kind) => {
    const state = await mount();
    const malformed: any = await state.latest().json();
    if (kind === "missing thresholds") delete malformed.quotaPercent;
    if (kind === "invalid thresholds") malformed.expiryHours = ["unexpected"];
    if (kind === "missing channel") malformed.email = null;
    if (kind === "missing secret state") delete malformed.webhookSecretSet;
    state.setRead(async () => json(malformed));
    await userEvent.click(recovery());
    await screen.findByText("最新设置不完整，无法替换当前修改。请重试载入。");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    draft();
    expect(state.writes).toHaveLength(1);
  },
);

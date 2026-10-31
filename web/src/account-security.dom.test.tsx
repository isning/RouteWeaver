// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  within,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AccountSecurityPage } from "./AccountSecurity";
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
it("lets an ordinary user change their password with fresh credentials and accepts the rotated session", async () => {
  const before = {
    user: { id: "person", name: "Person", role: "user" },
    csrfToken: "old",
  };
  const after = { ...before, csrfToken: "rotated" };
  const changed = vi.fn();
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(init.body) });
        return json(after);
      }
      return json([
        { id: "opaque", current: true, expiresAt: "2027-01-01T00:00:00Z" },
      ]);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccountSecurityPage
          session={before}
          onSessionChanged={changed}
          onSignedOut={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("当前密码"), {
    target: { value: "old-password-example" },
  });
  fireEvent.change(screen.getByLabelText("新密码"), {
    target: { value: "new-password-example" },
  });
  fireEvent.change(screen.getByLabelText("确认新密码"), {
    target: { value: "new-password-example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() => expect(changed).toHaveBeenCalledWith(after));
  expect(writes).toEqual([
    {
      url: "/api/auth/password",
      body: {
        currentPassword: "old-password-example",
        newPassword: "new-password-example",
      },
    },
  ]);
  expect((screen.getByLabelText("新密码") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText("账号恢复与退役")).toBeNull();
});

it.each([false, true])(
  "exposes account security to ordinary users (required password change: %s)",
  async (required) => {
    const { default: App } = await import("./App");
    const reads: string[] = [];
    window.history.replaceState(
      null,
      "",
      required ? "#subscriptions" : "#account-security",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        reads.push(String(url));
        if (String(url).endsWith("/auth/me"))
          return json({
            user: {
              id: "ordinary",
              name: "Ordinary",
              role: "user",
              passwordChangeRequired: required,
            },
            csrfToken: "fixture",
          });
        return json([]);
      }),
    );
    client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <App />
        </UIProviders>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "账号安全" });
    expect(screen.getByRole("button", { name: "修改密码" })).toBeTruthy();
    expect(reads).not.toContain("/api/admin/accounts");
    if (required) {
      expect(screen.getByText("请先更换临时密码")).toBeTruthy();
      expect(reads).not.toContain("/api/me/profiles");
    }
  },
);

it("shows the exact target and consequence before an administrator disables an account using fresh authentication", async () => {
  const session = {
    user: { id: "admin", name: "Admin", role: "admin" },
    csrfToken: "old",
  };
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(init.body) });
        return json({
          id: "target",
          name: "Target",
          username: "target",
          role: "user",
          disabled: true,
        });
      }
      return json(
        String(url).endsWith("/admin/accounts")
          ? [
              {
                id: "target",
                name: "Target",
                username: "target",
                role: "user",
                disabled: false,
                retired: false,
                mfaEnabled: false,
              },
            ]
          : [],
      );
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccountSecurityPage
          session={session}
          onSessionChanged={() => {}}
          onSignedOut={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "管理 Target" }));
  expect(screen.getByText(/立即阻止登录和订阅链接交付/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("操作原因"), {
    target: { value: "Owner requested disable" },
  });
  fireEvent.change(screen.getByLabelText("管理员当前密码"), {
    target: { value: "synthetic-admin-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    url: "/api/admin/accounts/target/security",
    body: {
      action: "disable",
      reason: "Owner requested disable",
      currentPassword: "synthetic-admin-password",
    },
  });
});

const person = {
  user: { id: "person", name: "Person", role: "user", mfaEnabled: true },
  csrfToken: "old",
};
function mountSecurity(session = person) {
  const changed = vi.fn(),
    signedOut = vi.fn();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (value: typeof session) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccountSecurityPage
          session={value}
          onSessionChanged={changed}
          onSignedOut={signedOut}
        />
      </UIProviders>
    </QueryClientProvider>
  );
  const rendered = render(view(session));
  return {
    changed,
    signedOut,
    rerender: (value: typeof session) => rendered.rerender(view(value)),
  };
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
it("keeps the password draft after failed reauthentication, then sends the enrolled MFA code without the confirmation field", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(init.body));
        return writes.length === 1
          ? json({ detail: "invalid credentials" }, 403)
          : json({ ...person, csrfToken: "next" });
      }
      return json([]);
    }),
  );
  const task = mountSecurity();
  fill("当前密码", "wrong-current-password");
  fill("新密码", "new-password-example");
  fill("确认新密码", "new-password-example");
  fill("验证器验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await screen.findByText("当前密码或验证码不正确，请核对后重试。");
  expect((screen.getByLabelText("新密码") as HTMLInputElement).value).toBe(
    "new-password-example",
  );
  expect(task.changed).not.toHaveBeenCalled();
  fill("当前密码", "correct-current-password");
  fill("验证器验证码", "654321");
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() => expect(task.changed).toHaveBeenCalledTimes(1));
  expect(writes[1]).toEqual({
    currentPassword: "correct-current-password",
    newPassword: "new-password-example",
    totp: "654321",
  });
});
it("validates password byte length and matching confirmation before sending", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "POST") writes.push(init.body);
      return json([]);
    }),
  );
  mountSecurity();
  fill("当前密码", "current-password");
  fill("新密码", "密".repeat(25));
  fill("确认新密码", "different");
  fill("验证器验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await screen.findByText(/密码须为 12–72/);
  await screen.findByText("两次输入的新密码不一致");
  expect(writes).toEqual([]);
});
it("revokes other sessions with fresh credentials while preserving the current login", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST")
        writes.push({ url, body: JSON.parse(init.body) });
      return json(init?.method === "POST" ? { ok: true } : []);
    }),
  );
  const task = mountSecurity();
  fill("验证当前密码", "current-password");
  fill("退出其他会话的验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "退出其他所有会话" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    url: "/api/auth/sessions/revoke-others",
    body: { currentPassword: "current-password", totp: "123456" },
  });
  expect(task.signedOut).not.toHaveBeenCalled();
});
it.each([true, false])(
  "individual session revocation identifies current=%s and reconciles logout correctly",
  async (current) => {
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.method === "DELETE") {
          writes.push(String(url));
          return json({ ok: true, current });
        }
        return json([
          { id: "opaque-session", current, expiresAt: "2027-01-01T00:00:00Z" },
        ]);
      }),
    );
    const task = mountSecurity();
    fireEvent.click(
      await screen.findByRole("button", {
        name: current ? "退出当前会话" : "退出此会话",
      }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation.textContent).toContain(
      current ? "未保存的输入将丢失" : "opaque-session",
    );
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "退出会话" }),
    );
    await waitFor(() =>
      expect(writes).toEqual(["/api/auth/sessions/opaque-session"]),
    );
    await waitFor(() =>
      expect(task.signedOut).toHaveBeenCalledTimes(current ? 1 : 0),
    );
  },
);
it("ignores late password completion after the account changes and clears the old secret inputs", async () => {
  let release!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => (init?.method === "POST" ? held : json([]))),
  );
  const task = mountSecurity();
  fill("当前密码", "current-password");
  fill("新密码", "new-password-example");
  fill("确认新密码", "new-password-example");
  fill("验证器验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "修改密码" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  task.rerender({ ...person, user: { ...person.user, id: "other" } });
  await act(async () => {
    release(json({ ...person, csrfToken: "late" }));
    await held;
  });
  expect(task.changed).not.toHaveBeenCalled();
  expect((screen.getByLabelText("新密码") as HTMLInputElement).value).toBe("");
});

it.each(["reset-password", "reset-mfa", "retire", "enable"] as const)(
  "submits the explicitly reviewed administrator action %s without unrelated fields",
  async (action) => {
    const writes: any[] = [];
    const target = {
      id: "target",
      name: "Target",
      username: "target-login",
      role: "user",
      disabled: action === "enable",
      retired: false,
      mfaEnabled: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(init.body));
          return json(target);
        }
        return json(String(url).endsWith("/admin/accounts") ? [target] : []);
      }),
    );
    mountSecurity({
      ...person,
      user: { ...person.user, id: "admin", role: "admin" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "管理 Target" }));
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
    const labels = {
      "reset-password": "重置账号密码",
      "reset-mfa": "重置二次验证",
      retire: "永久退役账号",
      enable: "恢复账号",
    };
    if (action !== "enable") {
      fireEvent.click(screen.getByRole("combobox", { name: "账号操作" }));
      fireEvent.click(
        await screen.findByRole("option", { name: labels[action] }),
      );
      await screen.findByRole("button", { name: labels[action] });
    }
    if (action === "reset-password")
      fill("临时密码", "temporary-password-example");
    if (action === "retire") fill("输入登录名以确认永久退役", "target-login");
    fill("操作原因", "Verified owner recovery");
    fill("管理员当前密码", "admin-current-password");
    fill("管理员验证器验证码", "123456");
    fireEvent.click(screen.getByRole("button", { name: labels[action] }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      action,
      reason: "Verified owner recovery",
      currentPassword: "admin-current-password",
      totp: "123456",
      ...(action === "reset-password"
        ? { newPassword: "temporary-password-example" }
        : {}),
    });
  },
);
it("preserves an administrator recovery draft after failure and requires confirmation before discarding it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      init?.method === "POST"
        ? json({ detail: "required audit unavailable" }, 500)
        : json(
            String(url).endsWith("/admin/accounts")
              ? [
                  {
                    id: "target",
                    name: "Target",
                    username: "target",
                    role: "user",
                    disabled: false,
                    retired: false,
                  },
                ]
              : [],
          ),
    ),
  );
  mountSecurity({
    ...person,
    user: { ...person.user, id: "admin", role: "admin" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "管理 Target" }));
  fill("操作原因", "Keep this recovery reason");
  fill("管理员当前密码", "admin-current-password");
  fill("管理员验证器验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
  await screen.findByText("required audit unavailable");
  expect((screen.getByLabelText("操作原因") as HTMLInputElement).value).toBe(
    "Keep this recovery reason",
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  const confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText("操作原因") as HTMLInputElement).value).toBe(
    "Keep this recovery reason",
  );
});

it("conceals the security draft on expired-session failure without retrying the password change", async () => {
  const { default: App } = await import("./App");
  let changes = 0;
  window.history.replaceState(null, "", "#account-security");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/auth/password")) {
        changes++;
        return json({ detail: "session expired" }, 401);
      }
      if (String(url).endsWith("/auth/me"))
        return json({
          user: { id: "ordinary", name: "Ordinary", role: "user" },
          csrfToken: "fixture",
        });
      return json([]);
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <App />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "账号安全" });
  fill("当前密码", "current-password");
  fill("新密码", "new-password-example");
  fill("确认新密码", "new-password-example");
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await screen.findByText("请重新登录");
  expect(screen.queryByRole("button", { name: "修改密码" })).toBeNull();
  expect(changes).toBe(1);
});

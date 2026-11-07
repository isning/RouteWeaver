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
import userEvent from "@testing-library/user-event";
import { flushSync } from "react-dom";
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
  vi.restoreAllMocks();
  sessionStorage.clear();
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
          name: "Target · Personal",
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
                name: "Target · Personal",
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
  fireEvent.click(await screen.findByRole("button", { name: "管理 Target · Personal" }));
  const dialog = screen.getByRole("dialog", { name: "管理 Target · Personal 的账号" });
  expect(within(dialog).getByText("登录名：target")).toBeTruthy();
  const warning = within(dialog).getByText(/立即阻止登录和订阅链接交付/);
  expect(warning.textContent).toContain("托管入口将拒绝新连接与续期");
  expect(warning.textContent).toContain("已有连接可能在续期被拒绝或租约到期时结束");
  expect(warning.textContent).toContain("非托管节点");
  expect(warning.textContent).not.toContain("立即断开");
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
    if (action === "retire") {
      const warning = within(screen.getByRole("dialog")).getByText(
        /永久阻止登录和订阅链接交付/,
      );
      expect(warning.textContent).toContain("账号不能重新启用");
      expect(warning.textContent).toContain("托管入口将拒绝新连接与续期");
      expect(warning.textContent).toContain("已有连接可能在续期被拒绝或租约到期时结束");
      expect(warning.textContent).toContain("非托管节点");
      expect(warning.textContent).not.toContain("立即断开");
      fill("输入登录名以确认永久退役", "target-login");
    }
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
it("preserves the reason but clears credentials after uncertain administrator recovery and requires confirmation before discarding it", async () => {
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
  await screen.findByText("安全操作结果尚未确认。请查看当前状态，不要直接重复提交。");
  expect((screen.getByLabelText("管理员当前密码") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("管理员验证器验证码") as HTMLInputElement).value).toBe("");
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


it("keeps account recovery Close focus after twice canceling a dirty reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => json(String(url).endsWith("/admin/accounts") ? [{ id: "target", name: "Target", username: "target", role: "user", disabled: false, retired: false }] : [])));
  mountSecurity({ ...person, user: { ...person.user, id: "admin", role: "admin" } });
  await userEvent.click(await screen.findByRole("button", { name: "管理 Target" }));
  fill("操作原因", "Retained recovery reason");
  const dialog = screen.getByRole("dialog");
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((screen.getByLabelText("操作原因") as HTMLInputElement).value).toBe("Retained recovery reason");
  }
  expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
});

it("renders empty security records without empty list surfaces and refreshes real sessions", async () => {
  let sessions: unknown[] = [];
  const fetcher = vi.fn(async (url) =>
    json(String(url).includes("/auth/sessions") ? sessions : []),
  );
  vi.stubGlobal("fetch", fetcher);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccountSecurityPage
          session={{
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "csrf",
          }}
          onSessionChanged={() => {}}
          onSignedOut={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByText("没有有效会话。");
  await screen.findByText("没有账号记录。");
  const region = screen.getByRole("region", { name: "登录会话设置" });
  expect(within(region).queryByRole("list")).toBeNull();
  expect(
    screen.getByText("没有账号记录。").parentElement?.querySelector("ul"),
  ).toBeNull();
  expect(
    within(region).getByRole("button", { name: "退出其他所有会话" }),
  ).toBeTruthy();
  sessions = [
    { id: "current", current: true, expiresAt: "2027-01-01T00:00:00Z" },
  ];
  await userEvent.click(
    within(region).getByRole("button", { name: "刷新会话" }),
  );
  await within(region).findByText("当前会话");
  expect(within(region).getByRole("list")).toBeTruthy();
  expect(
    within(region).getByRole("button", { name: "退出当前会话" }),
  ).toBeTruthy();
  expect(within(region).queryByText("没有有效会话。")).toBeNull();
});


// SOURCE-ONLY reconstruction: these new public UI cases have not been executed.
function fillPasswordAttempt() {
  fill("当前密码", "current-secret-example");
  fill("新密码", "new-secret-example");
  fill("确认新密码", "new-secret-example");
  fill("验证器验证码", "123456");
}
it.each([0, 409, 500, 200])("keeps an uncertain password outcome (%s) across remount, reads only and never silently unlocks resubmission", async (status) => {
  let writes = 0;
  let persistedAtDispatch = "";
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") {
      writes++;
      persistedAtDispatch = sessionStorage.getItem("routeweaver.security-recovery.v1:person") || "";
      if (!status) throw new TypeError("response lost");
      return json({ detail: "response ownership changed" }, status);
    }
    return json([{ id: "current", current: true, expiresAt: "2027-01-01" }]);
  }));
  const first = mountSecurity();
  fillPasswordAttempt();
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await screen.findByText("安全操作结果尚未确认。请查看当前状态，不要直接重复提交。");
  expect(first.changed).not.toHaveBeenCalled();
  expect((screen.getByLabelText("当前密码") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("新密码") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("验证器验证码") as HTMLInputElement).value).toBe("");
  const metadata = JSON.parse(persistedAtDispatch);
  expect(Object.keys(metadata).sort()).toEqual(["action", "actor", "startedAt", "target"]);
  expect(metadata).toMatchObject({ action: "password", actor: "person", target: "person" });
  expect(persistedAtDispatch).not.toMatch(/current-secret|new-secret|123456|csrf|old/);
  cleanup(); client.clear();
  mountSecurity();
  await screen.findByText("安全操作结果尚未确认");
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("当前可见有效会话：1。");
  expect(writes).toBe(1);
  expect((screen.getByRole("button", { name: "修改密码" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/关闭提醒不会取消原操作/)).toBeTruthy();
  expect(sessionStorage.getItem("routeweaver.security-recovery.v1:person")).toBe(persistedAtDispatch);
});
it("does not dispatch when recovery metadata cannot be saved", async () => {
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") writes++;
    return json([]);
  }));
  mountSecurity();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  fillPasswordAttempt();
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() => expect(screen.getAllByText("无法保存安全操作记录，本次尚未提交。请检查浏览器会话存储。").length).toBeGreaterThan(0));
  expect(writes).toBe(0);
});
it("keeps an old actor's reminder private when switching accounts and ignores late success", async () => {
  let release!: (value: Response) => void;
  let writes = 0;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") { writes++; return held; }
    return json([]);
  }));
  const task = mountSecurity();
  fillPasswordAttempt();
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() => expect(writes).toBe(1));
  task.rerender({ ...person, user: { ...person.user, id: "other-person" } });
  await act(async () => { release(json({ ...person, csrfToken: "rotated" })); await held; });
  expect(task.changed).not.toHaveBeenCalled();
  expect(screen.queryByText("安全操作结果尚未确认")).toBeNull();
  task.rerender(person);
  await screen.findByText("安全操作结果尚未确认");
  expect(writes).toBe(1);
});
it("treats a failed current-state read as inconclusive and keeps the write blocked", async () => {
  sessionStorage.setItem("routeweaver.security-recovery.v1:person", JSON.stringify({ actor: "person", target: "person", action: "password", startedAt: "2026-11-06T00:00:00Z" }));
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") writes++;
    return json({ detail: "not found" }, 404);
  }));
  mountSecurity();
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("无法读取当前状态。请确认登录和网络后再次查看；原操作仍未确认。");
  expect(screen.queryByRole("button", { name: "已查看状态，关闭提醒" })).toBeNull();
  expect((screen.getByRole("button", { name: "修改密码" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toBe(0);
});

it("does not interpret incomplete account state as disabled or MFA being off", async () => {
  sessionStorage.setItem("routeweaver.security-recovery.v1:admin", JSON.stringify({ actor: "admin", target: "target", action: "reset-mfa", startedAt: "2026-11-06T00:00:00Z" }));
  vi.stubGlobal("fetch", vi.fn(async (url) => json(String(url).endsWith("/admin/accounts") ? [{ id: "target", name: "Target", username: "target" }] : [])));
  mountSecurity({ ...person, user: { ...person.user, id: "admin", role: "admin" } });
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("无法读取当前状态。请确认登录和网络后再次查看；原操作仍未确认。");
  expect(screen.queryByText(/目标账号当前状态/)).toBeNull();
  expect(screen.queryByRole("button", { name: "已查看状态，关闭提醒" })).toBeNull();
});
it("requires explicit duplicate-action confirmation before dismissing a recovery reminder", async () => {
  sessionStorage.setItem("routeweaver.security-recovery.v1:person", JSON.stringify({ actor: "person", target: "person", action: "password", startedAt: "2026-11-06T00:00:00Z" }));
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  mountSecurity();
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("当前可见有效会话：0。");
  fireEvent.click(screen.getByRole("button", { name: "已查看状态，关闭提醒" }));
  const review = await screen.findByRole("alertdialog");
  expect(review.textContent).toContain("再次提交可能重复执行");
  fireEvent.click(within(review).getByRole("button", { name: "保留提醒" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByRole("button", { name: "修改密码" }) as HTMLButtonElement).disabled).toBe(true);
});
it("blocks writes when persisted metadata belongs to another actor", async () => {
  sessionStorage.setItem("routeweaver.security-recovery.v1:person", JSON.stringify({ actor: "other", target: "other", action: "password", startedAt: "2026-11-06T00:00:00Z" }));
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  mountSecurity();
  await screen.findByText("无法读取安全操作记录。请恢复浏览器会话存储后重新打开此页；暂不提交新的安全操作。");
  expect((screen.getByRole("button", { name: "修改密码" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/目标标识：other/)).toBeNull();
});


it.each([
  ["password", "switch"], ["password", "unmount"],
  ["revoke-others", "switch"], ["revoke-others", "unmount"],
] as const)("does not dispatch %s when its form is removed during validation (%s)", async (operation, departure) => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method && init.method !== "GET") writes.push(String(url));
    return json([]);
  }));
  const task = mountSecurity();
  if (operation === "password") fillPasswordAttempt();
  else {
    fill("验证当前密码", "current-secret-example");
    fill("退出其他会话的验证码", "123456");
  }
  const button = screen.getByRole("button", { name: operation === "password" ? "修改密码" : "退出其他所有会话" });
  const form = button.closest("form");
  expect(form).not.toBeNull();
  // Native form submit starts asynchronous validation. Remove the owning task
  // in the same event turn, before promise-based validation can finish.
  await act(async () => {
    fireEvent.submit(form!);
    if (departure === "switch") flushSync(() => task.rerender({ ...person, user: { ...person.user, id: "next-person" } }));
    else cleanup();
  });
  expect(writes).toEqual([]);
  expect(sessionStorage.getItem("routeweaver.security-recovery.v1:person")).toBeNull();
  expect(sessionStorage.getItem("routeweaver.security-recovery.v1:next-person")).toBeNull();
  if (departure === "switch") {
    expect((screen.getByLabelText("当前密码") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("安全操作结果尚未确认")).toBeNull();
  }
});
it("keeps unknown revoke-other outcome across remount without repeating the write", async () => {
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "POST") { writes++; throw new TypeError("lost response"); }
    return json([]);
  }));
  mountSecurity();
  fill("验证当前密码", "current-secret-example");
  fill("退出其他会话的验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "退出其他所有会话" }));
  await screen.findByText("安全操作结果尚未确认。请查看当前状态，不要直接重复提交。");
  expect((screen.getByLabelText("验证当前密码") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("退出其他会话的验证码") as HTMLInputElement).value).toBe("");
  cleanup(); client.clear();
  mountSecurity();
  await screen.findByText("安全操作结果尚未确认");
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("当前可见有效会话：0。");
  expect((screen.getByRole("button", { name: "退出其他所有会话" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toBe(1);
});
it("retains an unknown administrator operation after closing its task and remounting without treating current state as completion", async () => {
  const admin = { ...person, user: { ...person.user, id: "admin", role: "admin" } };
  let writes = 0;
  const target = { id: "target", name: "Target", username: "target", role: "user", disabled: false, retired: false, mfaEnabled: false, passwordChangeRequired: false };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method === "POST") { writes++; target.disabled = true; throw new TypeError("lost response"); }
    return json(String(url).endsWith("/admin/accounts") ? [target] : []);
  }));
  mountSecurity(admin);
  fireEvent.click(await screen.findByRole("button", { name: "管理 Target" }));
  fill("操作原因", "Owner requested disable");
  fill("管理员当前密码", "admin-secret-example");
  fill("管理员验证器验证码", "123456");
  fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
  await screen.findByText("安全操作结果尚未确认。请查看当前状态，不要直接重复提交。");
  expect((screen.getByLabelText("管理员当前密码") as HTMLInputElement).value).toBe("");
  cleanup(); client.clear();
  mountSecurity(admin);
  await screen.findByText("安全操作结果尚未确认");
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText("目标账号当前状态：已停用；未启用二次验证；未要求更换密码。");
  expect(screen.getByText(/当前状态不能证明上次操作是否完成/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "管理 Target" }) as HTMLButtonElement).disabled).toBe(true);
  expect(writes).toBe(1);
});

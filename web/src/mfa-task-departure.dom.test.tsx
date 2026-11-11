// @vitest-environment jsdom
// Public App navigation and real controls; synthetic HTTP only, no authenticator.
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});
function mountTask(sessionCurrent = true) {
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
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  history.replaceState(null, "", "/#account-security");
  const writes: string[] = [];
  let current = {
    user: {
      id: "synthetic-admin",
      name: "Synthetic admin",
      role: "admin",
      mfaEnabled: false,
    },
    csrfToken: "synthetic-csrf",
  };
  let reads = 0;
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      writes.push(url);
      if (
        [
          "/api/auth/mfa/setup",
          "/api/auth/mfa/enable",
          "/api/auth/password",
          "/api/auth/sessions/synthetic-session",
        ].includes(url)
      )
        return new Promise<Response>((resolve) => pending.push(resolve));
      throw new Error(`Unexpected write: ${url}`);
    }
    if (url === "/api/auth/me") {
      reads++;
      return json(current);
    }
    if (url === "/api/admin/accounts")
      return json([
        {
          id: "target",
          name: "Target",
          username: "target",
          role: "user",
          disabled: false,
          retired: false,
          mfaEnabled: false,
          passwordChangeRequired: false,
        },
      ]);
    if (url === "/api/auth/sessions")
      return json([
        {
          id: "synthetic-session",
          current: sessionCurrent,
          expiresAt: "2027-01-01T00:00:00Z",
        },
      ]);
    if (url === "/api/settings") return json({});
    if (url === "/api/state")
      return json({
        users: [],
        nodes: [],
        routes: [],
        revisions: [],
        capabilities: [],
      });
    return json([]);
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <App />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    pending,
    view,
    get reads() {
      return reads;
    },
    setActor(id: string, csrfToken = "synthetic-csrf") {
      current = {
        ...current,
        user: { ...current.user, id, name: id },
        csrfToken,
      };
    },
    async settle(
      index = 0,
      value: unknown = {
        secret: "SYNTHETIC",
        uri: "otpauth://totp/synthetic?secret=SYNTHETIC",
      },
    ) {
      await act(async () => {
        pending[index](json(value));
      });
    },
  };
}
async function setup(task: ReturnType<typeof mountTask>) {
  fireEvent.change(await screen.findByLabelText("验证当前账号密码"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await waitFor(() => expect(task.writes).toContain("/api/auth/mfa/setup"));
}
async function navigate(hash: string) {
  await act(async () => {
    location.hash = `#${hash}`;
    fireEvent(window, new HashChangeEvent("hashchange"));
  });
}
const disabled = (name: string) =>
  (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

it("does not start a replacement MFA setup after leaving and returning while the first setup is unresolved", async () => {
  const { writes, pending } = mountTask();
  fireEvent.change(await screen.findByLabelText("验证当前账号密码"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await waitFor(() => expect(writes).toEqual(["/api/auth/mfa/setup"]));
  await act(async () => {
    location.hash = "#activity";
    fireEvent(window, new HashChangeEvent("hashchange"));
  });
  await screen.findByRole("heading", { name: "操作审计" });
  await act(async () => {
    location.hash = "#account-security";
    fireEvent(window, new HashChangeEvent("hashchange"));
  });
  await screen.findByRole("heading", { name: "账号安全" });
  await screen.findByRole("heading", { name: "管理员二次验证" });
  // The user may return to a pending/recovery task. If setup is offered again,
  // using it must not replace the server's one pending secret before settlement.
  const password = screen.queryByLabelText("验证当前账号密码");
  if (password) {
    await act(async () => {
      fireEvent.change(password, { target: { value: "synthetic-password" } });
      fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
    });
  }
  try {
    expect(writes).toEqual(["/api/auth/mfa/setup"]);
  } finally {
    await act(async () => {
      pending.forEach((resolve) =>
        resolve(
          json({
            secret: "SYNTHETIC",
            uri: "otpauth://totp/synthetic?secret=SYNTHETIC",
          }),
        ),
      );
    });
  }
});

it("blocks password, session and account changes while MFA setup is pending, including after an unchanged false MFA read", async () => {
  const task = mountTask();
  await setup(task);
  expect(disabled("修改密码")).toBe(true);
  expect(disabled("退出其他所有会话")).toBe(true);
  expect(disabled("管理 Target")).toBe(true);
  expect(disabled("查看当前状态")).toBe(true);
  const record = JSON.parse(
    sessionStorage.getItem("routeweaver.security-recovery.v1:synthetic-admin")!,
  );
  expect(Object.keys(record).sort()).toEqual([
    "action",
    "actor",
    "startedAt",
    "target",
  ]);
  expect(record.action).toBe("mfa-setup");
  const before = task.reads;
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  await waitFor(() => expect(task.reads).toBeGreaterThan(before));
  expect(disabled("查看当前状态")).toBe(true);
  expect(disabled("设置二次验证")).toBe(true);
  expect(
    screen.queryByRole("button", { name: "已查看状态，关闭提醒" }),
  ).toBeNull();
  expect(task.writes).toEqual(["/api/auth/mfa/setup"]);
  await task.settle();
  await screen.findByLabelText("验证器验证码");
  expect(disabled("修改密码")).toBe(false);
});

it.each(["same actor rotation", "A to B to A"])(
  "keeps pending ownership across %s and rejects the old setup result without resurrecting its secret",
  async (kind) => {
    const task = mountTask();
    await setup(task);
    if (kind === "A to B to A") {
      task.setActor("synthetic-B");
      await act(async () => {
        fireEvent(window, new Event("focus"));
      });
      await waitFor(() => expect(disabled("设置二次验证")).toBe(false));
      expect(screen.queryByText("正在提交安全操作")).toBeNull();
    }
    task.setActor("synthetic-admin", "synthetic-rotated");
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByText("正在提交安全操作");
    expect(disabled("设置二次验证")).toBe(true);
    expect(disabled("查看当前状态")).toBe(true);
    await task.settle();
    await screen.findByText("安全操作结果尚未确认");
    expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
    expect(disabled("设置二次验证")).toBe(true);
    expect(task.writes).toEqual(["/api/auth/mfa/setup"]);
  },
);

it("blocks MFA through both account security and settings while password change is unresolved", async () => {
  const task = mountTask();
  fireEvent.change(await screen.findByLabelText("当前密码", { exact: true }), {
    target: { value: "synthetic-old-password" },
  });
  fireEvent.change(screen.getByLabelText("新密码", { exact: true }), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.change(screen.getByLabelText("确认新密码", { exact: true }), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() => expect(task.writes).toEqual(["/api/auth/password"]));
  expect(disabled("设置二次验证")).toBe(true);
  await navigate("settings");
  fireEvent.click(
    await screen.findByRole("button", { name: "放弃修改并离开" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("tab", { name: "账号安全" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  await userEvent.click(screen.getByRole("tab", { name: "账号安全" }));
  await screen.findByLabelText("验证当前账号密码");
  expect(disabled("设置二次验证")).toBe(true);
  expect(disabled("查看当前状态")).toBe(true);
  const before = task.reads;
  task.setActor("synthetic-admin", "synthetic-password-rotation");
  await task.settle(0, {
    user: { id: "synthetic-admin", role: "admin", mfaEnabled: false },
    csrfToken: "synthetic-password-rotation",
  });
  await waitFor(() => expect(task.reads).toBeGreaterThan(before));
  await waitFor(() => expect(disabled("设置二次验证")).toBe(false));
  expect(task.writes).toEqual(["/api/auth/password"]);
});

it("keeps an unresolved enable blocked after navigation and a false status read, then retains unknown recovery", async () => {
  const task = mountTask();
  await setup(task);
  await task.settle();
  fireEvent.change(await screen.findByLabelText("验证器验证码"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "验证并启用" }));
  await waitFor(() =>
    expect(task.writes).toEqual([
      "/api/auth/mfa/setup",
      "/api/auth/mfa/enable",
    ]),
  );
  await navigate("activity");
  await screen.findByRole("heading", { name: "操作审计" });
  await navigate("account-security");
  await screen.findByLabelText("验证当前账号密码");
  expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
  expect(disabled("设置二次验证")).toBe(true);
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  expect(disabled("查看当前状态")).toBe(true);
  await task.settle(1, {});
  await screen.findByText("安全操作结果尚未确认");
  expect(disabled("修改密码")).toBe(true);
  expect(disabled("设置二次验证")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "查看当前状态" }));
  await screen.findByText(
    "当前账号未启用二次验证。当前状态不能确认上次设置或启用操作是否结束。",
  );
  expect(disabled("设置二次验证")).toBe(true);
  expect(task.writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
});

it("does not send MFA setup when the shared recovery record cannot be saved", async () => {
  const task = mountTask();
  const password = await screen.findByLabelText("验证当前账号密码");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("synthetic storage failure");
  });
  fireEvent.change(password, { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await screen.findAllByText(
    "无法保存安全操作记录，本次尚未提交。请检查浏览器会话存储。",
  );
  expect(task.writes).toEqual([]);
});

it.each([true, false])(
  "reconciles detached session revocation without confusing current=%s with another session",
  async (current) => {
    const task = mountTask(current);
    fireEvent.click(
      await screen.findByRole("button", {
        name: current ? "退出当前会话" : "退出此会话",
      }),
    );
    const confirm = await screen.findByRole("alertdialog");
    const button = Array.from(confirm.querySelectorAll("button")).find(
      (entry) => entry.textContent === "退出会话",
    );
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    await waitFor(() =>
      expect(task.writes).toEqual(["/api/auth/sessions/synthetic-session"]),
    );
    await navigate("activity");
    fireEvent.click(
      await screen.findByRole("button", { name: "放弃修改并离开" }),
    );
    // The pending confirmation still covers the destination, but browser history
    // has departed the account task. It must not own session reconciliation.
    await screen.findByRole("heading", { name: "操作审计", hidden: true });
    expect(screen.queryByLabelText("当前密码", { exact: true })).toBeNull();
    await task.settle(0, { current });
    if (current) {
      await screen.findByRole("region", { name: "恢复登录" });
      expect(screen.queryByRole("heading", { name: "操作审计" })).toBeNull();
    } else {
      await screen.findByRole("heading", { name: "操作审计" });
      expect(screen.queryByRole("region", { name: "恢复登录" })).toBeNull();
    }
    expect(
      sessionStorage.getItem(
        "routeweaver.security-recovery.v1:synthetic-admin",
      ),
    ).toBeNull();
    expect(task.writes).toEqual(["/api/auth/sessions/synthetic-session"]);
  },
);

it("recovers recordless storage failure only after explicitly rechecking restored storage", async () => {
  const task = mountTask();
  const password = await screen.findByLabelText("验证当前账号密码");
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("synthetic storage failure");
    });
  fireEvent.change(password, { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await screen.findAllByText(
    "无法保存安全操作记录，本次尚未提交。请检查浏览器会话存储。",
  );
  expect(task.writes).toEqual([]);
  storage.mockRestore();
  expect(disabled("设置二次验证")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新检查操作记录" }));
  await waitFor(() => expect(disabled("设置二次验证")).toBe(false));
  await setup(task);
  await task.settle();
  await screen.findByLabelText("验证器验证码");
  expect(task.writes).toEqual(["/api/auth/mfa/setup"]);
});

it("rechecks an unreadable record without erasing restored unknown MFA metadata", async () => {
  const key = "routeweaver.security-recovery.v1:synthetic-admin";
  const read = Storage.prototype.getItem;
  const storage = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, name) {
      if (name === key) throw new Error("synthetic read failure");
      return read.call(this, name);
    });
  const task = mountTask();
  await screen.findByText(
    "无法读取安全操作记录。请恢复浏览器会话存储后重新检查操作记录；暂不提交新的安全操作。",
  );
  storage.mockRestore();
  const record = {
    actor: "synthetic-admin",
    target: "synthetic-admin",
    action: "mfa-enable",
    startedAt: "2026-11-11T00:00:00Z",
  };
  sessionStorage.setItem(key, JSON.stringify(record));
  fireEvent.click(screen.getByRole("button", { name: "重新检查操作记录" }));
  await screen.findByText("安全操作结果尚未确认");
  expect(disabled("设置二次验证")).toBe(true);
  expect(disabled("查看当前状态")).toBe(false);
  expect(screen.queryByRole("button", { name: "重新检查操作记录" })).toBeNull();
  expect(sessionStorage.getItem(key)).toBe(JSON.stringify(record));
  expect(task.writes).toEqual([]);
});

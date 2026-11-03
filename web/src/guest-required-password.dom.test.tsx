// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import App from "./App";
import { setCSRF, setToken } from "./api";
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const state = {
  users: [],
  nodes: [],
  routes: [],
  revisions: [],
  capabilities: [],
};
let client: QueryClient;
beforeAll(async () => {
  await Promise.all([
    import("./AccountSecurity"),
    import("./Admin"),
    import("./Security"),
  ]);
});
beforeEach(() => {
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/#account-security");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  client?.clear();
  setToken("");
  setCSRF("");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
function mount() {
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
}
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
}

it.each(["password", "invite", "token"] as const)(
  "guest %s failure retains its form and enters only after an explicit corrected retry",
  async (mode) => {
    let accepted = false;
    let attempts = 0;
    let release!: (response: Response) => void;
    const unexpected: string[] = [];
    const calls: {
      path: string;
      method: string;
      authorization: string;
      body?: unknown;
    }[] = [];
    const session = {
      user: {
        id: "guest-success",
        name: "Accepted guest",
        role: mode === "token" ? "admin" : "user",
      },
      csrfToken: "accepted-csrf",
    };
    const failure =
      mode === "invite"
        ? "邀请已过期，请取得新邀请"
        : mode === "token"
          ? "管理员令牌无效"
          : "账号或密码不正确";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method || "GET";
        const authorization =
          new Headers(init?.headers).get("Authorization") || "";
        calls.push({
          path: url,
          method,
          authorization,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url === "/api/auth/me" && method === "GET") {
          if (mode === "token" && authorization) {
            if (!accepted) {
              attempts++;
              if (attempts === 1)
                return new Promise<Response>((resolve) => {
                  release = resolve;
                });
              accepted = true;
            }
            return json(session);
          }
          return accepted
            ? json(session)
            : json({ detail: "authentication required" }, 401);
        }
        if (
          mode === "token" &&
          url === "/api/state" &&
          authorization === "Bearer rejected-token" &&
          !accepted
        )
          return json({ detail: failure }, 401); // Explicit legacy bootstrap fallback only.
        if (
          method === "POST" &&
          url ===
            (mode === "invite"
              ? "/api/auth/accept-invite"
              : "/api/auth/login") &&
          mode !== "token"
        ) {
          attempts++;
          if (attempts === 1)
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          accepted = true;
          return json(session);
        }
        if (accepted && method === "GET" && url === "/api/auth/sessions")
          return json([]);
        if (
          accepted &&
          mode === "token" &&
          method === "GET" &&
          url === "/api/admin/accounts"
        )
          return json([]);
        if (
          accepted &&
          mode === "token" &&
          method === "GET" &&
          url === "/api/state"
        )
          return json(state);
        unexpected.push(`${method} ${url}`);
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );
    const localStorageWrite = vi.spyOn(Storage.prototype, "setItem");
    mount();
    await screen.findByLabelText(
      "账号",
      {},
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    );
    if (mode !== "password")
      await userEvent.click(
        screen.getByRole("button", {
          name: mode === "invite" ? "我有邀请码" : "管理员令牌登录",
        }),
      );
    if (mode === "token") fill("管理员令牌", "rejected-token");
    else {
      fill("账号", "synthetic-user");
      fill("密码", "synthetic-first-password");
      if (mode === "invite") fill("邀请码", "expired-invite");
    }
    const submit = screen.getByRole("button", {
      name: mode === "invite" ? "创建账号并继续" : "进入工作空间",
    });
    await userEvent.click(submit);
    await waitFor(() => expect(release).toBeDefined());
    expect(submit.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(submit);
    expect(attempts).toBe(1);
    expect(screen.queryByRole("main")).toBeNull();
    expect(calls.some((c) => !c.path.startsWith("/api/auth/"))).toBe(false);
    await act(async () => {
      release(json({ detail: failure }, mode === "invite" ? 400 : 401));
    });
    await screen.findByText(failure);
    expect(screen.queryByRole("main")).toBeNull();
    expect(attempts).toBe(1);
    if (mode === "token") {
      expect(screen.getByLabelText("管理员令牌")).toHaveProperty(
        "value",
        "rejected-token",
      );
      fill("管理员令牌", "corrected-token");
    } else {
      expect(screen.getByLabelText("账号")).toHaveProperty(
        "value",
        "synthetic-user",
      );
      expect(screen.getByLabelText("密码", { exact: true })).toHaveProperty(
        "value",
        "synthetic-first-password",
      );
      if (mode === "invite") {
        expect(screen.getByLabelText("邀请码")).toHaveProperty(
          "value",
          "expired-invite",
        );
        fill("邀请码", "fresh-invite");
      } else fill("密码", "synthetic-corrected-password");
    }
    await userEvent.click(submit);
    await screen.findByRole("heading", { name: "账号安全", level: 1 });
    expect(attempts).toBe(2);
    expect(screen.queryByText(failure)).toBeNull();
    if (mode === "token")
      expect(
        calls.filter((c) => c.path === "/api/auth/me").at(-1)?.authorization,
      ).toBe("Bearer corrected-token");
    else
      expect(
        calls.filter((c) => c.method === "POST").map((c) => c.body),
      ).toEqual([
        {
          username: "synthetic-user",
          password: "synthetic-first-password",
          ...(mode === "invite" ? { token: "expired-invite" } : {}),
        },
        {
          username: "synthetic-user",
          password:
            mode === "invite"
              ? "synthetic-first-password"
              : "synthetic-corrected-password",
          ...(mode === "invite" ? { token: "fresh-invite" } : {}),
        },
      ]);
    expect(localStorageWrite).not.toHaveBeenCalled();
    expect(unexpected).toEqual([]);
  },
);

it("forced-password administrator cannot load admin work or recovery until a successful rotated session", async () => {
  history.replaceState(null, "", "/#nodes");
  let required = true;
  let attempts = 0;
  const unexpected: string[] = [];
  const calls: { path: string; method: string; csrf: string }[] = [];
  const session = () => ({
    user: {
      id: "restricted-admin",
      name: "Restricted admin",
      role: "admin",
      passwordChangeRequired: required,
    },
    csrfToken: required ? "restricted-csrf" : "rotated-csrf",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      calls.push({
        path: url,
        method,
        csrf: new Headers(init?.headers).get("X-CSRF-Token") || "",
      });
      if (url === "/api/auth/me" && method === "GET") return json(session());
      if (url === "/api/auth/sessions" && method === "GET") return json([]);
      if (url === "/api/auth/password" && method === "POST") {
        attempts++;
        if (attempts === 1) return json({ detail: "invalid credentials" }, 403);
        required = false;
        return json(session());
      }
      if (!required && method === "GET" && url === "/api/state")
        return json(state);
      if (!required && method === "GET" && url === "/api/admin/accounts")
        return json([]);
      if (
        !required &&
        method === "GET" &&
        ["/api/services", "/api/published-routes"].includes(url)
      )
        return json([]);
      if (!required && method === "GET" && url === "/api/settings")
        return json({});
      unexpected.push(`${method} ${url}`);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  mount();
  await screen.findByRole(
    "heading",
    { name: "账号安全", level: 1 },
    { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
  );
  const restricted = () => {
    expect(screen.getByText("请先更换临时密码")).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "账号恢复与退役设置" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "管理员二次验证" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "前往管理员二次验证" }),
    ).toBeNull();
    expect(calls.every((c) => c.path.startsWith("/api/auth/"))).toBe(true);
  };
  restricted();
  fill("当前密码", "synthetic-old-password");
  fill("新密码", "synthetic-new-password");
  fill("确认新密码", "synthetic-new-password");
  await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await screen.findByText("当前密码或验证码不正确，请核对后重试。");
  restricted();
  expect(screen.getByLabelText("新密码", { exact: true })).toHaveProperty(
    "value",
    "synthetic-new-password",
  );
  fill("当前密码", "synthetic-correct-password");
  await userEvent.click(screen.getByRole("button", { name: "修改密码" }));
  await waitFor(() =>
    expect(calls.some((c) => c.path === "/api/state")).toBe(true),
  );
  await screen.findByRole("heading", { name: "连接端点", level: 1 });
  expect(screen.queryByText("请先更换临时密码")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "账号安全" }));
  await screen.findByRole("heading", { name: "账号恢复与退役" });
  await screen.findByRole("heading", { name: "管理员二次验证" });
  const mfaRegion = screen.getByRole("region", {
    name: "管理员二次验证设置",
  });
  const mfaPassword = within(mfaRegion).getByLabelText("验证当前账号密码", {
    exact: true,
  });
  fireEvent.change(mfaPassword, { target: { value: "synthetic-mfa-draft" } });
  const beforeNavigation = calls.slice();
  const beforeHistory = { hash: location.hash, length: history.length };
  const mfaLink = screen.getByRole("button", {
    name: "前往管理员二次验证",
  });
  mfaLink.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(mfaRegion);
  await userEvent.click(screen.getByRole("button", { name: "前往修改密码" }));
  await userEvent.click(mfaLink);
  expect(document.activeElement).toBe(mfaRegion);
  expect(
    within(mfaRegion).getByLabelText("验证当前账号密码", { exact: true }),
  ).toBe(mfaPassword);
  expect(mfaPassword).toHaveProperty("value", "synthetic-mfa-draft");
  expect({ hash: location.hash, length: history.length }).toEqual(
    beforeHistory,
  );
  expect(calls).toEqual(beforeNavigation);
  expect(screen.getByLabelText("新密码", { exact: true })).toHaveProperty(
    "value",
    "",
  );
  expect(calls.filter((c) => c.path === "/api/auth/password")).toEqual([
    { path: "/api/auth/password", method: "POST", csrf: "restricted-csrf" },
    { path: "/api/auth/password", method: "POST", csrf: "restricted-csrf" },
  ]);
  expect(unexpected).toEqual([]);
});

it("keeps administrator MFA content and its directory entry absent for an ordinary account", async () => {
  const unexpected: string[] = [];
  const session = {
    user: { id: "ordinary-security", name: "Ordinary", role: "user" },
    csrfToken: "ordinary-csrf",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method === "GET" && url === "/api/auth/me") return json(session);
      if (method === "GET" && url === "/api/auth/sessions") return json([]);
      unexpected.push(`${method} ${url}`);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  mount();
  await screen.findByRole("heading", { name: "账号安全", level: 1 });
  await screen.findByText("没有有效会话。");
  expect(screen.queryByRole("heading", { name: "管理员二次验证" })).toBeNull();
  expect(
    screen.queryByRole("region", { name: "管理员二次验证设置" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "前往管理员二次验证" }),
  ).toBeNull();
  expect(unexpected).toEqual([]);
});

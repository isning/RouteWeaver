// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const session = (id: string) => ({
  user: { id, name: `Account ${id}`, role: "user" }, csrfToken: `csrf-${id}`,
});
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/?invite=synthetic-invite#collections");
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {} }),
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", class extends EventTarget { postMessage() {} close() {} });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(invite: () => Promise<Response>) {
  const writes: { path: string; body: Record<string, string> }[] = [];
  let me: () => Promise<Response> = async () => json({ error: "authentication required" }, 401);
  let login: () => Promise<Response> = async () => json({ error: "invalid credentials" }, 401);
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith("/auth/accept-invite")) return invite();
      if (path.endsWith("/auth/login")) return login();
      throw new Error(`Unexpected write: ${path}`);
    }
    if (path.endsWith("/auth/me")) return me();
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  return { writes, setMe: (read: typeof me) => { me = read; },
    setLogin: (write: typeof login) => { login = write; } };
}
async function fill() {
  fireEvent.change(await screen.findByLabelText("账号"), { target: { value: "invited.user" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "synthetic-password" } });
}
async function create() {
  await userEvent.click(screen.getByRole("button", { name: "创建账号并继续" }));
}

it.each([
  ["lost response", async () => { throw new TypeError("network interrupted"); }],
  ["server session failure", async () => json({ error: "cannot create session" }, 500)],
  ["malformed JSON success", async () => new Response("{", { status: 200 })],
  ["empty success", async () => json(null)],
  ["incomplete success", async () => json({ user: { id: "wrong" } })],
  ["non-string identity", async () => json({ ...session("attempt"),
    user: { id: 42, name: "Attempt", role: "user" } })],
  ["non-string account name", async () => json({ ...session("attempt"),
    user: { id: "attempt", name: 42, role: "user" } })],
  ["empty CSRF token", async () => json({ ...session("attempt"), csrfToken: "" })],
  ["unreadable success body", async () => {
    const response = json(session("attempt"));
    response.text = async () => { throw new TypeError("body interrupted"); };
    return response;
  }],
] as const)("keeps %s uncertain and requires explicit login", async (_name, response) => {
  const persist = vi.spyOn(Storage.prototype, "setItem");
  const { writes } = mount(response);
  await fill();
  await create();
  expect(await screen.findByText("账号创建结果尚未确认")).toBeTruthy();
  await screen.findByRole("button", { name: "返回账号登录" });
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("synthetic-password");
  expect(writes.map((write) => write.path)).toEqual(["/api/auth/accept-invite"]);
  await userEvent.click(screen.getByRole("button", { name: "返回账号登录" }));
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
  expect(screen.queryByLabelText("邀请码")).toBeNull();
  expect(writes).toHaveLength(1);
  await fill();
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({ path: "/api/auth/login", body: {
    username: "invited.user", password: "synthetic-password",
  } });
  expect(persist).not.toHaveBeenCalled();
});

it("does not let a later rejected invite erase earlier creation uncertainty", async () => {
  let attempts = 0;
  const { writes } = mount(async () => ++attempts === 1
    ? json({ error: "cannot create session" }, 500)
    : json({ error: "invalid invite" }, 400));
  await fill();
  await create();
  await screen.findByText("账号创建结果尚未确认");
  await screen.findByRole("button", { name: "创建账号并继续" });
  await create();
  await screen.findByText("invalid invite");
  expect(screen.getByText("账号创建结果尚未确认")).toBeTruthy();
  expect(writes).toHaveLength(2);
});

it("keeps a definite rejection editable without inventing creation uncertainty", async () => {
  const { writes } = mount(async () => json({ error: "username already exists" }, 400));
  await fill();
  await create();
  await screen.findByText("username already exists");
  expect(screen.queryByText("账号创建结果尚未确认")).toBeNull();
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("synthetic-password");
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "corrected.user" } });
  await create();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body.username).toBe("corrected.user");
});

it("sends one creation while pending and ignores an old failure after mode exit", async () => {
  const pending = deferred<Response>();
  const { writes } = mount(() => pending.promise);
  await fill();
  const form = screen.getByLabelText("账号").closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(writes).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "返回账号登录" }));
  fireEvent.change(screen.getByLabelText("账号"), { target: { value: "newer.user" } });
  await act(async () => { pending.resolve(json({ error: "old failure" }, 500)); });
  expect(screen.queryByText("old failure")).toBeNull();
  expect(screen.queryByText("账号创建结果尚未确认")).toBeNull();
  expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe("newer.user");
  expect(writes).toHaveLength(1);
});

it("does not dispatch validation that finishes after leaving the invitation form", async () => {
  const { writes } = mount(async () => json(session("attempt")));
  await fill();
  act(() => {
    fireEvent.submit(screen.getByLabelText("账号").closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: "返回账号登录" }));
  });
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("heading", { name: "登录 RouteWeaver" })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("does not queue creation when offline or replay it on reconnect", async () => {
  const { writes } = mount(async () => json(session("attempt")));
  await fill();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  await create();
  await screen.findByText("网络已断开，本次操作未发送。连接恢复后请重新提交。");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await screen.findByRole("button", { name: "创建账号并继续" });
  expect(writes).toEqual([]);
});

it("waits for authoritative me even when an obsolete creation returns success", async () => {
  const creation = deferred<Response>();
  const confirmation = deferred<Response>();
  const flow = mount(() => creation.promise);
  await fill();
  await create();
  await waitFor(() => expect(flow.writes).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "返回账号登录" }));
  flow.setMe(() => confirmation.promise);
  await act(async () => { creation.resolve(json(session("untrusted-response"))); });
  expect(screen.queryByRole("navigation", { name: "工作空间导航" })).toBeNull();
  await act(async () => { confirmation.resolve(json(session("authoritative"))); });
  expect(await screen.findByRole("navigation", { name: "工作空间导航" })).toBeTruthy();
  expect(screen.getByText("Account authoritative")).toBeTruthy();
  expect(screen.queryByText("Account untrusted-response")).toBeNull();
  expect(flow.writes).toHaveLength(1);
});


it("reconciles a malformed success through me without retrying creation or logging in", async () => {
  const flow = mount(async () => {
    flow.setMe(async () => json(session("confirmed-cookie")));
    return json(null);
  });
  await fill();
  await create();
  expect(await screen.findByRole("navigation", { name: "工作空间导航" })).toBeTruthy();
  expect(screen.getByText("Account confirmed-cookie")).toBeTruthy();
  expect(flow.writes.map((write) => write.path)).toEqual(["/api/auth/accept-invite"]);
});

it.each([
  ["lost body", async () => {
    const response = json(session("untrusted-login-body"));
    response.text = async () => { throw new TypeError("body interrupted"); };
    return response;
  }],
  ["lost response", async () => { throw new TypeError("network interrupted"); }],
  ["malformed response", async () => new Response("{", { status: 200 })],
  ["incomplete session", async () => json({ user: { id: "untrusted-login-body" } })],
] as const)("enters the cookie-confirmed workspace after password login %s without resubmitting credentials", async (_name, response) => {
  history.replaceState(null, "", "/#collections");
  const flow = mount(async () => { throw new Error("unexpected invite"); });
  flow.setLogin(async () => {
    flow.setMe(async () => json(session("confirmed-password-login")));
    return response();
  });
  await fill();
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  expect(await screen.findByText("Account confirmed-password-login")).toBeTruthy();
  expect(screen.queryByText("Account untrusted-login-body")).toBeNull();
  expect(flow.writes.map((write) => write.path)).toEqual(["/api/auth/login"]);
});


it.each([400, 401, 403, 404, 413, 429])("retains password/TOTP inputs after definite login rejection %s without checking or replaying", async (status) => {
  history.replaceState(null, "", "/#collections");
  const flow = mount(async () => { throw new Error("unexpected invite"); });
  await fill();
  const read = vi.fn(async () => json(session("must-not-adopt")));
  flow.setMe(read);
  flow.setLogin(async () => json({ error: "Credentials rejected" }, status));
  await userEvent.click(screen.getByText("使用二次验证码"));
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByText("Credentials rejected");
  expect(read).not.toHaveBeenCalled();
  expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe("invited.user");
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("synthetic-password");
  expect((screen.getByLabelText("验证码") as HTMLInputElement).value).toBe("123456");
  expect(flow.writes).toHaveLength(1);
});

it("preserves login inputs when session reconciliation fails and reconnects with reads only", async () => {
  history.replaceState(null, "", "/#collections");
  const flow = mount(async () => { throw new Error("unexpected invite"); });
  flow.setLogin(async () => {
    flow.setMe(async () => json({ error: "temporarily unavailable" }, 503));
    throw new TypeError("login response lost");
  });
  await fill();
  await userEvent.click(screen.getByText("使用二次验证码"));
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByText("暂时无法确认登录状态");
  expect(screen.queryByRole("button", { name: "进入工作空间" })).toBeNull();
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("synthetic-password");
  expect((screen.getByLabelText("验证码") as HTMLInputElement).value).toBe("123456");
  flow.setMe(async () => json({ error: "authentication required" }, 401));
  await userEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await screen.findByRole("button", { name: "进入工作空间" });
  expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe("invited.user");
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("synthetic-password");
  expect((screen.getByLabelText("验证码") as HTMLInputElement).value).toBe("123456");
  expect(flow.writes).toHaveLength(1);
});

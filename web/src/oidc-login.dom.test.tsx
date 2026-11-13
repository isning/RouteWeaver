// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
const clients: QueryClient[] = [];
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client); render(<QueryClientProvider client={client}><Workspace /></QueryClientProvider>); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const session = (id: string) => ({ user: { id, name: `Account ${id}`, role: "user" }, csrfToken: `csrf-${id}` });
beforeEach(() => {
  setToken(""); setCSRF("");
  history.replaceState(null, "", "/");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  const style = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => style(element));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/"); });

it("finishes OIDC only on explicit confirmation and trusts the checked cookie identity", async () => {
  history.replaceState(null, "", "/?oidc=complete");
  let loggedIn = false;
  const complete = vi.fn();
  const storage = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me")) return loggedIn ? json(session("checked")) : json({}, 401);
    if (url.endsWith("/auth/oidc")) return json({ enabled: true, label: "Company" });
    if (url.endsWith("/auth/oidc/complete")) { complete(init); loggedIn = true; return json(session("untrusted-payload")); }
    return json([]);
  }));
  mount();
  const button = await screen.findByRole("button", { name: "完成单点登录" });
  expect(location.search).toBe("");
  expect(complete).not.toHaveBeenCalled();
  await userEvent.click(button);
  await screen.findByText("Account checked");
  expect(screen.queryByText("Account untrusted-payload")).toBeNull();
  expect(complete).toHaveBeenCalledOnce();
  expect(JSON.parse(complete.mock.calls[0][0].body)).toEqual({});
  expect(storage).not.toHaveBeenCalled();
});

it("requires the local MFA code and consumes a failed pending login without leaking its error", async () => {
  history.replaceState(null, "", "/?oidc=mfa");
  const complete = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me")) return json({}, 401);
    if (url.endsWith("/auth/oidc")) return json({ enabled: true, label: "Company" });
    if (url.endsWith("/auth/oidc/complete")) { complete(JSON.parse(String(init?.body))); return json({ error: "private-provider-detail" }, 401); }
    return json([]);
  }));
  mount();
  const code = await screen.findByLabelText("二次验证码");
  expect(location.search).toBe("");
  await userEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  expect(complete).not.toHaveBeenCalled();
  fireEvent.change(code, { target: { value: "123456" } });
  await userEvent.click(screen.getByRole("button", { name: "验证并登录" }));
  await screen.findByText("单点登录未完成或验证已过期，请重新使用单点登录，或改用账号密码。");
  expect(complete).toHaveBeenCalledWith({ totp: "123456" });
  expect(screen.queryByLabelText("二次验证码")).toBeNull();
  expect(screen.getByLabelText("账号")).toBeTruthy();
  expect(await screen.findByRole("button", { name: "使用 Company 登录" })).toBeTruthy();
  expect(document.body.textContent).not.toContain("private-provider-detail");
});

it("keeps password login available on OIDC errors and disables duplicate starts", async () => {
  history.replaceState(null, "", "/?oidc=error#collections");
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  let starts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/me")) return json({}, 401);
    if (url.endsWith("/auth/oidc")) return json({ enabled: true, label: "Company" });
    if (url.endsWith("/auth/oidc/start")) { starts++; return pending; }
    return json([]);
  }));
  mount();
  await screen.findByText("单点登录未完成。请重试，或使用账号密码登录。");
  expect(location.search).toBe(""); expect(location.hash).toBe("#collections");
  expect(screen.getByLabelText("密码")).toBeTruthy();
  expect(screen.queryByText("单点登录会离开此页并丢失未保存内容。请使用账号密码登录以保留草稿。")).toBeNull();
  const start = await screen.findByRole("button", { name: "使用 Company 登录" });
  fireEvent.click(start); fireEvent.click(start);
  await waitFor(() => expect(starts).toBe(1));
  finish(json({ authorizationUrl: "http://localhost/authorize" }));
  await screen.findByText("暂时无法开始单点登录，请重试，或使用账号密码登录。");
  expect(screen.getByRole("button", { name: "进入工作空间" }).hasAttribute("disabled")).toBe(false);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionBoundary } from "./SessionBoundary";
import { SecuritySettings } from "./Security";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const session = (id: string) => ({ user: { id, name: id, role: "admin", mfaEnabled: false }, csrfToken: `synthetic-${id}` });
let client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  setToken("");
  setCSRF("");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); });
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SessionBoundary login={() => <p>Login</p>}><SecuritySettings /></SessionBoundary></QueryClientProvider>);
}
async function prepare() {
  fireEvent.change(await screen.findByLabelText("验证当前账号密码"), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await screen.findByLabelText("验证器验证码");
}
it("closes local setup without submitting enable and starts with blank credentials and no previous error", async () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me")) return json(session("A"));
    writes.push(url);
    if (url.endsWith("/mfa/setup")) return json({ secret: "SYNTHETIC-SETUP", uri: "otpauth://totp/test?secret=SYNTHETIC" });
    return json({ error: "invalid enrollment code" }, 400);
  });
  mount();
  await prepare();
  fireEvent.change(screen.getByLabelText("验证器验证码"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并启用" }));
  await screen.findByText("invalid enrollment code");
  fireEvent.click(screen.getByRole("button", { name: "关闭设置" }));
  await waitFor(() => expect(screen.queryByLabelText("验证器设置密钥")).toBeNull());
  expect((screen.getByLabelText("验证当前账号密码") as HTMLInputElement).value).toBe("");
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
  await prepare();
  expect((screen.getByLabelText("验证器验证码") as HTMLInputElement).value).toBe("");
  expect(screen.queryByText("invalid enrollment code")).toBeNull();
});
it("does not show a late setup response after the owning task was removed", async () => {
  let finish!: (response: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) return json(session("A"));
    writes.push(url);
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const view = mount();
  fireEvent.change(await screen.findByLabelText("验证当前账号密码"), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
  await waitFor(() => expect(writes).toEqual(["/api/auth/mfa/setup"]));
  view.unmount();
  await act(async () => { finish(json({ secret: "SYNTHETIC-LATE", uri: "otpauth://totp/late" })); });
  mount();
  await screen.findByLabelText("验证当前账号密码");
  expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
  expect(screen.queryByLabelText("验证器验证码")).toBeNull();
  expect(writes).toEqual(["/api/auth/mfa/setup"]);
});

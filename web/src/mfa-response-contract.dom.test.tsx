// @vitest-environment jsdom
// Real security controls with synthetic HTTP responses; no native authenticator claim.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { SessionBoundary, useSessionAccess } from "./SessionBoundary";
import { SecuritySettings } from "./Security";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const session = (id = "A", enabled = false, token = `synthetic-${id}`) => ({
  user: { id, name: id, role: "admin", mfaEnabled: enabled }, csrfToken: token,
});
const material = (id = "A") => ({ secret: `SYNTHETIC-${id}`, uri: `otpauth://totp/test?secret=SYNTHETIC-${id}` });
const unknownResult = "启用结果尚未确认。请先核对当前登录状态，不要重复提交。";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
let client: QueryClient;
beforeEach(() => {
  setToken("");
  setCSRF("");
  vi.spyOn(toast, "success");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Owner() {
  const { snapshot } = useSessionAccess();
  return <p>Current account: {snapshot.session?.user.id}</p>;
}
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <SessionBoundary login={() => <p>Login</p>}><Owner /><SecuritySettings /></SessionBoundary>
  </QueryClientProvider>);
}
async function submitSetup() {
  fireEvent.change(await screen.findByLabelText("验证当前账号密码"), { target: { value: "synthetic-password" } });
  fireEvent.click(screen.getByRole("button", { name: "设置二次验证" }));
}
async function prepare() {
  await submitSetup();
  await screen.findByLabelText("验证器验证码");
}
function submitEnable() {
  fireEvent.change(screen.getByLabelText("验证器验证码"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "验证并启用" }));
}

it.each([
  { name: "null", value: null },
  { name: "missing fields", value: {} },
  { name: "blank secret", value: { secret: "  ", uri: material().uri } },
  { name: "nonstring secret", value: { secret: 123, uri: material().uri } },
  { name: "blank URI", value: { secret: material().secret, uri: "" } },
  { name: "nonstring URI", value: { secret: material().secret, uri: {} } },
])("rejects $name setup material without displaying a QR/code task or losing the password draft", async ({ value }) => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) return json(session());
    writes.push(url);
    return json(value);
  });
  mount();
  await submitSetup();
  await screen.findByText("未收到完整的验证器设置，请重新设置二次验证。");
  expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
  expect(screen.queryByLabelText("验证器验证码")).toBeNull();
  expect((screen.getByLabelText("验证当前账号密码") as HTMLInputElement).value).toBe("synthetic-password");
  expect(writes).toEqual(["/api/auth/mfa/setup"]);
  expect(toast.success).not.toHaveBeenCalled();
});

it.each([
  { name: "empty response", response: () => json(null) },
  { name: "generic acknowledgement", response: () => json({ ok: true }) },
  { name: "different actor", response: () => json(session("B", true)) },
  { name: "wrong role", response: () => json({ ...session("A", true), user: { ...session("A", true).user, role: "user" } }) },
  { name: "disabled MFA", response: () => json(session()) },
  { name: "nonboolean enabled flag", response: () => json({ ...session(), user: { ...session().user, mfaEnabled: "true" } }) },
  { name: "empty CSRF", response: () => json(session("A", true, " ")) },
  { name: "malformed JSON", response: () => new Response("not-json", { status: 200 }) },
  { name: "server error", response: () => json({ error: "response unavailable" }, 500) },
  { name: "lost response", response: (): Response => { throw new TypeError("response lost"); } },
])("rechecks authority after $name enable, keeps uncertainty visible and does not replay", async ({ response }) => {
  let reads = 0;
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) { reads++; return json(session()); }
    writes.push(url);
    return url.endsWith("/mfa/setup") ? json(material()) : response();
  });
  mount();
  await prepare();
  submitEnable();
  await screen.findByText(unknownResult);
  expect(reads).toBe(2);
  expect(screen.queryByRole("heading", { name: "二次验证已启用" })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "验证并启用" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect((screen.getByLabelText("验证器验证码") as HTMLInputElement).value).toBe("");
  // Even a queued native submit must respect the uncertain-flow guard.
  await act(async () => {
    fireEvent.change(screen.getByLabelText("验证器验证码"), { target: { value: "654321" } });
    fireEvent.submit(button.closest("form")!);
  });
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
});

it.each(["valid receipt", "malformed receipt"])("shows enabled only after authoritative reconciliation of a %s", async (kind) => {
  let reads = 0;
  const refreshed = deferred<Response>();
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) return ++reads === 1 ? json(session()) : refreshed.promise;
    writes.push(url);
    return url.endsWith("/mfa/setup") ? json(material()) : json(kind === "valid receipt" ? session("A", true, "rotated") : {});
  });
  mount();
  await prepare();
  submitEnable();
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByRole("heading", { name: "二次验证已启用" })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  await act(async () => { refreshed.resolve(json(session("A", true, "rotated"))); });
  await screen.findByRole("heading", { name: "二次验证已启用" });
  expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
  expect(screen.queryByLabelText("验证器验证码")).toBeNull();
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
  expect(toast.success).not.toHaveBeenCalled();
});

it.each(["still disabled", "read fails"])("does not claim enable success from a valid receipt when the authority is %s", async (outcome) => {
  let reads = 0;
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) {
      reads++;
      return reads === 1 || outcome === "still disabled" ? json(session()) : json({ error: "session lookup unavailable" }, 503);
    }
    writes.push(url);
    return json(url.endsWith("/mfa/setup") ? material() : session("A", true, "rotated"));
  });
  mount();
  await prepare();
  submitEnable();
  if (outcome === "still disabled") await screen.findByLabelText("验证当前账号密码");
  else await screen.findByText("暂时无法确认登录状态");
  expect(reads).toBe(2);
  expect(screen.queryByRole("heading", { name: "二次验证已启用" })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
});

it.each([400, 429])("retains the setup and code after a definite %s enable rejection, allowing a fresh code submission", async (status) => {
  let reads = 0;
  const codes: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/auth/me")) { reads++; return json(session()); }
    if (url.endsWith("/mfa/setup")) return json(material());
    codes.push(JSON.parse(String(init?.body)).code);
    return json({ error: "enrollment rejected" }, status);
  });
  mount();
  await prepare();
  submitEnable();
  await screen.findByText("enrollment rejected");
  expect((screen.getByLabelText("验证器验证码") as HTMLInputElement).value).toBe("123456");
  const button = screen.getByRole("button", { name: "验证并启用" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("验证器验证码"), { target: { value: "654321" } });
  fireEvent.click(button);
  await waitFor(() => expect(codes).toEqual(["123456", "654321"]));
  expect(reads).toBe(1);
  expect(screen.queryByText(unknownResult)).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not apply an old actor's delayed enable receipt or uncertainty to a new actor's enrollment", async () => {
  let current = session();
  const enabled = deferred<Response>();
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) return json(current);
    writes.push(url);
    return url.endsWith("/mfa/setup") ? json(material(current.user.id)) : enabled.promise;
  });
  mount();
  await prepare();
  submitEnable();
  await waitFor(() => expect(writes).toHaveLength(2));
  current = session("B");
  fireEvent(window, new Event("focus"));
  await screen.findByText("Current account: B");
  await prepare();
  await act(async () => { enabled.resolve(json(session("A", true, "rotated-A"))); });
  await waitFor(() => expect((screen.getByRole("button", { name: "验证并启用" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("验证器设置密钥") as HTMLInputElement).value).toBe(material("B").secret);
  expect(screen.queryByText(unknownResult)).toBeNull();
  expect(screen.queryByRole("heading", { name: "二次验证已启用" })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable", "/api/auth/mfa/setup"]);
});

it.each([401, 503])("discards enrollment material when an uncertain enable is followed by a %s authority response", async (status) => {
  let reads = 0;
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/auth/me")) {
      return ++reads === 1 ? json(session()) : json({ error: "session unavailable" }, status);
    }
    writes.push(url);
    return url.endsWith("/mfa/setup") ? json(material()) : json({});
  });
  mount();
  await prepare();
  submitEnable();
  await screen.findByRole("region", { name: "恢复登录" });
  expect(screen.getByText(status === 401 ? "Login" : "暂时无法确认登录状态")).toBeTruthy();
  expect(reads).toBe(2);
  expect(screen.queryByLabelText("验证器设置密钥")).toBeNull();
  expect(screen.queryByLabelText("验证器验证码")).toBeNull();
  expect(screen.queryByRole("heading", { name: "二次验证已启用" })).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
  expect(writes).toEqual(["/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
});

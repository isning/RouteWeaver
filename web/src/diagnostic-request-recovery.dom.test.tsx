// @vitest-environment jsdom
// Source-only reconstruction. All behavior checks UNRUN; no diagnostic traffic.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionBoundary } from "./SessionBoundary";
import { DiagnosticStartForm } from "./Diagnostics";

const session = { user: { id: "admin-a", role: "admin", name: "Admin" }, csrfToken: "secret-not-for-storage" };
const target = { id: "target", nodeId: "host", name: "Owned target", url: "https://example.test/probe", methods: ["connectivity" as const] };
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/xray", version: "26.10.31" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const key = "routeweaver.diagnostic-request.v1.admin-a";
function mount(onCreated = vi.fn()) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <SessionBoundary login={() => <p>Login</p>}>
      <DiagnosticStartForm targets={[target]} instances={[instance]} onClose={() => {}} onCreated={onCreated} />
    </SessionBoundary>
  </QueryClientProvider>);
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function submit() {
  for (const [label, option] of [["执行实例", "Core"], ["授权目标", "Owned target"], ["测试方式", "连通性"]]) {
    fireEvent.click(await screen.findByLabelText(label));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }
  await userEvent.click(screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"));
  await userEvent.click(screen.getByRole("button", { name: "提交测试" }));
}
it("persists before sending, retains an unknown request across remount and 404, then reconciles only its exact actor-bound receipt", async () => {
  const writes: any[] = [], reads: string[] = [];
  let available = false;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (path === "/api/auth/me") return json(session);
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ actorId: "admin-a", request: body });
      expect(sessionStorage.getItem(key)).not.toContain(session.csrfToken);
      writes.push(body);
      throw new TypeError("lost response");
    }
    reads.push(path);
    return available ? json({ ...writes[0], requestedBy: "admin-a", status: "queued" }) : json({ error: "missing" }, 404);
  }));
  const first = mount();
  await submit();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  first.unmount();
  const completed = vi.fn();
  mount(completed);
  await userEvent.click(await screen.findByRole("button", { name: "核对上次测试提交" }));
  await screen.findByText("尚未查到该次测试，提交结果仍未确认。");
  expect(screen.queryByRole("button", { name: "提交测试" })).toBeNull();
  expect(sessionStorage.getItem(key)).not.toBeNull();
  available = true;
  await userEvent.click(screen.getByRole("button", { name: "核对上次测试提交" }));
  await waitFor(() => expect(completed).toHaveBeenCalledWith(expect.objectContaining({ id: writes[0].id })));
  expect(reads).toEqual([`/api/admin/diagnostic-jobs/${writes[0].id}`, `/api/admin/diagnostic-jobs/${writes[0].id}`]);
  expect(writes).toHaveLength(1);
  expect(sessionStorage.getItem(key)).toBeNull();
});

const saved = { version: 1, actorId: "admin-a", request: { id: "probe-pending", targetId: "target", instanceId: "core", pathMode: "node_direct", kind: "connectivity", maxBytes: 0, timeoutSeconds: 10 } };
it("never posts when the pre-send session record cannot be persisted", async () => {
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === "/api/auth/me") return json(session);
    writes.push(String(init?.method));
    return json({});
  }));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full"); });
  mount();
  await submit();
  await screen.findByText("无法保存本页测试提交记录，尚未发送。请允许浏览器保存会话记录后重试。");
  expect(writes).toEqual([]);
});
it("preserves corrupt bytes until explicit consequence-aware confirmation, without a POST", async () => {
  sessionStorage.setItem(key, "broken record");
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url) === "/api/auth/me") return json(session);
    writes.push(String(url)); return json({});
  }));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "清除无法读取的记录" }));
  await screen.findByText("这不会取消原测试。原测试可能已产生流量，重新提交可能重复产生流量。请先检查节点测试记录。");
  expect(sessionStorage.getItem(key)).toBe("broken record");
  await userEvent.click(screen.getByRole("button", { name: "保留记录" }));
  expect(sessionStorage.getItem(key)).toBe("broken record");
  await userEvent.click(screen.getByRole("button", { name: "清除无法读取的记录" }));
  await userEvent.click(screen.getByRole("button", { name: "清除本页记录" }));
  await screen.findByRole("button", { name: "提交测试" });
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(writes).toEqual([]);
});
it.each(["id", "requestedBy", "maxBytes"])("does not accept a successful lookup with mismatched %s", async (field) => {
  const raw = JSON.stringify(saved);
  sessionStorage.setItem(key, raw);
  const completed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url) === "/api/auth/me" ? json(session) : json({
    ...saved.request, requestedBy: "admin-a", status: "queued", [field]: field === "maxBytes" ? 1024 : "other",
  })));
  mount(completed);
  await userEvent.click(await screen.findByRole("button", { name: "核对上次测试提交" }));
  await screen.findByText("测试提交结果未确认。请核对上次提交，避免重复产生流量。");
  expect(completed).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe(raw);
});
it("does not consume an actor's pending record or adopt its delayed response after an account change", async () => {
  const raw = JSON.stringify(saved);
  sessionStorage.setItem(key, raw);
  let currentSession = session;
  let resolveRead!: (response: Response) => void;
  const completed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url) === "/api/auth/me") return json(currentSession);
    return new Promise<Response>((resolve) => { resolveRead = resolve; });
  }));
  mount(completed);
  await userEvent.click(await screen.findByRole("button", { name: "核对上次测试提交" }));
  await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
  currentSession = { ...session, user: { ...session.user, id: "admin-b" }, csrfToken: "other-secret" };
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: "提交测试" });
  resolveRead(json({ ...saved.request, requestedBy: "admin-a", status: "queued" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "核对上次测试提交" })).toBeNull());
  expect(completed).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe(raw);
});

it.each(["account", "generation"])("does not apply a corrupt-record confirmation after the %s changes", async (change) => {
  sessionStorage.setItem(key, "broken-a");
  const keyB = "routeweaver.diagnostic-request.v1.admin-b";
  sessionStorage.setItem(keyB, "broken-b");
  let currentSession = session;
  vi.stubGlobal("fetch", vi.fn(async () => json(currentSession)));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "清除无法读取的记录" }));
  await screen.findByRole("button", { name: "清除本页记录" });
  currentSession = { ...session, user: { ...session.user, id: change === "account" ? "admin-b" : "admin-a" }, csrfToken: "rotated-secret" };
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(document.querySelector("[data-session-workspace]")?.getAttribute("aria-busy")).toBe("false"));
  const staleConfirmation = screen.queryByRole("button", { name: "清除本页记录" });
  if (staleConfirmation) await userEvent.click(staleConfirmation);
  expect(sessionStorage.getItem(key)).toBe("broken-a");
  expect(sessionStorage.getItem(keyB)).toBe("broken-b");
});

it("abandons a valid unknown record only after a named warning, and sends nothing until a fresh explicit submission", async () => {
  const raw = JSON.stringify(saved);
  sessionStorage.setItem(key, raw);
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === "/api/auth/me") return json(session);
    if (init?.method === "POST") { writes.push(JSON.parse(init.body)); throw new TypeError("lost"); }
    return json({ error: "missing" }, 404);
  }));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "清除本页提交记录" }));
  await screen.findByText(/测试请求 probe-pending，目标 Owned target（target）。原测试可能仍在运行或已产生流量/);
  await userEvent.click(screen.getByRole("button", { name: "保留记录" }));
  expect(sessionStorage.getItem(key)).toBe(raw);
  expect(writes).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "清除本页提交记录" }));
  await userEvent.click(screen.getByRole("button", { name: "清除本页记录" }));
  await screen.findByRole("button", { name: "提交测试" });
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(writes).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "提交测试" }));
  await screen.findByText("请确认测试目标与流量上限");
  expect(writes).toEqual([]);
  await submit();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  expect(writes).toHaveLength(1);
  expect(writes[0].id).not.toBe("probe-pending");
});
it("keeps a valid record when its abandon confirmation belongs to an obsolete session generation", async () => {
  const raw = JSON.stringify(saved);
  sessionStorage.setItem(key, raw);
  let currentSession = session;
  vi.stubGlobal("fetch", vi.fn(async () => json(currentSession)));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "清除本页提交记录" }));
  await screen.findByRole("button", { name: "清除本页记录" });
  currentSession = { ...session, csrfToken: "new-generation-secret" };
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(document.querySelector("[data-session-workspace]")?.getAttribute("aria-busy")).toBe("false"));
  await userEvent.click(screen.getByRole("button", { name: "清除本页记录" }));
  expect(sessionStorage.getItem(key)).toBe(raw);
  await screen.findByRole("button", { name: "核对上次测试提交" });
});

it("does not turn repeated form submissions into a new request across abandonment and fresh consent", async () => {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === "/api/auth/me") return json(session);
    if (init?.method === "POST") { writes.push(JSON.parse(init.body)); throw new TypeError("lost"); }
    return json({ error: "missing" }, 404);
  }));
  mount();
  for (const [label, option] of [["执行实例", "Core"], ["授权目标", "Owned target"], ["测试方式", "连通性"]]) {
    fireEvent.click(await screen.findByLabelText(label));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }
  await userEvent.click(screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"));
  const form = screen.getByRole("button", { name: "提交测试" }).closest("form")!;
  // Native submit events exercise real asynchronous form validation, without
  // replacing the form module or invoking a private completion callback.
  fireEvent.submit(form);
  fireEvent.submit(form);
  await userEvent.click(await screen.findByRole("button", { name: "清除本页提交记录" }));
  await userEvent.click(screen.getByRole("button", { name: "清除本页记录" }));
  await screen.findByRole("button", { name: "提交测试" });
  expect(writes).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "提交测试" }));
  await screen.findByText("请确认测试目标与流量上限");
  expect(writes).toHaveLength(1);
  await submit();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  expect(writes).toHaveLength(2);
  expect(writes[1].id).not.toBe(writes[0].id);
  expect(writes[0]).not.toHaveProperty("diagnosticRequestId");
  expect(writes[1]).not.toHaveProperty("diagnosticRequestId");
});

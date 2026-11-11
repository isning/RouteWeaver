// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
const clients: QueryClient[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  setCSRF(""); setToken("");
});
it.for(["saved", "rejected", "response-lost", "activation-response-lost"] as const)("keeps origin read authority and draft recovery after a %s write in the actual workspace", async (outcome, context) => {
  const owner = ownedClickScenario(context);
  const saveSucceeded = outcome === "saved" || outcome === "activation-response-lost";
  vi.stubEnv("NODE_ENV", "development"); setCSRF(""); setToken("");
  history.replaceState(null, "", "#settings");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const old = {
    revision: 4, configuredRevision: 2, effectiveRevision: 2,
    draftOrigin: "https://old.example", effectiveOrigin: "https://old.example", defaultOrigin: "",
    verificationStatus: "expired", tokensUnchanged: true,
    currentLinkExample: "https://old.example/feed/{existing-token}",
    proposedLinkExample: "https://old.example/feed/{existing-token}",
  };
  const saved = { ...old, revision: 5, configuredRevision: 5,
    draftOrigin: "https://new.example", verificationStatus: "unverified",
    proposedLinkExample: "https://new.example/feed/{existing-token}" };
  const verified = { ...saved, revision: 6, verificationStatus: "verified",
    verifiedAt: "2026-11-11T08:00:00Z", verificationExpiresAt: "2026-11-11T08:05:00Z" };
  const activated = { ...verified, revision: 7, effectiveRevision: 5,
    effectiveOrigin: "https://new.example", currentLinkExample: saved.proposedLinkExample,
    activatedAt: "2026-11-11T08:01:00Z" };
  let originReads = 0;
  let finishRead!: (response: Response) => void;
  let delayedRead = new Promise<Response>(resolve => { finishRead = resolve; });
  const writes: { method: string; url: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input), method = init?.method || "GET";
    if (method === "POST" && ["/api/admin/subscription-origin/verify", "/api/admin/subscription-origin/activate"].includes(url)) {
      writes.push({ method, url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/verify")) return json(verified);
      if (outcome === "activation-response-lost") throw new TypeError("Controlled lost activation response");
      return json(activated);
    }
    if (url === "/api/admin/subscription-origin") {
      if (method === "PUT") {
        writes.push({ method, url, body: JSON.parse(String(init?.body)) });
        if (outcome === "rejected") return new Response(JSON.stringify({ error: "subscription origin must use a public HTTPS address" }), { status: 400 });
        if (outcome === "response-lost") throw new TypeError("Controlled lost response after commit");
        return json(saved);
      }
      if (method === "GET") {
        originReads++;
        if (originReads === 1) return json(old);
        if ([2, 4, 5].includes(originReads)) return delayedRead;
        if (originReads >= 6) return json(activated);
        return json(outcome === "rejected" ? old : saved);
      }
    }
    if (method === "GET") {
      if (url === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "fixture" });
      if (url === "/api/settings") return json({ name: "Origin fixture", timezone: "UTC+8", registration: "invite" });
      if (url === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
      if (["/api/published-routes", "/api/services", "/api/rates"].includes(url)) return json([]);
    }
    unexpected.push(`${method} ${url}`); throw new Error(`Unexpected request ${method} ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false },
  } }); clients.push(client);
  render(<UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders>);
  const input = await screen.findByRole("textbox", { name: "订阅域名草稿" }) as HTMLInputElement;
  const section = within(screen.getByRole("region", { name: "订阅域名设置" }));
  owner.assertActive();
  await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
  await waitFor(() => expect(originReads).toBe(2));
  owner.change(() => input, { target: { value: "https://new.example" } });
  await owner.click(() => section.getByRole("button", { name: "保存域名草稿" }));
  if (saveSucceeded) {
    expect((await section.findByRole("status")).textContent).toBe("域名草稿已保存，当前订阅地址未改变");
  } else {
    await section.findByText(outcome === "rejected" ? "订阅地址不能使用私有网络" : "保存域名草稿失败");
    expect(section.queryByRole("status")).toBeNull();
  }
  expect(writes).toEqual([{ method: "PUT", url: "/api/admin/subscription-origin", body: {
    origin: "https://new.example", expectedRevision: 4,
  } }]);
  // GET read revision 4 before PUT committed revision 5; only delivery is delayed.
  await act(async () => { finishRead(json(old)); });
  // Transport microtasks settle first; then drain the observer's scheduled update.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  owner.assertActive(); expect(unexpected).toEqual([]);
  expect(input.value).toBe("https://new.example");
  if (saveSucceeded) {
    expect(section.queryByText("尚未保存", { exact: true })).toBeNull();
    expect(section.getByText("https://new.example/feed/{existing-token}")).toBeTruthy();
    expect(section.getByRole("button", { name: "验证 HTTPS 与实例" }).hasAttribute("disabled")).toBe(false);
  } else {
    expect(section.getByText("尚未保存", { exact: true })).toBeTruthy();
    expect(section.getByRole("button", { name: "验证 HTTPS 与实例" }).hasAttribute("disabled")).toBe(true);
    expect(section.queryByRole("status")).toBeNull();
  }
  expect(section.getByText("当前链接示例").closest("div")?.textContent).toContain("https://old.example/feed/{existing-token}");
  expect(screen.queryByRole("dialog", { name: "启用订阅地址" })).toBeNull();
  expect(section.getByRole("button", { name: "启用已保存草稿" }).hasAttribute("disabled")).toBe(true);
  // Cancellation must not disable a later deliberate authoritative read.
  await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
  await waitFor(() => expect(originReads).toBe(3));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(input.value).toBe("https://new.example");
  if (outcome === "rejected") {
    expect(section.getByText("尚未保存", { exact: true })).toBeTruthy();
    expect(section.getByRole("button", { name: "验证 HTTPS 与实例" }).hasAttribute("disabled")).toBe(true);
  } else {
    await waitFor(() => expect(section.queryByText("尚未保存", { exact: true })).toBeNull());
    expect(section.getByText("https://new.example/feed/{existing-token}")).toBeTruthy();
    expect(section.getByRole("button", { name: "验证 HTTPS 与实例" }).hasAttribute("disabled")).toBe(false);
  }
  expect(section.queryByRole("status")).toBeNull();
  expect(section.getByRole("button", { name: "启用已保存草稿" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("dialog", { name: "启用订阅地址" })).toBeNull();
  expect(writes).toHaveLength(1);
  if (saveSucceeded) {
    // A normal refresh can overlap verification too; its old proof must not win.
    delayedRead = new Promise<Response>(resolve => { finishRead = resolve; });
    await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(originReads).toBe(4));
    await owner.click(() => section.getByRole("button", { name: "验证 HTTPS 与实例" }));
    await section.findByText("已验证 HTTPS 地址属于当前实例");
    await act(async () => { finishRead(json(saved)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(section.getByText("草稿已验证", { exact: true })).toBeTruthy();
    expect(writes).toHaveLength(2);
    // Start a read, then explicitly review and consent to activation.
    delayedRead = new Promise<Response>(resolve => { finishRead = resolve; });
    await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(originReads).toBe(5));
    await owner.click(() => section.getByRole("button", { name: "启用已保存草稿" }));
    const review = within(await screen.findByRole("dialog", { name: "启用订阅地址" }));
    expect(review.getByRole("button", { name: "确认启用" }).hasAttribute("disabled")).toBe(true);
    await owner.click(() => review.getByRole("checkbox", { name: "我已确认域名配置与旧链接的访问安排" }));
    await owner.click(() => review.getByRole("button", { name: "确认启用" }));
    if (outcome === "activation-response-lost") await review.findByText("域名启用结果尚未确认");
    else await section.findByText("新复制的订阅链接将使用所选地址");
    await act(async () => { finishRead(json(verified)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    if (outcome === "activation-response-lost") {
      expect(review.getByRole("button", { name: "确认启用" }).hasAttribute("disabled")).toBe(true);
      expect(review.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
      await owner.click(() => review.getByRole("button", { name: "重新读取设置" }));
    } else {
      expect(section.getByText("当前链接示例").closest("div")?.textContent).toContain("https://new.example/feed/{existing-token}");
      await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
    }
    await waitFor(() => expect(originReads).toBe(6));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "启用订阅地址" })).toBeNull());
    expect(section.getByText("当前链接示例").closest("div")?.textContent).toContain("https://new.example/feed/{existing-token}");
    expect(section.getByRole("button", { name: "启用已保存草稿" }).hasAttribute("disabled")).toBe(true);
    expect(writes).toEqual([
      { method: "PUT", url: "/api/admin/subscription-origin", body: { origin: "https://new.example", expectedRevision: 4 } },
      { method: "POST", url: "/api/admin/subscription-origin/verify", body: { expectedRevision: 5 } },
      { method: "POST", url: "/api/admin/subscription-origin/activate", body: { expectedRevision: 6 } },
    ]);
  }
  expect(unexpected).toEqual([]);
});

it("keeps a saved draft when a same-session check starts a read while its write is pending", async context => {
  const owner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development"); setCSRF(""); setToken("");
  history.replaceState(null, "", "#settings");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const old = { revision: 4, configuredRevision: 2, effectiveRevision: 2,
    draftOrigin: "https://old.example", effectiveOrigin: "https://old.example", defaultOrigin: "",
    verificationStatus: "expired", tokensUnchanged: true,
    currentLinkExample: "https://old.example/feed/{existing-token}",
    proposedLinkExample: "https://old.example/feed/{existing-token}" };
  const saved = { ...old, revision: 5, configuredRevision: 5, verificationStatus: "unverified",
    draftOrigin: "https://new.example", proposedLinkExample: "https://new.example/feed/{existing-token}" };
  let finishWrite!: (response: Response) => void, finishRead!: (response: Response) => void;
  const writeResponse = new Promise<Response>(resolve => { finishWrite = resolve; });
  const readResponse = new Promise<Response>(resolve => { finishRead = resolve; });
  let reads = 0;
  const writes: unknown[] = [], unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input), method = init?.method || "GET";
    if (url === "/api/admin/subscription-origin") {
      if (method === "PUT") { writes.push(JSON.parse(String(init?.body))); return writeResponse; }
      if (method === "GET") return ++reads === 1 ? json(old) : reads === 2 ? readResponse : json(saved);
    }
    if (method === "GET") {
      if (url === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "fixture" });
      if (url === "/api/settings") return json({ name: "Origin fixture", timezone: "UTC+8", registration: "invite" });
      if (url === "/api/state") return json({ users: [], nodes: [], routes: [], revisions: [], capabilities: [] });
      if (["/api/published-routes", "/api/services", "/api/rates"].includes(url)) return json([]);
    }
    unexpected.push(`${method} ${url}`); throw new Error("Unexpected request");
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders>);
  const input = await screen.findByRole("textbox", { name: "订阅域名草稿" }) as HTMLInputElement;
  const section = within(screen.getByRole("region", { name: "订阅域名设置" }));
  owner.change(() => input, { target: { value: "https://new.example" } });
  await owner.click(() => section.getByRole("button", { name: "保存域名草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(reads).toBe(2));
  await act(async () => { finishWrite(json(saved)); });
  await section.findByText("域名草稿已保存，当前订阅地址未改变");
  await act(async () => { finishRead(json(old)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(section.queryByText("尚未保存", { exact: true })).toBeNull();
  expect(section.getByText("https://new.example/feed/{existing-token}")).toBeTruthy();
  expect(input.value).toBe("https://new.example");
  await owner.click(() => section.getByRole("button", { name: "刷新状态" }));
  await waitFor(() => expect(reads).toBe(3));
  expect(writes).toEqual([{ origin: "https://new.example", expectedRevision: 4 }]);
  expect(unexpected).toEqual([]);
});

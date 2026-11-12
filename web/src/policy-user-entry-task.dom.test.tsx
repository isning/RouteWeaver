// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PolicyUserEntryTask } from "./PolicyUserEntryTask";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function setup(options: { entry?: Record<string, unknown>; route?: Record<string, unknown>; fence?: boolean; failEntries?: boolean } = {}) {
  const requests: string[] = [];
  const user = { id: "alice", name: "Alice", enabled: true, quotaBytes: 0, usedBytes: 0 };
  // Literal entrySummary DTO: ownership comes from /users/alice/entries, not a userId property.
  const entry = { id: "entry", name: "Alice source entry", subjectId: "subject",
    routeId: "line", publishedRouteId: "line", deploymentId: "path", credentialVersion: "v1", status: "effective", revoked: false, ...options.entry };
  // Literal /state DTO: published routes and services are separate endpoints.
  const state = { users: [user], nodes: [], routes: [], revisions: [], capabilities: [], deploymentAvailable: false };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method || "GET";
    requests.push(`${method} ${path}`);
    let body: unknown;
    if (method !== "GET") throw new Error("Opening source management must not write");
    if (path === "/api/state") body = state;
    else if (path === "/api/users/alice/entries") {
      if (options.failEntries) return new Response(JSON.stringify({ detail: "Unavailable" }), { status: 503 });
      body = [entry];
    } else if (path === "/api/published-routes/line/resolve")
      body = { id: "line", name: "London", deploymentId: "path", path: { entry: "listener" }, ...options.route };
    else if (path === "/api/users/alice/effective-policy") body = { userId: "alice", routeIds: ["line"], status: "active" };
    else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }));
  const fence = vi.fn(() => options.fence !== false);
  const close = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const props = { deploymentId: "path", listenerId: "listener",
    principal: { accountId: "alice", subjectId: "subject", routeId: "line", credentialVersion: "v1" },
    onClose: close, onBeforeManage: fence };
  const renderTask = (value = props) => <QueryClientProvider client={client}><UIProviders>
    <input aria-label="Parent unsaved note" defaultValue="keep raw draft" />
    <PolicyUserEntryTask {...value} />
  </UIProviders></QueryClientProvider>;
  const view = render(renderTask());
  return { requests, fence, close, props, view, renderTask };
}

it("resolves the published route outside /state and opens source management without writes, reveal or changing the parent draft", async () => {
  const { requests, fence } = setup();
  const manage = await screen.findByRole("button", { name: "管理此账号的入口" });
  expect(screen.getByText("Alice source entry")).toBeTruthy();
  expect(screen.getByText("当前路径草稿会保留；返回后需重新核对路径版本才能保存。")).toBeTruthy();
  await userEvent.click(manage);
  expect(await screen.findByRole("dialog", { name: "Alice 的平台入口" })).toBeTruthy();
  expect(await screen.findByText("Alice source entry")).toBeTruthy();
  expect(fence).toHaveBeenCalledTimes(1);
  expect(requests).toContain("GET /api/published-routes/line/resolve");
  expect(screen.getByText("London")).toBeTruthy();
  expect((screen.getByLabelText("Parent unsaved note") as HTMLInputElement).value).toBe("keep raw draft");
  expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  expect(requests.some(request => request.includes("/reveal"))).toBe(false);
});

it.each([
  { entry: { subjectId: "different" } },
  { entry: { credentialVersion: "v2" } },
  { entry: { publishedRouteId: "other-line" } },
  { entry: { userId: "bob" } },
  { entry: { revoked: true } },
  { route: { deploymentId: "other-path" } },
  { route: { path: { entry: "other-listener" } } },
])("does not guess source provenance for %j", async options => {
  const { fence } = setup(options);
  expect(await screen.findByText("无法确认入口来源")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "管理此账号的入口" })).toBeNull();
  expect(fence).not.toHaveBeenCalled();
});

it("keeps lookup failure recoverable rather than reporting a missing or empty source", async () => {
  const { fence } = setup({ failEntries: true });
  expect(await screen.findByRole("button", { name: "重新核对" })).toBeTruthy();
  expect(screen.queryByText(/未匹配到唯一/)).toBeNull();
  expect(fence).not.toHaveBeenCalled();
});

it("does not expose source mutation controls when the stale-draft fence cannot be installed", async () => {
  const { fence, requests } = setup({ fence: false });
  await userEvent.click(await screen.findByRole("button", { name: "管理此账号的入口" }));
  expect(await screen.findByText("请先完成当前路径操作")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "轮换凭据" })).toBeNull();
  expect(fence).toHaveBeenCalledTimes(1);
  expect(requests.some(request => request.includes("effective-policy"))).toBe(false);
});

it("drops old source controls when a newer principal identity replaces the task", async () => {
  const { props, view, renderTask } = setup();
  await userEvent.click(await screen.findByRole("button", { name: "管理此账号的入口" }));
  expect(await screen.findByRole("dialog", { name: "Alice 的平台入口" })).toBeTruthy();
  view.rerender(renderTask({ ...props, principal: { ...props.principal, credentialVersion: "v2" } }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alice 的平台入口" })).toBeNull());
  expect(await screen.findByText("无法确认入口来源")).toBeTruthy();
});


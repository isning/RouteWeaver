// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishedRoutesPage, type PublishedRoute } from "./PublishedRoutes";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const legacy: PublishedRoute = {
  id: "line", revisionToken: "revision-one", name: "Office line", deploymentId: "path",
  endpointIds: ["entry", "exit"], publicHost: "office.example", publicPort: 443,
  status: "draft", diagnostics: [],
};
const managed = (endpointId: string, name: string) => ({
  kind: "managed" as const, endpointId, name, metadataState: "snapshot" as const,
});
const connector = (connectorId: string, programEndpointId: string) => ({
  kind: "connector" as const, connectorId, programEndpointId,
  name: "must-not-expose-private-connector.example:secret", metadataState: "snapshot" as const,
});
const mixed: PublishedRoute = {
  ...legacy,
  hops: [
    { kind: "managed", endpointId: "entry" },
    { kind: "connector", connectorId: "relay" },
    { kind: "managed", endpointId: "exit" },
    { kind: "connector", connectorId: "relay" },
  ],
  savedPath: { hops: [managed("entry", "Entry"), connector("relay", "entry"), managed("exit", "Exit"), connector("relay", "exit")] },
};
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
const endpoints = ["entry", "exit", "alternate"].map(id => ({
  id, name: id, instanceId: "core", authentication: "principals",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
}));
const deployment = {
  id: "path", name: "Path", status: "draft", diagnostics: [],
  ir: { schemaVersion: "1.0", id: "path", topologyRevision: "r1", programs: endpoints.map(listener => ({ instance, listener, rules: [], resources: [], egress: [] })) },
};
type Call = { path: string; method: string; body?: Record<string, unknown> };
const clients: QueryClient[] = [];
function setup(route = mixed, extra?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const call: Call = { path: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const response = extra?.(call);
    if (response) return response;
    if (call.path.endsWith("/preview")) return json({ ...route, ...call.body });
    if (call.method === "PUT") return json({ ...route, ...call.body });
    if (call.path.endsWith("/resolve")) return json(route);
    if (call.path.endsWith("/published-routes")) return json([route]);
    if (call.path.endsWith("/server-deployments")) return json([deployment]);
    if (call.path.endsWith("/managed-endpoints")) return json(endpoints);
    if (call.path.endsWith("/core-instances")) return json([instance]);
    if (call.path.endsWith("/hosts")) return json([{ id: "host", name: "Host", address: "office.example" }]);
    if (call.path.endsWith("/state")) return json({ users: [], services: [], routes: [], publishedRoutes: [route] });
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><PublishedRoutesPage /></UIProviders></QueryClientProvider>);
  return { calls, client, user: userEvent.setup() };
}
async function openDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Office line" }));
  return within(await screen.findByRole("dialog", { name: "Office line" }));
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#published-routes");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => originalStyle(element));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Public page and HTTP seams: complete ordering is visible, and legacy actions
// cannot submit a managed-only projection of a mixed chain.
it("shows every saved and confirmed hop in order using private-safe, program-scoped connector identities", async () => {
  const { user, calls } = setup({
    ...mixed, status: "effective", pendingChanges: true,
    effective: {
      publicHost: legacy.publicHost, publicPort: 443, endpointIds: legacy.endpointIds, fingerprint: "old",
      path: { hops: [managed("entry", "Entry"), connector("relay", "entry"), managed("exit", "Exit"), { ...connector("old-relay", "exit"), metadataState: "unavailable" }] },
    },
  });
  const detail = await openDetail(user);
  expect((await detail.findByLabelText("已保存路径")).textContent).toContain("Entry → relay（经 entry） → Exit → relay（经 exit）");
  expect(detail.getByLabelText("已确认路径").textContent).toContain("Entry → relay（经 entry） → Exit → old-relay");
  expect(detail.queryByText(/已保存路径端点相同/)).toBeNull();
  expect(document.body.textContent).not.toContain("must-not-expose-private-connector.example");
  expect(calls.some(call => /sources|subscriptions|import/.test(call.path))).toBe(false);
});

it("does not collapse changed connector order or scope when their endpointId fields are absent", async () => {
  const { user } = setup({
    ...mixed, effective: {
      publicHost: legacy.publicHost, publicPort: 443, endpointIds: legacy.endpointIds, fingerprint: "old",
      path: { hops: [managed("entry", "Entry"), connector("relay", "exit"), managed("exit", "Exit"), connector("relay", "entry")] },
    },
  });
  const detail = await openDetail(user);
  expect((await detail.findByLabelText("已保存路径")).textContent).toContain("Entry → relay（经 entry） → Exit → relay（经 exit）");
  expect(detail.getByLabelText("已确认路径").textContent).toContain("Entry → relay（经 exit） → Exit → relay（经 entry）");
  expect(detail.queryByText(/已保存路径端点相同/)).toBeNull();
});

it("keeps the complete intent visible when snapshot metadata is unavailable", async () => {
  const { user } = setup({ ...mixed, savedPath: undefined });
  const detail = await openDetail(user);
  expect((await detail.findByLabelText("已保存路径")).textContent).toContain("entry → relay（经 entry） → exit → relay（经 exit）");
});

it("confirms a matching mixed path only when all scoped hops match", async () => {
  const { user } = setup({
    ...mixed, effective: {
      publicHost: legacy.publicHost, publicPort: 443, endpointIds: legacy.endpointIds, fingerprint: "same",
      path: mixed.savedPath,
    },
  });
  const detail = await openDetail(user);
  expect((await detail.findByLabelText("已确认路径")).textContent).toContain("Entry → relay（经 entry） → Exit → relay（经 exit）");
  expect(detail.getByText("（已保存的完整路径相同）")).toBeTruthy();
  expect(detail.queryByLabelText("已保存路径")).toBeNull();
});

it.each(["intent", "saved", "confirmed"] as const)("blocks destructive legacy edit and retarget when connectors are known only from %s", async (source) => {
  const route: PublishedRoute = {
    ...legacy,
    ...(source === "intent" ? { hops: mixed.hops } : source === "saved" ? { savedPath: mixed.savedPath } : {
      effective: { publicHost: legacy.publicHost, publicPort: 443, endpointIds: legacy.endpointIds, fingerprint: "old", path: mixed.savedPath },
    }),
  };
  const { user, calls } = setup(route);
  const rowEdit = await screen.findByRole("button", { name: "编辑" });
  expect(rowEdit.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/当前编辑与更换出口暂不支持完整混合路径/)).toBeTruthy();
  fireEvent.click(rowEdit);
  expect(screen.queryByRole("dialog", { name: "编辑 Office line" })).toBeNull();
  const detail = await openDetail(user);
  const edit = detail.getByRole("button", { name: "编辑线路" });
  const retarget = detail.getByRole("button", { name: "更换出口" });
  expect(edit.hasAttribute("disabled")).toBe(true);
  expect(retarget.hasAttribute("disabled")).toBe(true);
  fireEvent.click(edit);
  fireEvent.click(retarget);
  expect(screen.queryByRole("dialog", { name: "编辑 Office line" })).toBeNull();
  expect(calls.every(call => call.method === "GET")).toBe(true);
});

it.each([false, true])("keeps managed-only editing and retarget available (explicit hops: %s)", async (explicit) => {
  const route = { ...legacy, ...(explicit ? { hops: [{ kind: "managed" as const, endpointId: "entry" }, { kind: "managed" as const, endpointId: "exit" }] } : {}), savedPath: { hops: explicit ? [managed("entry", "Entry"), managed("exit", "Exit")] : [
    { endpointId: "entry", name: "Entry", metadataState: "snapshot" as const },
    { endpointId: "exit", name: "Exit", metadataState: "snapshot" as const },
  ] } };
  const { user, calls } = setup(route);
  const detail = await openDetail(user);
  expect(detail.getByRole("button", { name: "更换出口" }).hasAttribute("disabled")).toBe(false);
  await user.click(detail.getByRole("button", { name: "更换出口" }));
  const exit = within(await screen.findByRole("dialog", { name: "更换「Office line」的出口" }));
  await user.click(exit.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "更换「Office line」的出口" })).toBeNull());
  await user.click(detail.getByRole("button", { name: "编辑线路" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "Renamed line" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(calls.some(call => call.method === "PUT")).toBe(true));
  expect(calls.find(call => call.method === "PUT")?.body).toEqual({ id: "line", name: "Renamed line", deploymentId: "path", endpointIds: ["entry", "exit"], publicHost: "office.example", publicPort: 443 });
});

it.each(["list", "resolve"] as const)("preserves an already-open draft and stops writes when %s refetch reveals a connector", async (source) => {
  const { user, client, calls } = setup(legacy);
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "My unsaved name" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  await act(async () => {
    if (source === "list") client.setQueryData(["published-routes"], [mixed]);
    else client.setQueryData(["published-route-resolve", "line"], mixed);
  });
  // Query observers notify asynchronously; the synchronous payload guard must
  // already refuse a write before the disabled UI state has rendered.
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  await waitFor(() => {
    expect(editor.getByRole("button", { name: "检查公开线路" }).hasAttribute("disabled")).toBe(true);
    expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true);
  });
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("My unsaved name");
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(0);
});

it("rejects mixed conflict recovery before the legacy comparison can strip connector hops", async () => {
  const { user, calls } = setup(legacy, call => {
    if (call.method === "PUT") return json({ error: "Record changed" }, 409);
    if (call.path.endsWith("/resolve")) return json({ ...mixed, revisionToken: "revision-two" });
  });
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "My unsaved name" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await user.click(await editor.findByRole("button", { name: "读取最新版本并比较" }));
  await editor.findByText(/当前编辑与更换出口暂不支持完整混合路径/);
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("My unsaved name");
  expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true);
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

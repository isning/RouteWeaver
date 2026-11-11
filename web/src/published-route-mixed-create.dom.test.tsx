// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishedRoutesPage, type PublishedRoute } from "./PublishedRoutes";
vi.mock("./server-path-model", () => ({
  readOrderedServerPath: (source: { ir: { topologyRevision: string } }) => ({
    editable: true,
    hops: [
      { kind: "managed", endpointId: "entry" },
      ...(source.ir.topologyRevision === "r0" ? [] : [{ kind: "connector", programEndpointId: "entry", connectorId: source.ir.topologyRevision === "r2" ? "relay-two" : "relay" }]),
      { kind: "managed", endpointId: "exit" },
      { kind: "managed", endpointId: "alternate" },
    ], connectorChoices: [],
  }),
}));

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
function setup(route = mixed, extra?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const call: Call = { path: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const response = await extra?.(call);
    if (response) return response;
    if (call.path.endsWith("/preview")) return json({ ...route, ...call.body });
    if (call.method === "PUT") return json({ ...route, ...call.body });
    if (call.path.endsWith("/resolve")) return json(route);
    if (call.path.endsWith("/published-routes") && call.method === "POST") return json({ ...call.body, revisionToken: "created-revision", status: "draft", diagnostics: [] });
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
type Source = typeof deployment & { revisionToken?: string };
function replaceSource(client: QueryClient, source?: Source) {
  const prior = client.getQueryData<{ deployments: Source[] }>(["infrastructure"])!;
  client.setQueryData(["infrastructure"], { ...prior, deployments: source ? [source] : [] });
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


async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "配置公开线路" }));
  const editor = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "Mixed office" } });
  await user.click(editor.getByRole("combobox", { name: "服务器转发路径" }));
  await user.click(await screen.findByRole("option", { name: "Path" }));
  return editor;
}

it("previews and explicitly creates the complete mixed chain without managed-only subset editing", async () => {
  const { user, calls } = setup(legacy);
  const editor = await create(user);
  expect(editor.getByLabelText("公开线路转发路径").textContent).toBe("entry → 外部代理 relay → exit → alternate");
  expect(editor.queryByRole("button", { name: /调整公开范围/ })).toBeNull();
  expect(editor.getByText(/此线路使用完整代理链/)).toBeTruthy();
  expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  const save = await editor.findByRole("button", { name: "保存公开线路" });
  const preview = calls.find(call => call.path.endsWith("/preview"));
  expect(preview?.body?.endpointIds).toEqual(["entry", "exit", "alternate"]);
  expect(preview?.body?.hops).toEqual([
    { kind: "managed", endpointId: "entry" }, { kind: "connector", connectorId: "relay" },
    { kind: "managed", endpointId: "exit" }, { kind: "managed", endpointId: "alternate" },
  ]);
  expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toHaveLength(0);
  await user.click(save);
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toHaveLength(1));
  expect(calls.find(call => call.method === "POST" && call.path.endsWith("/published-routes"))?.body).toEqual(preview?.body);
  expect(calls.some(call => /sources|subscriptions|import/.test(call.path))).toBe(false);
  await screen.findByText("线路已保存", { exact: true });
});

it("blocks stale mixed-source confirmation and requires explicit reload without losing name or address", async () => {
  const { user, client, calls } = setup(legacy);
  const editor = await create(user);
  fireEvent.change(editor.getByRole("textbox", { name: "对外域名或 IP" }), { target: { value: "chosen.example" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  await act(async () => {
    const prior = client.getQueryData<{ deployments: typeof deployment[] }>(["infrastructure"])!;
    client.setQueryData(["infrastructure"], { ...prior, deployments: [{ ...deployment, ir: { ...deployment.ir, topologyRevision: "r2" } }] });
  });
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
  expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toHaveLength(0);
  await user.click(editor.getByRole("button", { name: "重新载入所选路径" }));
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("Mixed office");
  expect((editor.getByRole("textbox", { name: "对外域名或 IP" }) as HTMLInputElement).value).toBe("chosen.example");
  expect(editor.getByLabelText("公开线路转发路径").textContent).toContain("外部代理 relay-two");
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body?.hops).toContainEqual({ kind: "connector", connectorId: "relay-two" });
});

it("requires a new review when a managed-only source becomes mixed after preview", async () => {
  const managedOnly = { ...deployment, ir: { ...deployment.ir, topologyRevision: "r0" } };
  const { user, client, calls } = setup(legacy, call => call.path.endsWith("/server-deployments") ? json([managedOnly]) : undefined);
  const editor = await create(user);
  expect(editor.getByLabelText("公开线路转发路径").textContent).toBe("entry → exit → alternate");
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  expect(calls.find(call => call.path.endsWith("/preview"))?.body?.hops).toBeUndefined();
  await act(async () => replaceSource(client, deployment));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  expect(calls.some(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toBe(false);
  await user.click(editor.getByRole("button", { name: "重新载入所选路径" }));
  expect(editor.getByLabelText("公开线路转发路径").textContent).toContain("外部代理 relay");
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body?.hops).toContainEqual({ kind: "connector", connectorId: "relay" });
});

it("blocks confirmation when the selected source is deleted after preview", async () => {
  const { user, client, calls } = setup(legacy);
  const editor = await create(user);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  await act(async () => replaceSource(client));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  expect(calls.some(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toBe(false);
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("Mixed office");
});

it("blocks a changed source revision even when its redacted IR is unchanged", async () => {
  const source = { ...deployment, revisionToken: "source-revision-one" };
  const { user, client, calls } = setup(legacy, call => call.path.endsWith("/server-deployments") ? json([source]) : undefined);
  const editor = await create(user);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  await act(async () => replaceSource(client, { ...source, revisionToken: "source-revision-two" }));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
  fireEvent.click(editor.getByRole("button", { name: "保存公开线路" }));
  expect(calls.some(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toBe(false);
  await user.click(editor.getByRole("button", { name: "重新载入所选路径" }));
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toHaveLength(1));
});

it("rejects a missing cache source at submission even before the view receives a refetch", async () => {
  const { user, client, calls } = setup(legacy);
  const editor = await create(user);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  const save = await editor.findByRole("button", { name: "保存公开线路" });
  const getQueryData = client.getQueryData.bind(client);
  const cacheRead = vi.spyOn(client, "getQueryData").mockImplementation(((key: readonly unknown[]) =>
    key[0] === "infrastructure" ? undefined : getQueryData(key)) as typeof client.getQueryData);
  fireEvent.click(save);
  await waitFor(() => expect(editor.getByText("转发路径已变化，请重新载入并核对完整链路。")).toBeTruthy());
  cacheRead.mockRestore();
  expect(calls.some(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toBe(false);
});

it("does not reload a replacement source while the preceding save remains in flight", async () => {
  let finishSave!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finishSave = resolve; });
  const { user, client, calls } = setup(legacy, call => call.method === "POST" && call.path.endsWith("/published-routes") ? pending : undefined);
  const editor = await create(user);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/published-routes"))).toHaveLength(1));
  await act(async () => replaceSource(client, { ...deployment, ir: { ...deployment.ir, topologyRevision: "r2" } }));
  const reload = await editor.findByRole("button", { name: "重新载入所选路径" });
  expect(reload.hasAttribute("disabled")).toBe(true);
  fireEvent.click(reload);
  expect(editor.getByLabelText("公开线路转发路径").textContent).toBe("entry → 外部代理 relay → exit → alternate");
  await act(async () => finishSave(json({ error: "Path validation refused the save" }, 422)));
  await waitFor(() => expect(editor.getByRole("button", { name: "重新载入所选路径" }).hasAttribute("disabled")).toBe(false));
  await user.click(editor.getByRole("button", { name: "重新载入所选路径" }));
  expect(editor.getByLabelText("公开线路转发路径").textContent).toContain("外部代理 relay-two");
});

it("preserves every ordered connector hop in an explicitly retried uncertain creation", async () => {
  let submitted: Record<string, unknown> | undefined;
  let posts = 0;
  const { user, calls } = setup(legacy, call => {
    if (call.method === "POST" && call.path === "/api/published-routes") {
      posts++;
      submitted = call.body;
      return posts === 1 ? json({ error: "Lost save response" }, 503)
        : json({ ...submitted, revisionToken: "created-revision", status: "draft", diagnostics: [] });
    }
    if (call.path.endsWith("/resolve")) return json({ error: "not found" }, 404);
  });
  const editor = await create(user);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await user.click(await editor.findByRole("button", { name: "核对保存结果" }));
  await user.click(await editor.findByRole("button", { name: "重试保存同一线路" }));
  await screen.findByText("线路已保存", { exact: true });
  const writes = calls.filter(call => call.method === "POST" && call.path === "/api/published-routes");
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(writes[1].body?.hops).toEqual([
    { kind: "managed", endpointId: "entry" },
    { kind: "connector", connectorId: "relay" },
    { kind: "managed", endpointId: "exit" },
    { kind: "managed", endpointId: "alternate" },
  ]);
  expect(calls.some(call => call.method === "PUT")).toBe(false);
});

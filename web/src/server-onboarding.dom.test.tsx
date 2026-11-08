// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { ServersPage } from "./Infrastructure";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import { createWorkspaceHistory, type WorkspaceHistory } from "./workspace-history";
import { hasUnsavedChanges } from "./navigation";
import type { AgentState, ManagedEndpoint } from "./types";

const host = { id: "host-setup", name: "Setup server", address: "setup.example.com" };
const core = { id: "core-setup", hostId: host.id, name: "Setup core", adapterId: "routeweaver/sing-box", version: "1.14.4" };
const endpoint: ManagedEndpoint = {
  id: "listener-setup", instanceId: core.id, name: "Setup listener",
  connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

const histories: WorkspaceHistory[] = [];
function mount({ listeners = [], phase = "unregistered", relatedPath = false, noCore = false, coreHostId = host.id, ownedHistory = false }: {
  listeners?: ManagedEndpoint[];
  phase?: string;
  relatedPath?: boolean;
  noCore?: boolean;
  coreHostId?: string;
  ownedHistory?: boolean;
} = {}) {
  const controls = { failSave: false, failReveal: false, failState: false, failInventory: false, inventoryReply: null as Promise<Response> | null };
  const writes: { path: string; value: Record<string, unknown> }[] = [];
  const current = [...listeners];
  const currentCores = noCore ? [] : [{ ...core, hostId: coreHostId }];
  const state: AgentState = { instanceId: core.id, phase };
  if (phase === "observed_conformant") state.state = {
    phase, nativeChecked: true, recoveryRequired: false,
    observed: { known: true, observedAt: "2020-01-02T03:04:05Z", generation: "old", evidence: "synthetic" },
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") {
      const value = JSON.parse(init.body);
      writes.push({ path, value });
      if (path === "/api/core-instances") currentCores.push(value);
      if (path === "/api/managed-endpoints") {
        if (controls.failSave) return json({ error: "监听端点保存暂时失败" }, 503);
        current.push(value);
      }
      if (path === "/api/agent/enrollments") return json({
        scope: { nodeId: host.id, instanceId: core.id, enrollmentEpoch: "synthetic" },
        token: "synthetic-test-token",
      });
      return json(value);
    }
    if (path === "/api/hosts") return json([host]);
    if (path === "/api/core-instances") return json(currentCores);
    if (path === "/api/managed-endpoints") {
      if (controls.inventoryReply) return controls.inventoryReply.then((response) => response.clone());
      return controls.failInventory ? json({ error: "清单暂时不可用" }, 503) : json(current);
    }
    if (path.endsWith("/reveal")) return controls.failReveal
      ? json({ error: "无权读取监听端点凭据" }, 403)
      : json(endpoint);
    if (/\/api\/agent\/instances\/[^/]+\/state$/.test(path)) return controls.failState
      ? json({ error: "实例状态读取暂时失败" }, 503)
      : json(state);
    if (path === "/api/server-deployments" && relatedPath) return json([
      { id: "path/setup", name: "Saved setup path", status: "draft", diagnostics: [], ir: { programs: [{ instance: core }] } },
      { id: "other-path", name: "Other core path", status: "draft", diagnostics: [], ir: { programs: [{ instance: { ...core, id: "other" } }] } },
    ]);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const controller = ownedHistory ? createWorkspaceHistory({
    isDirty: hasUnsavedChanges, confirm: () => {}, accept: () => {},
  }) : null;
  if (controller) histories.push(controller);
  render(<QueryClientProvider client={client}>
    <ConfirmationProvider>
      {controller ? <WorkspaceHistoryContext.Provider value={{ current: controller }}><ServersPage /></WorkspaceHistoryContext.Provider> : <ServersPage />}
    </ConfirmationProvider>
  </QueryClientProvider>);
  return { controls, writes, client, controller };
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn((media) => ({
    matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  })) });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  history.replaceState(null, "", "#servers");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); histories.splice(0).forEach((controller) => controller.dispose()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function openSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: host.name }));
  const hostSheet = await screen.findByRole("dialog", { name: host.name });
  expect(within(hostSheet).getByText("服务器信息已登记")).toBeTruthy();
  const opener = within(hostSheet).getByRole("button", { name: "查看接入与配置" });
  await user.click(opener);
  const sheet = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  return { sheet, opener, hostSheet };
}

it("continues from a saved core through a scoped listener and real route navigation without enrollment or application", async () => {
  const { controls, writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  expect(await within(sheet).findByText("尚未接入")).toBeTruthy();
  expect(within(sheet).getByRole("heading", { name: "1. Agent 接入与上报" })).toBeTruthy();
  expect(within(sheet).queryByRole("link", { name: /创建转发路径$/ })).toBeNull();
  await user.click(within(sheet).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  expect(within(editor).getByLabelText("所属服务器").textContent).toBe(host.name);
  expect(within(editor).getByLabelText("所属核心").textContent).toBe(core.name);
  await user.type(within(editor).getByLabelText("端点名称"), "New listener");
  await user.type(within(editor).getByLabelText("用户名"), "fixture");
  await user.type(within(editor).getByLabelText("密码"), "fixture-password");
  controls.failSave = true;
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  expect(await within(editor).findByText("监听端点保存暂时失败")).toBeTruthy();
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "New listener");
  controls.failSave = false;
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  const resumed = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  expect(await within(resumed).findByText("New listener")).toBeTruthy();
  expect(within(resumed).getByRole("link", { name: "用 New listener 创建转发路径" }).getAttribute("href")).toBe(`#routes?entryEndpoint=${encodeURIComponent(String(writes[1].value.id))}&returnHost=${host.id}&returnInstance=${core.id}`);
  expect(within(resumed).getByText("保存监听端点不会修改节点。转发路径需另行检查并确认应用。")).toBeTruthy();
  expect(writes).toHaveLength(2);
  expect(writes.every((write) => write.path === "/api/managed-endpoints")).toBe(true);
  expect(writes[1].value).toMatchObject({ instanceId: core.id, connection: { host: "0.0.0.0", port: 1080, protocol: "socks" } });
});

it("returns a discarded listener to the same core action and then the original server opener", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await user.type(within(editor).getByLabelText("端点名称"), "Keep until discarded");
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.click(within(editor).getByRole("button", { name: "取消" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃尚未保存的配置修改？" });
    await user.click(within(confirmation).getByRole("button", { name: attempt ? "放弃修改" : "继续编辑" }));
  }
  const resumed = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  await waitFor(() => expect(document.activeElement).toBe(within(resumed).getByRole("button", { name: "添加监听端点" })));
  await user.click(within(resumed).getByRole("button", { name: "关闭" }));
  const restoredHost = await screen.findByRole("dialog", { name: host.name });
  await waitFor(() => expect(document.activeElement).toBe(within(restoredHost).getByRole("button", { name: "查看接入与配置" })));
  expect(writes).toEqual([]);
});

it("keeps old observation time and read failure distinct from registration or current connectivity", async () => {
  const { controls, writes } = mount({ phase: "observed_conformant" });
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  expect(await within(sheet).findByText(/最近节点上报/)).toHaveProperty("textContent", expect.stringContaining("2020"));
  expect(within(sheet).getByText("平台最近记录的实例状态")).toBeTruthy();
  expect(within(sheet).queryByText("已连接")).toBeNull();
  controls.failState = true;
  await user.click(within(sheet).getByRole("button", { name: "刷新实例状态" }));
  expect(await within(sheet).findByText("刷新失败，以下为上次读取的实例记录。")).toBeTruthy();
  expect(within(sheet).queryByText("尚未接入")).toBeNull();
  expect(writes).toEqual([]);
});

it("links only paths containing this core and keeps denied endpoint reads in the active setup task", async () => {
  const { controls, writes } = mount({ listeners: [endpoint], relatedPath: true });
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  expect(within(sheet).getByRole("link", { name: "查看转发路径 Saved setup path" }).getAttribute("href")).toBe("#routes?deployment=path%2Fsetup");
  expect(within(sheet).queryByText("Other core path")).toBeNull();
  controls.failReveal = true;
  await user.click(within(sheet).getByRole("button", { name: "编辑监听端点 Setup listener" }));
  expect(await within(sheet).findByText("无权读取监听端点凭据")).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull();
  expect(writes).toEqual([]);
});

it("creates credentials only on explicit submission and clears the token when continuing back to the instance", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "接入 Agent" }));
  const enrollment = await screen.findByRole("dialog", { name: "接入核心实例" });
  expect(writes).toEqual([]);
  expect(within(enrollment).getByText(/旧凭据会失效/)).toBeTruthy();
  await user.click(within(enrollment).getByRole("button", { name: "创建接入凭据" }));
  expect(await within(enrollment).findByText("接入凭据已创建")).toBeTruthy();
  expect(within(enrollment).getByText(/凭据创建不会安装或启动 Agent/)).toBeTruthy();
  expect(within(enrollment).getByLabelText("接入令牌").getAttribute("type")).toBe("password");
  await user.click(within(enrollment).getByRole("button", { name: "关闭令牌并查看实例" }));
  await waitFor(() => expect(screen.queryByLabelText("接入令牌")).toBeNull());
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ path: "/api/agent/enrollments", value: { nodeId: host.id, instanceId: core.id } });
  expect(await within(sheet).findByText("尚未接入")).toBeTruthy();
});


it("opens the exact newly registered core setup and preserves its managed listener defaults", async () => {
  const { writes } = mount({ noCore: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  await user.click(screen.getByRole("button", { name: "添加核心" }));
  const editor = await screen.findByRole("dialog", { name: "添加核心实例" });
  await user.type(within(editor).getByLabelText("实例名称"), "Created managed core");
  await user.click(within(editor).getByLabelText("核心家族"));
  await user.click(await screen.findByText("受管 Xray", { selector: "[cmdk-item] span" }));
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  const setup = await screen.findByRole("dialog", { name: `${host.name}的Created managed core` });
  expect(screen.getAllByRole("dialog")).toEqual([setup]);
  expect(within(setup).getByText("核心配置已登记")).toBeTruthy();
  await user.click(within(setup).getByRole("button", { name: "添加监听端点" }));
  const listener = await screen.findByRole("dialog", { name: "添加监听端点" });
  expect(within(listener).getByLabelText("所属核心").textContent).toBe("Created managed core");
  expect(within(listener).getByText("VLESS")).toBeTruthy();
  expect(within(listener).getByLabelText("端口")).toHaveProperty("value", "");
  expect(writes).toHaveLength(1);
  expect(writes[0].value).toMatchObject({ hostId: host.id, adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" });
});

it("continues a core created from the global inventory and returns focus to that inventory action", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "核心实例 1" }));
  const add = screen.getByRole("button", { name: "添加核心实例" });
  await user.click(add);
  const editor = await screen.findByRole("dialog", { name: "添加核心实例" });
  expect(within(editor).getByLabelText("所属服务器").textContent).toBe(host.name);
  await user.type(within(editor).getByLabelText("实例名称"), "Global core");
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  const setup = await screen.findByRole("dialog", { name: `${host.name}的Global core` });
  expect(screen.getAllByRole("dialog")).toEqual([setup]);
  expect(writes).toHaveLength(1);
  expect(writes[0].value).toMatchObject({ hostId: host.id, name: "Global core" });
  await user.click(within(setup).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(add).toBe(document.activeElement));
});

it.each(["pending", "issued"])("does not let a late listener reveal interrupt %s enrollment", async (stage) => {
  const { writes } = mount({ listeners: [endpoint] });
  const read = globalThis.fetch;
  let releaseReveal!: (response: Response) => void;
  let releaseEnrollment!: (response: Response) => void;
  const reveal = new Promise<Response>((resolve) => { releaseReveal = resolve; });
  const enrollmentReply = new Promise<Response>((resolve) => { releaseEnrollment = resolve; });
  vi.stubGlobal("fetch", vi.fn((input, init) => {
    if (String(input).endsWith("/reveal")) return reveal;
    if (String(input) === "/api/agent/enrollments" && stage === "pending") return enrollmentReply;
    return read(input, init);
  }));
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "编辑监听端点 Setup listener" }));
  await user.click(within(sheet).getByRole("button", { name: "接入 Agent" }));
  const enrollment = await screen.findByRole("dialog", { name: "接入核心实例" });
  await user.click(within(enrollment).getByRole("button", { name: "创建接入凭据" }));
  if (stage === "issued") await within(enrollment).findByText("接入凭据已创建");
  await act(async () => { releaseReveal(json(endpoint)); await reveal; });
  expect(screen.getByRole("dialog", { name: "接入核心实例" })).toBe(enrollment);
  expect(screen.queryByRole("dialog", { name: "编辑监听端点" })).toBeNull();
  if (stage === "pending") await act(async () => {
    releaseEnrollment(json({ scope: { nodeId: host.id, instanceId: core.id, enrollmentEpoch: "synthetic" }, token: "delayed-synthetic-token" }));
    await enrollmentReply;
  });
  expect(await within(enrollment).findByLabelText("接入令牌")).toHaveProperty("value", stage === "issued" ? "synthetic-test-token" : "delayed-synthetic-token");
  expect(writes.filter((write) => write.path === "/api/managed-endpoints")).toEqual([]);
});

it.each(["delayed", "failed"])("keeps confirmed listener identity when the inventory refresh is %s", async (mode) => {
  const { controls, writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await user.type(within(editor).getByLabelText("端点名称"), "Confirmed listener");
  await user.type(within(editor).getByLabelText("用户名"), "fixture");
  await user.type(within(editor).getByLabelText("密码"), "fixture-password");
  let release!: (response: Response) => void;
  if (mode === "delayed") controls.inventoryReply = new Promise<Response>((resolve) => { release = resolve; });
  else controls.failInventory = true;
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  const resumed = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  expect(await within(resumed).findByText("Confirmed listener")).toBeTruthy();
  expect(within(resumed).queryByText("此核心尚未配置监听端点。")).toBeNull();
  expect(within(resumed).getByRole("link", { name: "用 Confirmed listener 创建转发路径" })).toBeTruthy();
  if (mode === "failed") expect(await within(resumed).findByText("清单刷新失败，以下保留刚保存的监听端点。")).toBeTruthy();
  else await act(async () => { release(json([])); await controls.inventoryReply; });
  expect(within(resumed).getByText("Confirmed listener")).toBeTruthy();
  expect(writes).toHaveLength(1);
});

it("keeps two confirmed cores discoverable after closing setup while inventory refresh fails", async () => {
  const { controls, writes } = mount({ noCore: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  for (const name of ["First saved core", "Second saved core"]) {
    const hostSheet = await screen.findByRole("dialog", { name: host.name });
    await user.click(within(hostSheet).getByRole("button", { name: "添加核心" }));
    const editor = await screen.findByRole("dialog", { name: "添加核心实例" });
    await user.type(within(editor).getByLabelText("实例名称"), name);
    controls.failInventory = true;
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    const setup = await screen.findByRole("dialog", { name: `${host.name}的${name}` });
    await user.click(within(setup).getByRole("button", { name: "关闭" }));
  }
  const hostSheet = await screen.findByRole("dialog", { name: host.name });
  expect(within(hostSheet).getByText("First saved core")).toBeTruthy();
  expect(within(hostSheet).getByText("Second saved core")).toBeTruthy();
  expect(within(hostSheet).queryByText("先添加核心，再配置监听端点")).toBeNull();
  await user.click(within(hostSheet).getAllByRole("button", { name: "查看接入与配置" })[0]);
  expect(await screen.findByRole("dialog", { name: `${host.name}的First saved core` })).toBeTruthy();
  expect(writes).toHaveLength(2);
});

it("retains every confirmed listener instead of only the last write before inventory recovery", async () => {
  const { controls, writes } = mount();
  const user = userEvent.setup();
  await openSetup(user);
  for (const name of ["First saved listener", "Second saved listener"]) {
    const setup = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
    await user.click(within(setup).getByRole("button", { name: "添加监听端点" }));
    const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
    await user.type(within(editor).getByLabelText("端点名称"), name);
    await user.type(within(editor).getByLabelText("用户名"), "fixture");
    await user.type(within(editor).getByLabelText("密码"), "fixture-password");
    controls.failInventory = true;
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    await within(await screen.findByRole("dialog", { name: `${host.name}的${core.name}` })).findByText(name);
  }
  const setup = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  expect(within(setup).getByText("First saved listener")).toBeTruthy();
  expect(within(setup).getByText("Second saved listener")).toBeTruthy();
  expect(within(setup).queryByText("此核心尚未配置监听端点。")).toBeNull();
  await user.click(within(setup).getByRole("button", { name: "关闭" }));
  const hostSheet = await screen.findByRole("dialog", { name: host.name });
  expect(within(hostSheet).getByText(/2 个监听端点/)).toBeTruthy();
  expect(writes).toHaveLength(2);
});


it("returns to the verified server and core without revealing credentials or writing configuration", async () => {
  history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
  const { writes } = mount({ listeners: [endpoint] });
  const setup = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  expect(screen.getAllByRole("dialog")).toEqual([setup]);
  expect(within(setup).getByText("Setup listener")).toBeTruthy();
  expect(within(setup).getByRole("link", { name: "用 Setup listener 创建转发路径" }).getAttribute("href")).toBe(`#routes?entryEndpoint=${endpoint.id}&returnHost=${host.id}&returnInstance=${core.id}`);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/reveal"))).toBe(false);
  expect(writes).toEqual([]);
  await userEvent.click(within(setup).getByRole("button", { name: "关闭" }));
  expect(location.hash).toBe("#servers");
  expect(await screen.findByRole("dialog", { name: host.name })).toBeTruthy();
});

it.each([
  `host=${host.id}`,
  `instance=${core.id}`,
  `host=${host.id}&instance=missing-core`,
  `host=missing-host&instance=${core.id}`,
  `host=${host.id}&host=${host.id}&instance=${core.id}`,
  `host=${host.id}&instance=${core.id}&instance=${core.id}`,
])("rejects incomplete, absent, or ambiguous setup identity: %s", async (query) => {
  history.replaceState(null, "", `#servers?${query}`);
  const { writes } = mount();
  expect(await screen.findByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual([]);
});

it("does not use stale cached inventory to resolve a return until a successful retry", async () => {
  const { controls, client, writes } = mount();
  await screen.findByRole("button", { name: host.name });
  controls.failInventory = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["infrastructure"] }); });
  act(() => {
    history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeNull();
  controls.failInventory = false;
  await act(async () => { await client.refetchQueries({ queryKey: ["infrastructure"] }); });
  expect(await screen.findByRole("dialog", { name: `${host.name}的${core.name}` })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("a delayed inventory result cannot restore a server task after newer navigation", async () => {
  const { controls, client, writes } = mount();
  await screen.findByRole("button", { name: host.name });
  let release!: (response: Response) => void;
  controls.inventoryReply = new Promise<Response>((resolve) => { release = resolve; });
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.invalidateQueries({ queryKey: ["infrastructure"] });
    history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  act(() => {
    history.replaceState(null, "", "#servers");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => { release(json([])); await refresh; });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual([]);
});

it("does not replace an active listener draft with a return context", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await user.type(within(editor).getByLabelText("端点名称"), "Keep this input");
  act(() => {
    history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(screen.getByRole("dialog", { name: "添加监听端点" })).toBe(editor);
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Keep this input");
  expect(writes).toEqual([]);
});


it("rejects a real core identity belonging to a different server", async () => {
  history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
  const { writes } = mount({ coreHostId: "different-server" });
  expect(await screen.findByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual([]);
});

it("does not replace or clear an issued enrollment token while resolving a return context", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  const { sheet } = await openSetup(user);
  await user.click(within(sheet).getByRole("button", { name: "接入 Agent" }));
  const enrollment = await screen.findByRole("dialog", { name: "接入核心实例" });
  await user.click(within(enrollment).getByRole("button", { name: "创建接入凭据" }));
  await within(enrollment).findByText("接入凭据已创建");
  act(() => {
    history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(screen.getByRole("dialog", { name: "接入核心实例" })).toBe(enrollment);
  expect(within(enrollment).getByLabelText("接入令牌")).toHaveProperty("value", "synthetic-test-token");
  expect(writes).toHaveLength(1);
});


it("closes the context-owned setup after accepted Back navigation to the plain server list", async () => {
  const { controller, writes } = mount({ ownedHistory: true });
  await screen.findByRole("button", { name: host.name });
  act(() => controller!.navigate(`#servers?host=${host.id}&instance=${core.id}`));
  await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe("#servers"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
});

it("does not clear manually opened setup on unrelated accepted same-page navigation", async () => {
  const { controller, writes } = mount({ ownedHistory: true });
  const { sheet } = await openSetup(userEvent.setup());
  act(() => controller!.navigate("#servers?view=inventory"));
  expect(location.hash).toBe("#servers?view=inventory");
  expect(screen.getByRole("dialog", { name: `${host.name}的${core.name}` })).toBe(sheet);
  expect(writes).toEqual([]);
});

it("leaves a contextual dirty listener editor intact when list navigation has not been approved", async () => {
  const { controller, writes } = mount({ ownedHistory: true });
  await screen.findByRole("button", { name: host.name });
  act(() => controller!.navigate(`#servers?host=${host.id}&instance=${core.id}`));
  const setup = await screen.findByRole("dialog", { name: `${host.name}的${core.name}` });
  const user = userEvent.setup();
  await user.click(within(setup).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await user.type(within(editor).getByLabelText("端点名称"), "Unapproved draft");
  act(() => controller!.navigate("#servers"));
  expect(location.hash).toBe(`#servers?host=${host.id}&instance=${core.id}`);
  expect(screen.getByRole("dialog", { name: "添加监听端点" })).toBe(editor);
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Unapproved draft");
  expect(writes).toEqual([]);
});

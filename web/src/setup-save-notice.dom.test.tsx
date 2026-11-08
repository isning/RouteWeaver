// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast, Toaster } from "sonner";
import { ConfirmationProvider } from "./ui-patterns/confirmations";
import { ServersPage } from "./Infrastructure";
import { ServerRoutesPage } from "./ServerRoutes";
import { PublishedRoutesPage } from "./PublishedRoutes";
import type { CoreInstance, HostRecord, ManagedEndpoint, ServerDeployment } from "./types";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
beforeEach(() => {
  history.replaceState(null, "", "#servers");
  vi.stubEnv("NODE_ENV", "development");
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => computed(element));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mountPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const tree = (content: ReactNode) => (
    <QueryClientProvider client={client}>
      <ConfirmationProvider>{content}</ConfirmationProvider>
      {/* Never auto-expire: these user tasks must retire their own acknowledgments. */}
      <Toaster duration={Infinity} expand />
    </QueryClientProvider>
  );
  const view = render(tree(page));
  return { client, leave: () => view.rerender(tree(<h1>下一页</h1>)) };
}

function inventoryAPI() {
  const hosts: HostRecord[] = [];
  const cores: CoreInstance[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") {
      const value = JSON.parse(String(init.body));
      if (path === "/api/hosts") hosts.push(value);
      else if (path === "/api/core-instances") cores.push(value);
      else throw new Error(`Unexpected write: ${path}`);
      return json(value);
    }
    const agent = cores.find((core) => path === `/api/agent/instances/${core.id}/state`);
    if (agent) return json({ instanceId: agent.id, phase: "unregistered" });
    if (cores.some((core) => path === `/api/agent/instances/${core.id}/accounting-pending`)) return json([]);
    const data: Record<string, unknown> = {
      "/api/hosts": hosts, "/api/core-instances": cores,
      "/api/managed-endpoints": [], "/api/links": [], "/api/server-deployments": [],
    };
    if (!(path in data)) throw new Error(`Unexpected read: ${path}`);
    return json(data[path]);
  }));
}

async function saveHost(user: ReturnType<typeof userEvent.setup>) {
  const heading = await screen.findByRole("heading", { name: "服务器" });
  await user.click(within(heading.closest<HTMLElement>(".page-heading")!).getByRole("button", { name: "添加服务器" }));
  const editor = within(await screen.findByRole("dialog", { name: "添加服务器" }));
  await user.type(editor.getByLabelText("服务器名称", { exact: true }), "测试服务器");
  await user.type(editor.getByLabelText("服务器连接地址", { exact: true }), "127.0.0.1");
  await user.click(editor.getByRole("button", { name: "保存" }));
  return within(await screen.findByRole("region", { name: "测试服务器" }));
}

it("retires only the previous setup save acknowledgment when the next editor opens", async () => {
  inventoryAPI();
  const view = mountPage(<ServersPage />);
  const user = userEvent.setup();
  const detail = await saveHost(user);
  expect(await screen.findByText("服务器「测试服务器」已保存", { exact: true })).toBeTruthy();
  expect(detail.getByText("127.0.0.1", { exact: true })).toBeTruthy();
  const undo = vi.fn();
  const inspect = vi.fn();
  act(() => {
    toast.error("节点连接失败，请检查连接", { duration: Infinity });
    toast.success("已停用测试通知", { duration: Infinity, action: { label: "撤销停用", onClick: undo } });
    toast("仍有待核对结果", { duration: Infinity, action: { label: "查看结果", onClick: inspect } });
  });
  await user.click(detail.getByRole("button", { name: "开始配置核心" }));
  const core = within(await screen.findByRole("dialog", { name: "添加核心实例" }));
  await waitFor(() => expect(screen.queryByText("服务器「测试服务器」已保存", { exact: true })).toBeNull());
  expect(screen.getByText("节点连接失败，请检查连接", { exact: true })).toBeTruthy();
  expect(screen.getByText("撤销停用", { exact: true })).toBeTruthy();
  expect(screen.getByText("查看结果", { exact: true })).toBeTruthy();
  await user.type(core.getByLabelText("实例名称", { exact: true }), "测试核心");
  await user.click(core.getByRole("button", { name: "保存" }));
  const savedCore = await screen.findByText("核心实例「测试核心」已保存", { exact: true });
  expect(savedCore).toBeTruthy();
  const resumed = within(await screen.findByRole("region", { name: "测试服务器的测试核心" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(resumed.getByRole("button", { name: "添加监听端点" }));
  const listener = within(await screen.findByRole("dialog", { name: "添加监听端点" }));
  await waitFor(() => expect(screen.queryByText("核心实例「测试核心」已保存", { exact: true })).toBeNull());
  await user.type(listener.getByLabelText("端点名称", { exact: true }), "未完成的监听端点");
  await user.clear(listener.getByLabelText("端口", { exact: true }));
  await user.click(listener.getByRole("button", { name: "保存" }));
  expect(await listener.findByText("填写端口", { exact: true })).toBeTruthy();
  expect(listener.getByLabelText("端点名称", { exact: true })).toHaveProperty("value", "未完成的监听端点");
  expect(screen.queryByText(/监听端点.*已保存/)).toBeNull();
  expect(screen.getByText("节点连接失败，请检查连接", { exact: true })).toBeTruthy();
  expect(screen.getByText("撤销停用", { exact: true })).toBeTruthy();
  expect(screen.getByText("查看结果", { exact: true })).toBeTruthy();
  expect(undo).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  view.leave();
  await user.click(screen.getByRole("button", { name: "撤销停用" }));
  await user.click(screen.getByRole("button", { name: "查看结果" }));
  expect(undo).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledOnce();
});

it("removes the departing setup page acknowledgment without clearing another notice", async () => {
  inventoryAPI();
  const view = mountPage(<ServersPage />);
  const user = userEvent.setup();
  await saveHost(user);
  expect(await screen.findByText("服务器「测试服务器」已保存", { exact: true })).toBeTruthy();
  act(() => { toast.error("待处理的检查失败", { duration: Infinity }); });
  view.leave();
  await waitFor(() => expect(screen.queryByText("服务器「测试服务器」已保存", { exact: true })).toBeNull());
  expect(screen.getByRole("heading", { name: "下一页" })).toBeTruthy();
  expect(screen.getByText("待处理的检查失败", { exact: true })).toBeTruthy();
});

it("does not let a late infrastructure save acknowledge over the next page", async (context) => {
  inventoryAPI();
  const originalFetch = fetch;
  let deliver: ((value: Response) => void) | undefined;
  let submitted: unknown;
  const pending = new Promise<Response>((resolve) => { deliver = resolve; });
  context.onTestFinished(() => deliver?.(json(submitted)));
  vi.stubGlobal("fetch", vi.fn((url, init?: RequestInit) => {
    if (String(url) === "/api/hosts" && init?.method === "POST") {
      submitted = JSON.parse(String(init.body));
      return pending;
    }
    return originalFetch(url, init);
  }));
  const view = mountPage(<ServersPage />);
  const user = userEvent.setup();
  const heading = await screen.findByRole("heading", { name: "服务器" });
  await user.click(within(heading.closest<HTMLElement>(".page-heading")!).getByRole("button", { name: "添加服务器" }));
  const editor = within(await screen.findByRole("dialog", { name: "添加服务器" }));
  await user.type(editor.getByLabelText("服务器名称", { exact: true }), "迟到的服务器");
  await user.type(editor.getByLabelText("服务器连接地址", { exact: true }), "127.0.0.1");
  await user.click(editor.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(submitted).toMatchObject({ name: "迟到的服务器" }));
  view.leave();
  await act(async () => deliver!(json(submitted)));
  await waitFor(() => expect(view.client.isMutating()).toBe(0));
  expect(screen.getByRole("heading", { name: "下一页" })).toBeTruthy();
  expect(screen.queryByText("服务器「迟到的服务器」已保存", { exact: true })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

function routeAPI() {
  const host: HostRecord = { id: "host", name: "测试服务器", address: "127.0.0.1" };
  const instance: CoreInstance = { id: "core", hostId: host.id, name: "测试核心", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
  const listener: ManagedEndpoint = { id: "listener", instanceId: instance.id, name: "测试入口", authentication: "principals", connection: { protocol: "vless", host: "0.0.0.0", port: 23456 } };
  const deployment: ServerDeployment = {
    id: "path", name: "测试转发路径", status: "draft", diagnostics: [],
    ir: { schemaVersion: "1.0", id: "path", topologyRevision: "r1", programs: [{ instance, listener, rules: [], resources: [], egress: [] }] },
  };
  const line = { id: "line", name: "测试公开线路", deploymentId: deployment.id, endpointIds: [listener.id], publicHost: host.address, publicPort: 23457, status: "draft", diagnostics: [], effective: null };
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT") {
      const value = JSON.parse(String(init.body));
      if (path === "/api/server-deployments/path") Object.assign(deployment, value);
      else if (path === "/api/published-routes/line") Object.assign(line, value);
      else throw new Error(`Unexpected write: ${path}`);
      return json(path.includes("server-deployments") ? deployment : line);
    }
    if (init?.method === "POST" && path === "/api/published-routes/preview") return json(line);
    const data: Record<string, unknown> = {
      "/api/hosts": [host], "/api/core-instances": [instance], "/api/managed-endpoints": [listener],
      "/api/links": [], "/api/server-deployments": [deployment], "/api/published-routes": [line],
      "/api/server-deployments/path/reveal": deployment, "/api/published-routes/line/resolve": line,
      "/api/agent/instances/core/state": { instanceId: instance.id, phase: "unregistered" },
      "/api/state": { users: [], services: [], routes: [], publishedRoutes: [line] },
    };
    if (!(path in data)) throw new Error(`Unexpected read: ${path}`);
    return json(data[path]);
  }));
}

it.each(["server", "public"] as const)("keeps the %s save result in its detail, not in a reopened task or another page", async (kind) => {
  routeAPI();
  const title = kind === "server" ? "测试转发路径" : "测试公开线路";
  const editLabel = kind === "server" ? "编辑转发路径" : "编辑线路";
  const saveLabel = kind === "server" ? "保存草稿" : "保存公开线路";
  const acknowledgment = kind === "server" ? "转发路径草稿已保存" : "线路已保存";
  history.replaceState(null, "", kind === "server" ? "#routes?deployment=path" : "#published-routes?line=line");
  const view = mountPage(kind === "server" ? <ServerRoutesPage /> : <PublishedRoutesPage />);
  const user = userEvent.setup();
  const detail = within(await screen.findByRole("dialog", { name: title }));
  await user.click(detail.getByRole("button", { name: editLabel }));
  for (let saveNumber = 0; saveNumber < 2; saveNumber++) {
    const editor = within(await screen.findByRole("dialog", { name: `编辑 ${title}` }));
    if (kind === "public") {
      await user.click(editor.getByRole("button", { name: "检查公开线路" }));
      await editor.findByText("路径检查完成", { exact: true });
    }
    await user.click(editor.getByRole("button", { name: saveLabel }));
    const savedDialog = await screen.findByRole("dialog", { name: title });
    const saved = within(savedDialog);
    const savedAcknowledgment = saved.getByText(acknowledgment, { exact: true });
    // A dialog can reference several descriptions. Resolve its IDREFS list,
    // rather than treating the whole attribute as one implementation ID.
    const descriptions = (savedDialog.getAttribute("aria-describedby") || "")
      .trim().split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id));
    expect(descriptions).toContain(savedAcknowledgment);
    expect(screen.getByRole("dialog", {
      name: title, description: new RegExp(acknowledgment),
    })).toBe(savedDialog);
    expect(screen.getAllByText(acknowledgment, { exact: true })).toHaveLength(1);
    if (saveNumber === 0) {
      await user.click(saved.getByRole("button", { name: editLabel }));
      await screen.findByRole("dialog", { name: `编辑 ${title}` });
      await waitFor(() => expect(screen.queryByText(acknowledgment, { exact: true })).toBeNull());
    }
  }
  view.leave();
  await waitFor(() => expect(screen.queryByText(acknowledgment, { exact: true })).toBeNull());
  expect(screen.getByRole("heading", { name: "下一页" })).toBeTruthy();
});


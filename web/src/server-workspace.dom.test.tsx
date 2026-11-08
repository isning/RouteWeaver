// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { ServersPage } from "./Infrastructure";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import { createWorkspaceHistory, type WorkspaceHistory } from "./workspace-history";
import { hasUnsavedChanges } from "./navigation";
import type { AgentState, ManagedEndpoint } from "./types";

const host = { id: "host-setup", name: "Setup server", address: "setup.example.com" };
const otherHost = { id: "host-moved", name: "Other server", address: "other.example.com" };
const core = { id: "core-setup", hostId: host.id, name: "Setup core", adapterId: "routeweaver/sing-box", version: "1.14.4" };
const endpoint: ManagedEndpoint = {
  id: "listener-setup", instanceId: core.id, name: "Setup listener",
  connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

const histories: WorkspaceHistory[] = [];
function mount({ listeners = [], phase = "unregistered", relatedPath = false, noCore = false, coreHostId = host.id, ownedHistory = false, secondHost = false }: {
  listeners?: ManagedEndpoint[];
  phase?: string;
  relatedPath?: boolean;
  noCore?: boolean;
  coreHostId?: string;
  ownedHistory?: boolean;
  secondHost?: boolean;
} = {}) {
  const controls = { removeCore: false, movedCoreHostId: null as string | null, failSave: false, failReveal: false, failState: false, failInventory: false, inventoryReply: null as Promise<Response> | null };
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
    if (init?.method === "PUT" && path === `/api/core-instances/${core.id}`) {
      const value = JSON.parse(init.body);
      writes.push({ path, value });
      currentCores.splice(0, currentCores.length, value);
      return json(value);
    }
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
    if (path === "/api/hosts") return json(secondHost || controls.movedCoreHostId ? [host, otherHost] : [host]);
    if (path === "/api/core-instances") return json(controls.removeCore ? [] : currentCores.map((value) => controls.movedCoreHostId ? { ...value, hostId: controls.movedCoreHostId } : value));
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

it("opens a durable server page with URL identity and no detail dialog", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  const page = await screen.findByRole("region", { name: host.name });
  expect(location.hash).toBe(`#servers?host=${host.id}`);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(page).getByRole("heading", { level: 1, name: host.name })).toBeTruthy();
  expect(within(page).getByText(host.address)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(page).getByRole("heading", { level: 1 })));
  await user.click(within(page).getByRole("button", { name: "返回服务器清单" }));
  expect(location.hash).toBe("#servers");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: host.name })));
  expect(writes).toEqual([]);
});

it("opens a host-only direct URL and keeps diagnostics out of the initial task", async () => {
  history.replaceState(null, "", `#servers?host=${host.id}`);
  const { writes } = mount();
  const page = await screen.findByRole("region", { name: host.name });
  expect(within(page).getByRole("tab", { name: "概览" }).getAttribute("aria-selected")).toBe("true");
  expect(within(page).getByRole("button", { name: "添加核心" })).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("observability"))).toBe(false);
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/reveal"))).toBe(false);
  expect(writes).toEqual([]);
});

it("keeps the selected core across keyboard tab navigation and filters configuration records by server", async () => {
  history.replaceState(null, "", `#servers?host=${host.id}&instance=${core.id}`);
  const { writes } = mount({ relatedPath: true });
  const user = userEvent.setup();
  const page = await screen.findByRole("region", { name: host.name });
  const selected = within(page).getByRole("tab", { name: "核心与监听" });
  selected.focus();
  await user.keyboard("{ArrowRight}{Enter}");
  const records = within(page).getByRole("tab", { name: "配置记录" });
  expect(records.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(records);
  expect(location.hash).toBe(`#servers?host=${host.id}&instance=${core.id}&section=records`);
  expect(within(page).getByRole("link", { name: "查看转发路径 Saved setup path" })).toBeTruthy();
  await user.click(selected);
  expect(within(page).getByRole("region", { name: `${host.name}的${core.name}` })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("restores visited server and core pages through Back and Forward even when inventory refresh fails", async () => {
  const { controls, client, writes } = mount({ ownedHistory: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  await user.click(screen.getByRole("button", { name: "查看接入与配置" }));
  await screen.findByRole("region", { name: `${host.name}的${core.name}` });
  controls.failInventory = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["infrastructure"] }); });
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe(`#servers?host=${host.id}`));
  await waitFor(() => expect(screen.queryByRole("region", { name: `${host.name}的${core.name}` })).toBeNull());
  expect(screen.getByRole("button", { name: "查看接入与配置" })).toBeTruthy();
  expect(screen.getByText("服务器清单刷新失败，以下保留已有记录与刚保存的配置。")).toBeTruthy();
  act(() => history.forward());
  await waitFor(() => expect(location.hash).toBe(`#servers?host=${host.id}&instance=${core.id}`));
  expect(await screen.findByRole("region", { name: `${host.name}的${core.name}` })).toBeTruthy();
  expect(writes).toEqual([]);
});

it("retains the same server page node underneath a cancellable editor", async () => {
  const { writes } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  const page = await screen.findByRole("region", { name: host.name });
  const action = within(page).getByRole("button", { name: "添加核心" });
  await user.click(action);
  const editor = await screen.findByRole("dialog", { name: "添加核心实例" });
  expect(page.isConnected).toBe(true);
  expect(screen.getAllByRole("dialog")).toEqual([editor]);
  await user.click(within(editor).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("region", { name: host.name })).toBe(page);
  await waitFor(() => expect(document.activeElement).toBe(action));
  expect(writes).toEqual([]);
});

it.each(["section=unknown", "section=cores&section=records", "instance=", "host="])("rejects ambiguous or unsupported workspace state: %s", async (query) => {
  history.replaceState(null, "", `#servers?host=${host.id}&${query}`);
  const { writes } = mount();
  expect(await screen.findByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeTruthy();
  expect(screen.queryByRole("region", { name: host.name })).toBeNull();
  expect(writes).toEqual([]);
});

async function selectedCore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: host.name }));
  await user.click(screen.getByRole("button", { name: "查看接入与配置" }));
  return await screen.findByRole("region", { name: `${host.name}的${core.name}` });
}

it("retires the old server/core context after editing the core onto another server", async () => {
  const { writes } = mount({ secondHost: true, ownedHistory: true });
  const user = userEvent.setup();
  await selectedCore(user);
  await user.click(screen.getByRole("button", { name: "编辑核心" }));
  const editor = await screen.findByRole("dialog", { name: "编辑核心实例" });
  await user.click(within(editor).getByLabelText("所属服务器"));
  await user.click(await screen.findByRole("option", { name: otherHost.name }));
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  expect(await screen.findByText("此核心已转移到其他服务器。请打开核心所在服务器后继续配置。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "接入 Agent" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "添加监听端点" })).toHaveProperty("disabled", true);
  expect(writes).toEqual([{ path: `/api/core-instances/${core.id}`, value: expect.objectContaining({ hostId: otherHost.id }) }]);
  await user.click(screen.getByRole("button", { name: "打开核心所在服务器" }));
  const moved = await screen.findByRole("region", { name: `${otherHost.name}的${core.name}` });
  expect(location.hash).toBe(`#servers?host=${otherHost.id}&instance=${core.id}`);
  expect(within(moved).getByRole("button", { name: "接入 Agent" })).toHaveProperty("disabled", false);
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe(`#servers?host=${host.id}&instance=${core.id}`));
  expect(await screen.findByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "接入 Agent" })).toBeNull();
  expect(writes).toHaveLength(1);
});

async function fillValidListener(user: ReturnType<typeof userEvent.setup>, editor: HTMLElement) {
  await user.type(within(editor).getByLabelText("端点名称"), "Retained draft");
  await user.type(within(editor).getByLabelText("用户名"), "synthetic-user");
  await user.type(within(editor).getByLabelText("密码"), "synthetic-listener-password");
}

it.each(["core", "overview"] as const)("saves the complete listener fixture when its %s owner remains valid", async (origin) => {
  const { writes } = mount();
  const user = userEvent.setup();
  if (origin === "core") {
    const page = await selectedCore(user);
    await user.click(within(page).getByRole("button", { name: "添加监听端点" }));
  } else {
    await user.click(await screen.findByRole("button", { name: host.name }));
    await user.click(screen.getByRole("button", { name: `为 ${core.name} 添加监听端点` }));
  }
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await fillValidListener(user, editor);
  await user.click(within(editor).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([{ path: "/api/managed-endpoints", value: expect.objectContaining({
    name: "Retained draft", instanceId: core.id,
    connection: { host: "0.0.0.0", port: 1080, protocol: "socks", username: "synthetic-user", password: "synthetic-listener-password" },
  }) }]);
});

it("keeps an unsaved listener draft but blocks its submission after authoritative core removal", async () => {
  const { controls, client, writes } = mount();
  const user = userEvent.setup();
  const page = await selectedCore(user);
  await user.click(within(page).getByRole("button", { name: "添加监听端点" }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await fillValidListener(user, editor);
  const save = within(editor).getByRole("button", { name: "保存" });
  const form = within(editor).getByLabelText("端点名称").closest("form")!;
  controls.removeCore = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["infrastructure"] });
    expect(client.getQueryState(["infrastructure"])).toMatchObject({
      status: "success", fetchStatus: "idle", data: { instances: [] },
    });
    // The completed response is authoritative even before its React notification.
    expect(save).toHaveProperty("disabled", false);
    fireEvent.submit(form);
  });
  expect(writes).toEqual([]);
  // Copy/disabled state is asserted after the observer renders the same task.
  expect(await within(editor).findByText("此核心已从清单移除。请返回核心列表重新选择。")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "添加监听端点" })).toBe(editor);
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Retained draft");
  expect(within(editor).getByLabelText("用户名")).toHaveProperty("value", "synthetic-user");
  expect(within(editor).getByLabelText("密码")).toHaveProperty("value", "synthetic-listener-password");
  expect(save).toHaveProperty("disabled", true);
  await act(async () => { fireEvent.submit(form); });
  await user.click(within(editor).getByRole("button", { name: "取消" }));
  await user.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Retained draft");
  expect(writes).toEqual([]);
});

it.each(["removed", "moved"] as const)("retains an overview-origin listener draft but blocks its %s original core", async (change) => {
  const { controls, client, writes } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: host.name }));
  await user.click(screen.getByRole("button", { name: `为 ${core.name} 添加监听端点` }));
  const editor = await screen.findByRole("dialog", { name: "添加监听端点" });
  await fillValidListener(user, editor);
  const save = within(editor).getByRole("button", { name: "保存" });
  const form = within(editor).getByLabelText("端点名称").closest("form")!;
  expect(location.hash).toBe(`#servers?host=${host.id}`);
  if (change === "removed") controls.removeCore = true;
  else controls.movedCoreHostId = otherHost.id;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["infrastructure"] });
    expect(client.getQueryState(["infrastructure"])).toMatchObject({
      status: "success", fetchStatus: "idle",
      data: { instances: change === "removed" ? [] : [{ ...core, hostId: otherHost.id }] },
    });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.submit(form);
  });
  expect(writes).toEqual([]);
  const message = change === "removed"
    ? "此核心已从清单移除。请返回核心列表重新选择。"
    : "此核心已转移到其他服务器。请打开核心所在服务器后继续配置。";
  expect(await within(editor).findByText(message)).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "添加监听端点" })).toBe(editor);
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Retained draft");
  expect(within(editor).getByLabelText("用户名")).toHaveProperty("value", "synthetic-user");
  expect(within(editor).getByLabelText("密码")).toHaveProperty("value", "synthetic-listener-password");
  expect(save).toHaveProperty("disabled", true);
  await act(async () => { fireEvent.submit(form); });
  await user.click(within(editor).getByRole("button", { name: "取消" }));
  await user.click(await screen.findByRole("button", { name: "继续编辑" }));
  expect(within(editor).getByLabelText("端点名称")).toHaveProperty("value", "Retained draft");
  expect(writes).toEqual([]);
});

it.each(["before issuance", "after issuance"])("keeps enrollment open %s but revokes new issuance under a changed owner", async (stage) => {
  const { controls, client, writes } = mount();
  const user = userEvent.setup();
  const page = await selectedCore(user);
  await user.click(within(page).getByRole("button", { name: "接入 Agent" }));
  const enrollment = await screen.findByRole("dialog", { name: "接入核心实例" });
  if (stage === "after issuance") {
    await user.click(within(enrollment).getByRole("button", { name: "创建接入凭据" }));
    await within(enrollment).findByLabelText("接入令牌");
  }
  const issue = stage === "before issuance" ? within(enrollment).getByRole("button", { name: "创建接入凭据" }) : null;
  const form = stage === "before issuance" ? within(enrollment).getByLabelText("凭据到期时间").closest("form")! : null;
  controls.movedCoreHostId = otherHost.id;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["infrastructure"] });
    expect(client.getQueryState(["infrastructure"])).toMatchObject({
      status: "success", fetchStatus: "idle", data: { instances: [{ ...core, hostId: otherHost.id }] },
    });
    if (issue && form) {
      expect(issue).toHaveProperty("disabled", false);
      fireEvent.submit(form);
    }
  });
  expect(writes).toHaveLength(stage === "before issuance" ? 0 : 1);
  expect(await within(enrollment).findByText("此核心已转移到其他服务器。请打开核心所在服务器后继续配置。")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "接入核心实例" })).toBe(enrollment);
  if (stage === "after issuance") {
    expect(within(enrollment).getByLabelText("接入令牌")).toHaveProperty("value", "synthetic-test-token");
    expect(hasUnsavedChanges()).toBe(true);
    expect(writes).toHaveLength(1);
  } else {
    expect(within(enrollment).getByRole("button", { name: "创建接入凭据" })).toHaveProperty("disabled", true);
    await act(async () => { fireEvent.submit(within(enrollment).getByLabelText("凭据到期时间").closest("form")!); });
    expect(writes).toEqual([]);
  }
});

it("does not treat failed inventory refresh as proof that the selected core was removed", async () => {
  const { controls, client, writes } = mount();
  const user = userEvent.setup();
  await selectedCore(user);
  controls.removeCore = true;
  controls.failInventory = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["infrastructure"] }); });
  expect(await screen.findByText("服务器清单刷新失败，以下保留已有记录与刚保存的配置。")).toBeTruthy();
  expect(screen.queryByText("此核心已从清单移除。请返回核心列表重新选择。")).toBeNull();
  expect(screen.getByRole("button", { name: "接入 Agent" })).toHaveProperty("disabled", false);
  expect(writes).toEqual([]);
});

it("does not resurrect a removed core when Back revisits its old workspace URL", async () => {
  const { controls, client, writes } = mount({ ownedHistory: true });
  const user = userEvent.setup();
  await selectedCore(user);
  controls.removeCore = true;
  await act(async () => { await client.invalidateQueries({ queryKey: ["infrastructure"] }); });
  await user.click(screen.getByRole("button", { name: "返回服务器清单" }));
  act(() => history.back());
  await waitFor(() => expect(location.hash).toBe(`#servers?host=${host.id}&instance=${core.id}`));
  expect(await screen.findByText("找不到匹配的服务器与核心，请从服务器清单重新选择。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "接入 Agent" })).toBeNull();
  expect(writes).toEqual([]);
});

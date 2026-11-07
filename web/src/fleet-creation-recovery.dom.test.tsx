// @vitest-environment jsdom
import { renderFleetSession } from "./test-support/fleet-session";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { UIProviders } from "./ui-patterns/providers";
import { FleetPage, FleetPlanForm } from "./Fleet";
import { fleetCreationStorageKey } from "./fleet-creation";
import type { Infrastructure } from "./types";

const key = fleetCreationStorageKey("fleet-test-admin");
const inventory = {
  hosts: [{ id: "host", name: "服务器", address: "127.0.0.1" }],
  instances: [{ id: "core", name: "办公核心", hostId: "host", adapterId: "routeweaver/xray", version: "26.10.31" }],
  deployments: ["office", "other"].map((id) => ({ id, name: id === "office" ? "办公路径" : "其他路径",
    ir: { programs: [{ instance: { id: "core" } }] } })), endpoints: [], links: [],
} as unknown as Infrastructure;
const target = { instanceId: "core", nodeId: "host", name: "办公核心", adapterId: "routeweaver/xray",
  coreVersion: "26.10.31", stage: 0, affectedUsers: 0, affectedRouteIds: [], changes: [],
  supported: true, diagnostics: [], status: "planned", attempts: [], configDiff: [] };
const plan = { fingerprint: "a".repeat(64), targets: [target], affectedUsers: 0, supported: true,
  diagnostics: [], disruption: "May restart" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const clients: QueryClient[] = [];
async function mount(onCreated = vi.fn(), onClose = vi.fn(), deployment = "office") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return renderFleetSession(
    <FleetPlanForm inventory={inventory} history={[]} initialDeploymentId={deployment} initialTargetIds={["core"]}
      onCreated={onCreated} onClose={onClose} />,
    (content) => render(<QueryClientProvider client={client}><UIProviders>{content}</UIProviders></QueryClientProvider>));
}
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function create() {
  await userEvent.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await userEvent.click(await screen.findByRole("checkbox", { name: "我已核对实例、阶段与影响范围" }));
  await userEvent.click(screen.getByRole("button", { name: "创建待执行批次" }));
  await screen.findByText("创建结果尚未确认，批次可能已创建。请先查询该次结果。");
}

it("keeps an unknown creation through Close and remount, then opens only the verified batch", async () => {
  let body: Record<string, unknown> = {};
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url); calls.push(`${init?.method || "GET"} ${path}`);
    if (path.endsWith("/preview")) return json(plan);
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); throw new Error("lost after commit"); }
    return json({ ...plan, ...body, actorId: "fleet-test-admin", createdAt: "2026-11-07T12:00:00Z", status: "planned" });
  }));
  const onCreated = vi.fn(), onClose = vi.fn();
  const first = await mount(onCreated, onClose);
  await create();
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect(screen.getByText(/关闭此面板后，当前标签页仍保留恢复记录/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("当前计划尚未创建。")).toBeNull();
  const stored = sessionStorage.getItem(key);
  first.unmount();
  await mount(onCreated);
  expect(sessionStorage.getItem(key)).toBe(stored);
  expect(calls.filter((call) => call === "POST /api/admin/fleet-batches")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "查询该次结果" }));
  await screen.findByText("批次已创建");
  expect(onCreated).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "查看批次进度" }));
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: body.id, deploymentId: "office", status: "planned" }));
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(calls.some((call) => /execute|retry|start|apply/.test(call))).toBe(false);
});

it("cancels abandonment without losing recovery, and explicitly abandons only the local record", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).endsWith("/preview")) return json(plan);
    writes.push(JSON.parse(String(init?.body))); throw new Error("lost");
  }));
  await mount(); await create();
  const stored = sessionStorage.getItem(key);
  for (let i = 0; i < 2; i++) {
    await userEvent.click(screen.getByRole("button", { name: "放弃本页恢复记录" }));
    const decision = await screen.findByRole("alertdialog", { name: "放弃核对这次创建？" });
    expect(within(decision).getByText(/不会删除服务器上的批次/)).toBeTruthy();
    await userEvent.click(within(decision).getByRole("button", { name: "继续核对" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sessionStorage.getItem(key)).toBe(stored);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "放弃本页恢复记录" })));
  }
  await userEvent.click(screen.getByRole("button", { name: "放弃本页恢复记录" }));
  await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃恢复记录" }));
  await screen.findByRole("button", { name: "预览影响与差异" });
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(writes).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "选择实例 办公核心" }).getAttribute("aria-checked")).toBe("true");
});

it("does not send a recovered batch into another deployment's contextual callback", async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).endsWith("/preview")) return json(plan);
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); throw new Error("lost"); }
    return json({ ...plan, ...body, actorId: "fleet-test-admin", createdAt: "2026-11-07T12:00:00Z", status: "planned" });
  }));
  const first = await mount(); await create(); first.unmount();
  const wrongCallback = vi.fn(); await mount(wrongCallback, vi.fn(), "other");
  expect(screen.getByRole("dialog", { name: "核对批次创建结果" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "查询该次结果" }));
  await screen.findByText("批次已创建");
  expect(screen.getByText("这是另一条转发路径的批次。请在执行任务中查看。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "查看批次进度" })).toBeNull();
  expect(screen.getByRole("link", { name: "前往执行任务" }).getAttribute("href")).toBe("#fleet");
  expect(wrongCallback).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).not.toBeNull();
});


it.for(["recover", "abandon"] as const)("keeps saved-ID recovery available without current inventory (%s)", async (action) => {
  let body: Record<string, unknown> = {};
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url); calls.push(`${init?.method || "GET"} ${path}`);
    if (path.endsWith("/preview")) return json(plan);
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); throw new Error("lost after commit"); }
    if (path === `/api/admin/fleet-batches/${body.id}`)
      return json({ ...plan, ...body, actorId: "fleet-test-admin", createdAt: "2026-11-07T12:00:00Z", status: "planned" });
    if (path === "/api/admin/fleet-batches") return json([]);
    return json({ detail: "Current inventory unavailable" }, 503);
  }));
  const first = await mount(); await create(); first.unmount();
  const original = sessionStorage.getItem(key);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  await renderFleetSession(<FleetPage />, (content) => render(
    <QueryClientProvider client={client}><UIProviders>{content}</UIProviders></QueryClientProvider>), { force: true });
  await screen.findByText("Current inventory unavailable");
  expect((screen.getByRole("button", { name: "计划变更" }) as HTMLButtonElement).disabled).toBe(true);
  const recover = screen.getByRole("button", { name: "继续核对创建结果" });
  expect((recover as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(recover);
  const sheet = within(await screen.findByRole("dialog", { name: "核对批次创建结果" }));
  expect(sheet.getByText("office", { exact: true })).toBeTruthy();
  expect(sessionStorage.getItem(key)).toBe(original);
  if (action === "recover") {
    await userEvent.click(sheet.getByRole("button", { name: "查询该次结果" }));
    await sheet.findByText("批次已创建");
    expect(calls).toContain(`GET /api/admin/fleet-batches/${body.id}`);
    await userEvent.click(sheet.getByRole("button", { name: "查看批次进度" }));
    await screen.findByRole("dialog", { name: "批量变更进度" });
    expect(sessionStorage.getItem(key)).toBeNull();
  } else {
    await userEvent.click(sheet.getByRole("button", { name: "放弃本页恢复记录" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃恢复记录" }));
    await screen.findByText("当前实例与转发路径尚未载入，暂不能计划新批次。");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole("button", { name: "预览影响与差异" })).toBeNull();
    expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
  }
  expect(calls.filter((call) => call === "POST /api/admin/fleet-batches")).toHaveLength(1);
  expect(calls.some((call) => /execute|retry|start|apply/.test(call))).toBe(false);
});


it("does not let a delayed abandonment focus handoff override a newer Close focus", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).endsWith("/preview")) return json(plan);
    throw new Error("lost after commit");
  }));
  await mount(); await create();
  await userEvent.click(screen.getByRole("button", { name: "放弃本页恢复记录" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃核对这次创建？" });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame; frames.set(id, callback); return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  await userEvent.click(within(decision).getByRole("button", { name: "放弃恢复记录" }));
  await screen.findByRole("button", { name: "预览影响与差异" });
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(frames.size).toBeGreaterThan(0);
  const close = screen.getByRole("button", { name: "关闭" });
  act(() => close.focus());
  act(() => { for (const frame of frames.values()) frame(performance.now()); frames.clear(); });
  expect(document.activeElement).toBe(close);
});

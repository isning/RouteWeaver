// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostAgentPanel, HostCoreInstallation } from "./HostAgent";

const host = { id: "host-fixture", name: "Fixture", address: "192.0.2.1" };
const instance = { id: "core-fixture", hostId: host.id, adapterId: "routeweaver/xray", version: "26.10.31", name: "Core" };
const release = { id: "xray-26.10.31-linux-amd64", adapterId: instance.adapterId, version: instance.version, platform: "linux-amd64" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function mount(online = true) {
  let installed = false;
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") {
      writes.push({ path, value: JSON.parse(init.body) });
      installed = true;
      return json({ phase: "queued" }, 202);
    }
    if (path.endsWith(`/hosts/${host.id}/state`)) return json({ nodeId: host.id, phase: online ? "online" : "unregistered" });
    if (path.endsWith("/admin/core-releases")) return json([release]);
    if (path.endsWith(`/instances/${instance.id}/state`)) return json({ instanceId: instance.id, phase: "unregistered", ...(installed ? { state: { installation: { releaseId: release.id } } } : {}) });
    throw new Error(`Unexpected request ${path}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HostAgentPanel host={host} onConnect={() => {}} /><HostCoreInstallation instance={instance} /></QueryClientProvider>);
  return writes;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("installs a core through its server agent without creating per-core enrollment or listeners", async () => {
  const writes = mount();
  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: "通过 Agent 安装" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  expect(writes).toEqual([]);
  await user.click(button);
  expect(await screen.findByText("核心已安装")).toBeTruthy();
  expect(screen.queryByText("安装任务已下发，等待服务器返回安装结果")).toBeNull();
  expect(writes).toEqual([{ path: `/api/admin/hosts/${host.id}/cores/${instance.id}/install`, value: { releaseId: release.id, expectedGeneration: "0" } }]);
});
it("keeps installation unavailable until the server agent connects", async () => {
  const writes = mount(false);
  expect(await screen.findByText("未接入")).toBeTruthy();
  expect(screen.getByRole("button", { name: "通过 Agent 安装" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "接入 Agent" })).toHaveProperty("disabled", false);
  expect(writes).toEqual([]);
});

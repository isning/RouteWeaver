// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UpdateOutput } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output } from "./types";

const diagnostic = "RUNTIME_OPTION_UNSUPPORTED: runtime.tun";
const title = "无法为 Mihomo 1.19.32 生成 TUN 配置";
const clients: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    }),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(options: {
  editable?: boolean; adapterId?: string; status?: number;
  detail?: string; body?: unknown; networkFailure?: boolean;
} = {}) {
  const profile = emptyProfile();
  profile.id = "structured-profile";
  // The editor's preview preference must not stand in for the selected output.
  profile.target = { adapterId: "sing-box", version: "1.14.3" };
  profile.ir.runtime.tun = { enabled: true, addresses: ["172.19.0.1/30"], autoRoute: true };
  const output: Output = {
    id: "structured-output", name: "工作电脑", profileId: profile.id,
    target: { adapterId: options.adapterId || "mihomo", version: "1.19.32" },
    mode: "full", status: "published",
  };
  const requests: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (options.networkFailure) throw new Error("Synthetic connection failure");
    return new Response(JSON.stringify(options.body ?? { detail: options.detail ?? diagnostic }), {
      status: options.status ?? 422, headers: { "Content-Type": "application/json" },
    });
  }));
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  clients.push(client);
  const closed = vi.fn();
  render(<QueryClientProvider client={client}><UIProviders>
    <UpdateOutput output={output} repairProfile={options.editable ? profile : undefined}
      onClose={closed} autoInspect />
  </UIProviders></QueryClientProvider>);
  return { requests, profile, output };
}

it.each([true, false])("explains the checked Mihomo TUN rejection without changing intent or publishing (editable=%s)", async (editable) => {
  const { requests, profile, output } = mount({ editable });
  const dialog = await screen.findByRole("dialog", { name: "检查订阅更新「工作电脑」" });
  await within(dialog).findByText(title);
  expect(within(dialog).queryByText("操作未完成")).toBeNull();
  expect(within(dialog).getByText(editable
    ? "请取消检查，回到“运行设置”关闭 TUN 后重新检查。草稿内容已保留，已发布内容未改变。"
    : "此订阅暂不支持发布 TUN 配置。已发布内容未改变。请取消检查，确认关联配置的 TUN 设置，或另选支持生成 TUN 配置的客户端订阅。",
  )).toBeTruthy();
  const details = within(dialog).getByText("查看检查详情").closest("details")!;
  expect(details.open).toBe(false);
  await userEvent.click(within(dialog).getByText("查看检查详情"));
  expect(details.open).toBe(true);
  expect(within(details).getByText(diagnostic)).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "确认更新「工作电脑」" })).toHaveProperty("disabled", true);
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(requests).toEqual([{
    path: "/api/me/profiles/structured-profile/preview",
    body: { outputId: output.id, target: output.target, mode: "full" },
  }]);
  expect(profile.ir.runtime.tun?.enabled).toBe(true);
  expect(profile.target).toEqual({ adapterId: "sing-box", version: "1.14.3" });
});

it.each([
  { label: "unknown 422", detail: "RUNTIME_OPTION_UNSUPPORTED: runtime.future" },
  { label: "additional diagnostic", detail: `${diagnostic}; another cause` },
  { label: "unstructured message", body: { message: diagnostic } },
  { label: "different client", adapterId: "sing-box" },
  { label: "authorization error", status: 403 },
  { label: "server error", status: 503 },
  { label: "network error", networkFailure: true },
])("does not reinterpret $label as the known Mihomo compatibility rejection", async ({ label: _label, ...options }) => {
  const { requests } = mount({ editable: true, ...options });
  const dialog = await screen.findByRole("dialog", { name: "检查订阅更新「工作电脑」" });
  await within(dialog).findByText("操作未完成");
  expect(within(dialog).queryByText(title)).toBeNull();
  expect(within(dialog).queryByText("查看检查详情")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "确认更新「工作电脑」" })).toHaveProperty("disabled", true);
  expect(requests).toHaveLength(1);
});

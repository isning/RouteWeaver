// @vitest-environment jsdom
// Actual administrator route entry with synthetic inventory HTTP; no node execution.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeAll(async () => {
  await Promise.all([import("./Infrastructure"), import("./ServerRoutes"), import("./PublishedRoutes"), import("./Fleet")]);
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, "", "/");
});
it.each([
  ["servers", "/api/hosts", "服务器", "暂无服务器"],
  ["routes", "/api/hosts", "转发路径", "暂无服务器转发路径"],
  ["published-routes", "/api/published-routes", "线路", "暂无线路"],
  ["fleet", "/api/admin/fleet-batches", "执行任务", "暂无批量变更"],
  ["fleet", "/api/core-instances", "执行任务", "暂无批量变更"],
  ["published-routes", "/api/core-instances", "线路", "暂无线路"],
])("allows administrator #%s entry and separates unavailable %s from authoritative empty", async (hash, heldEndpoint, heading, empty) => {
  history.replaceState(null, "", `/#${hash}`);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let release!: (response: Response) => void;
  let reads = 0;
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      unexpected.push(`${init.method} ${url}`); throw new Error("Read-only state case");
    }
    if (url === "/api/auth/me") return json({ user: { id: "admin-reader", name: "Admin", role: "admin" }, csrfToken: "synthetic" });
    if (url === heldEndpoint) {
      reads++;
      if (reads === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return json([]);
    }
    if (["/api/hosts", "/api/core-instances", "/api/managed-endpoints", "/api/links", "/api/server-deployments", "/api/published-routes", "/api/admin/fleet-batches"].includes(url)) return json([]);
    unexpected.push(url); throw new Error(`Unexpected network inventory request ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><App /></UIProviders></QueryClientProvider>);
  const main = await screen.findByRole("main");
  await within(main).findByRole("heading", { name: heading, level: 1 });
  const optionalRouteInventory = hash === "published-routes" && heldEndpoint === "/api/core-instances";
  if (optionalRouteInventory) {
    // The primary route list already succeeded; missing enrichment does not
    // turn its authoritative empty result into an unavailable route list.
    await within(main).findByText(empty);
    expect(within(main).getByRole("button", { name: "配置公开线路" }).hasAttribute("disabled")).toBe(true);
  } else {
    expect(within(main).getByLabelText("正在加载").getAttribute("aria-busy")).toBe("true");
    expect(within(main).queryByText(empty)).toBeNull();
  }
  await act(async () => { release(json({ message: `${heading}列表暂不可用` }, 503)); });
  if (optionalRouteInventory) {
    await within(main).findByText("转发路径信息暂时无法读取");
    expect(within(main).getByText(empty)).toBeTruthy();
    expect(within(main).getByRole("button", { name: "配置公开线路" }).hasAttribute("disabled")).toBe(true);
  } else {
    await within(main).findByText(`${heading}列表暂不可用`);
    expect(within(main).queryByText(empty)).toBeNull();
  }
  await userEvent.click(within(main).getByRole("button", { name: optionalRouteInventory ? "重试读取转发路径" : "重试" }));
  await within(main).findByText(empty);
  expect(within(main).queryByText(`${heading}列表暂不可用`)).toBeNull();
  if (hash === "routes") {
    expect(within(main).getAllByRole("button", { name: "新建转发路径" })).toHaveLength(1);
    expect(within(main).queryByRole("search", { name: "查找转发路径" })).toBeNull();
  }
  if (optionalRouteInventory) {
    const next = await within(main).findByRole("link", { name: "创建转发路径" });
    expect(next.getAttribute("aria-disabled")).toBeNull();
    expect(within(main).queryByText("转发路径信息暂时无法读取")).toBeNull();
  }
  expect(reads).toBe(2); expect(unexpected).toEqual([]);
});

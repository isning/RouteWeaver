// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UserEntries } from "./UserEntries";
import type { RouteRecord, Service } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const entry = {
  id: "entry", name: "Existing entry", routeId: "direct",
  credentialVersion: "v1", connection: { protocol: "socks", host: "entry.example", port: 1080 },
};
const policy = (routeIds: string[]) => ({ userId: "u", status: "active", routeIds });
let client: QueryClient;
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function mountPolicy(value: unknown, cached = false, entryRoute = "direct", routes?: RouteRecord[]) {
  const currentEntry = { ...entry, routeId: entryRoute };
  const writes: unknown[] = [];
  const reads: string[] = [];
  let response = value;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (init?.method === "POST") { writes.push(JSON.parse(init.body)); return json({}); }
    reads.push(path);
    if (path.endsWith("/effective-policy")) return response instanceof Response ? response.clone() : json(response);
    if (path.endsWith("/entitlement")) return json({ serviceId: "individual" });
    if (path.endsWith("/reveal")) return json(currentEntry);
    if (path.endsWith("/entries")) return json([currentEntry]);
    throw new Error(`Unexpected request: ${path}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (cached) client.setQueryData(["effective-policy", "u"], value);
  render(<QueryClientProvider client={client}><UIProviders><UserEntries
    user={{ id: "u", name: "User", enabled: true, quotaBytes: 0, usedBytes: 0 }}
    routes={routes ?? [
      { id: "direct", name: "Direct route", userIds: ["u"] },
      { id: "individual", name: "Individual plan route", userIds: [] },
      { id: "override", name: "Override route", userIds: [] },
      { id: "group", name: "Group plan route", userIds: [] },
    ] as RouteRecord[]}
    services={[{ id: "individual", routeIds: ["individual"] } as Service]}
    onClose={() => {}}
  /></UIProviders></QueryClientProvider>);
  return { writes, reads, respond: (next: unknown) => { response = next; } };
}
async function openChoices() {
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "授权线路" }));
}
it("uses the effective override instead of unioning individual-plan and legacy grants", async () => {
  const task = mountPolicy(policy(["override"]));
  await openChoices();
  expect(screen.getByRole("option", { name: "Override route" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Direct route" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Individual plan route" })).toBeNull();
  await userEvent.click(screen.getByRole("option", { name: "Override route" }));
  await userEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await waitFor(() => expect(task.writes).toEqual([expect.objectContaining({ routeId: "override" })]));
  expect(task.reads).toContain("/api/users/u/effective-policy");
  expect(task.reads).not.toContain("/api/users/u/entitlement");
});

it("offers a group-selected plan route without an individual entitlement or direct grant", async () => {
  mountPolicy({ ...policy(["group"]), serviceId: "group-plan", groupIds: ["team"] });
  await openChoices();
  expect(screen.getByRole("option", { name: "Group plan route" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Individual plan route" })).toBeNull();
});
it("keeps explicit deny-all empty and refuses an existing route rather than restoring legacy grants", async () => {
  const task = mountPolicy(policy([]));
  await openChoices();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByText("此用户当前没有授权线路。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await screen.findByText("此线路不在当前授权中，请重新选择授权线路。");
  expect(task.writes).toEqual([]);
});
it.each([
  ["missing", {}], ["null routes", { userId: "u", routeIds: null }],
  ["wrong user", { userId: "another-user", routeIds: ["direct"] }],
  ["non-string route", { userId: "u", routeIds: ["direct", 42] }],
  ["blank route", { userId: "u", routeIds: [""] }],
])("shows malformed %s shared-cache policy as retryable unknown, never an empty grant", async (_label, value) => {
  const task = mountPolicy(value, true);
  await screen.findByText("无法读取此用户的授权线路，请重试。");
  expect(screen.queryByText("此用户当前没有授权线路。")).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  task.respond(policy(["group"]));
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await openChoices();
  expect(screen.getByRole("option", { name: "Group plan route" })).toBeTruthy();
  expect(task.writes).toEqual([]);
});
it("rejects a malformed network policy without falling back to service or direct grants", async () => {
  mountPolicy({ userId: "u", routeIds: "direct" });
  await screen.findByText("无法读取此用户的授权线路，请重试。");
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
});
it("does not invent an option for an effective ID absent from the route inventory", async () => {
  const task = mountPolicy(policy(["unknown-route"]), false, "unknown-route");
  await openChoices();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  fireEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await screen.findByText("当前线路列表中没有此线路，请刷新列表后重试。");
  expect(screen.queryByText("此线路不在当前授权中，请重新选择授权线路。")).toBeNull();
  expect(task.writes).toEqual([]);
});
it("preserves an edited draft when refreshed policy removes its selected route and blocks that write", async () => {
  const task = mountPolicy(policy(["direct"]));
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const field = await screen.findByRole("textbox", { name: "入口名称" });
  fireEvent.change(field, { target: { value: "Retained draft" } });
  task.respond(policy(["group"]));
  await act(async () => { await client.invalidateQueries({ queryKey: ["effective-policy", "u"] }); });
  // Refetch completion precedes the scheduled observer render. Wait until
  // the revoked choice is retained only as its raw ID, not its old grant label.
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "授权线路" }).textContent).toBe("direct"),
  );
  expect(field).toHaveProperty("value", "Retained draft");
  fireEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await screen.findByText("此线路不在当前授权中，请重新选择授权线路。");
  expect(task.writes).toEqual([]);
  await userEvent.click(screen.getByRole("combobox", { name: "授权线路" }));
  await userEvent.click(screen.getByRole("option", { name: "Group plan route" }));
  await userEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await waitFor(() => expect(task.writes).toEqual([expect.objectContaining({ name: "Retained draft", routeId: "group" })]));
});
it("offers retry after a failed policy read without presenting explicit deny-all", async () => {
  const task = mountPolicy(json({ error: "Policy temporarily unavailable" }, 503));
  await screen.findByText("Policy temporarily unavailable");
  expect(screen.queryByText("此用户当前没有授权线路。")).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  task.respond(policy(["override"]));
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await openChoices();
  expect(screen.getByRole("option", { name: "Override route" })).toBeTruthy();
  expect(task.writes).toEqual([]);
});

// Public UI + transport seam; all requests and entry data are local fixtures.
it("distinguishes authorized same-name routes and literal identity captions before saving the raw route ID", async () => {
  const routes = [
    { id: "direct", name: "London" },
    { id: "group", name: "London" },
    { id: "literal", name: "London，线路标识：group" },
    { id: "forbidden", name: "London" },
  ] as RouteRecord[];
  const task = mountPolicy(policy(["direct", "group", "literal"]), false, "direct", routes);
  await openChoices();
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("option", { name: "London，线路标识：direct" }).textContent).toContain("direct");
  expect(screen.getByRole("option", { name: "London，线路标识：group，线路标识：literal" }).textContent).toContain("literal");
  expect(screen.queryByRole("option", { name: /forbidden/ })).toBeNull();
  await userEvent.type(screen.getByRole("combobox", { name: "搜索选项" }), "group");
  await userEvent.click(screen.getByRole("option", { name: "London，线路标识：group" }));
  expect(screen.getByRole("combobox", { name: "授权线路" }).textContent).toBe("London线路标识：group");
  await userEvent.click(screen.getByRole("button", { name: "保存入口" }));
  await waitFor(() => expect(task.writes).toEqual([expect.objectContaining({ routeId: "group" })]));
});
it("keeps a sole authorized route concise when only unauthorized routes share its name", async () => {
  const task = mountPolicy(policy(["direct"]), false, "direct", [
    { id: "direct", name: "London" },
    { id: "forbidden", name: "London" },
  ] as RouteRecord[]);
  await openChoices();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: "London" }).textContent).toBe("London");
  expect(task.writes).toEqual([]);
});

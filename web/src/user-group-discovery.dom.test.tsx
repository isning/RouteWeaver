// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UserGroups } from "./AccessPolicy";
import type { Service } from "./types";
import type { UserGroup } from "./access-policy-model";
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(editContext?: "ready" | "error") {
  const groups: UserGroup[] = Array.from({ length: 23 }, (_, i) => ({ id: `g-${i}`, name: `Group ${String(i).padStart(2, "0")}`, serviceId: i === 22 ? "missing-plan" : i % 2 ? "beta" : "alpha", priority: 1, memberIds: ["private-member-id"] }));
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const request = `${init?.method || "GET"} ${String(url)}`; requests.push(request);
    if (editContext && request === "GET /api/access-policy/edit-context/group/g-0") {
      return new Response(JSON.stringify(editContext === "error" ? { detail: "Context unavailable" } : {
        target: { kind: "group", id: "g-0" }, record: { group: groups[0] }, precondition: { exists: true, revision: "opening-1" },
      }), { status: editContext === "error" ? 503 : 200, headers: { "Content-Type": "application/json" } });
    }
    if (request !== "GET /api/user-groups") throw new Error(`Unexpected request: ${request}`);
    return new Response(JSON.stringify(groups), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const services = [{ id: "alpha", name: "Alpha Plan" }, { id: "beta", name: "Beta Plan" }] as Service[];
  render(<QueryClientProvider client={client}><UIProviders><UserGroups users={[]} services={services} routes={[]} /></UIProviders></QueryClientProvider>);
  await screen.findByRole("cell", { name: "Group 00" });
  return { groups, client, requests, user: userEvent.setup(), search: screen.getByRole("searchbox", { name: "搜索用户组" }) };
}
it("combines group/plan search with plan filters and restores empty matches without exposing members or fetching details", async () => {
  const { user, search, requests } = await setup();
  fireEvent.change(search, { target: { value: "  ALPHA PLAN  " } });
  expect(await screen.findByRole("cell", { name: "Group 00" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Group 01" })).toBeNull();
  expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "找到 11 个用户组")).toBeTruthy();
  expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "共 23 个用户组")).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "筛选用户组服务方案" }));
  await user.click(screen.getByRole("option", { name: "Beta Plan" }));
  expect(screen.getByText("没有匹配的用户组")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  expect(search).toHaveProperty("value", "");
  expect(screen.getByRole("cell", { name: "Group 01" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "group 22" } });
  expect(screen.getByRole("cell", { name: "missing-plan" })).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "筛选用户组服务方案" }));
  await user.click(screen.getByRole("option", { name: "missing-plan" }));
  expect(screen.getByRole("cell", { name: "Group 22" })).toBeTruthy();
  expect(screen.queryByText("private-member-id")).toBeNull();
  expect(requests).toEqual(["GET /api/user-groups"]);
});
it("resets search and filter pagination and clamps refreshed results without reviving an old page", async () => {
  const { user, search, client, groups } = await setup();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByRole("cell", { name: "Group 10" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "Group" } });
  expect(await screen.findByRole("cell", { name: "Group 00" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await user.click(screen.getByRole("combobox", { name: "筛选用户组服务方案" }));
  await user.click(screen.getByRole("option", { name: "Alpha Plan" }));
  expect(await screen.findByRole("cell", { name: "Group 00" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getByRole("cell", { name: "Group 20" })).toBeTruthy();
  await act(async () => { client.setQueryData(["user-groups"], groups.slice(0, 4)); });
  expect(await screen.findByRole("cell", { name: "Group 00" })).toBeTruthy();
  await act(async () => { client.setQueryData(["user-groups"], groups); });
  expect(await screen.findByRole("cell", { name: "Group 00" })).toBeTruthy();
  expect(within(screen.getByRole("table")).queryByRole("cell", { name: "Group 20" })).toBeNull();
});

for (const context of ["ready", "error"] as const) {
  it(`restores the original group trigger first, then search if the filtered row disappears (${context} editor)`, async () => {
    const { user, search, client, groups } = await setup(context);
    fireEvent.change(search, { target: { value: "Group 00" } });
    const trigger = screen.getByRole("button", { name: "编辑 Group 00" });
    const open = async () => {
      await user.click(trigger);
      if (context === "ready") await screen.findByRole("textbox", { name: "用户组名称" });
      else await screen.findByText("Context unavailable");
    };
    await open();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await open();
    await act(async () => { client.setQueryData(["user-groups"], groups.map(group => group.id === "g-0" ? { ...group, name: "Renamed group" } : group)); });
    await waitFor(() => expect(trigger.isConnected).toBe(false));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(screen.getByText("没有匹配的用户组")).toBeTruthy();
  });
}

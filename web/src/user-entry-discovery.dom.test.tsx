// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UserEntries } from "./UserEntries";
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(reveal = false) {
  const records = Array.from({ length: 23 }, (_, i) => ({ id: `entry-${i}`, name: `Entry ${String(i).padStart(2, "0")}`, routeId: "legacy", publishedRouteId: reveal && i === 0 ? undefined : i === 22 ? "missing-route" : "published", status: "unknown", revoked: i === 21, credentialVersion: "private-version", connection: { protocol: "socks", password: "private-password", host: "private-host", port: 1080 } }));
  const requests: string[] = [];
  let release!: (response: Response) => void;
  let revealSignal: AbortSignal | undefined;
  const held = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const request = `${init?.method || "GET"} ${String(url)}`; requests.push(request);
    if (request === "GET /api/users/u/entries") return Response.json(records);
    if (request === "GET /api/users/u/effective-policy") return Response.json({ userId: "u", routeIds: ["legacy"] });
    if (reveal && request === "GET /api/users/u/entries/entry-0/reveal") { revealSignal = init?.signal; return held; }
    throw new Error(`Unexpected request ${request}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><UserEntries user={{ id: "u", name: "User", enabled: true, quotaBytes: 0, usedBytes: 0 }} routes={[]} publishedRoutes={[{ id: "published", name: "Tokyo line" }]} services={[]} onClose={() => {}} /></UIProviders></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Entry 00" });
  return { user: userEvent.setup(), requests, records, release, signal: () => revealSignal };
}
it("finds visible entry and route names across pages without matching credentials or revealing them", async () => {
  const { user, requests } = await setup();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  const search = screen.getByRole("searchbox", { name: "搜索平台入口" });
  fireEvent.change(search, { target: { value: " TOKYO LINE " } });
  expect(screen.getByRole("heading", { name: "Entry 00" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "已撤销" }));
  expect(screen.getByRole("heading", { name: "Entry 21" })).toBeTruthy();
  expect(screen.getByText("找到 1 个平台入口")).toBeTruthy();
  expect(screen.getByText("共 23 个平台入口")).toBeTruthy();
  for (const term of ["private-password", "private-version", "private-host"]) {
    fireEvent.change(search, { target: { value: term } });
    expect(screen.getByText("没有匹配的平台入口")).toBeTruthy();
  }
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "missing-route" } });
  expect(screen.getByRole("heading", { name: "Entry 22" })).toBeTruthy();
  expect(requests.sort()).toEqual(["GET /api/users/u/effective-policy", "GET /api/users/u/entries"]);
});

it("keeps page position valid after refresh and cancels a hidden reveal without opening its late response", async () => {
  const { user, records, release, signal, requests } = await setup(true);
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await act(async () => { client.setQueryData(["user-entries", "u"], records.slice(0, 2)); });
  await screen.findByRole("heading", { name: "Entry 00" });
  await act(async () => { client.setQueryData(["user-entries", "u"], records); });
  expect(screen.queryByRole("heading", { name: "Entry 10" })).toBeNull();
  await user.click(within(screen.getByRole("listitem", { name: "Entry 00" })).getByRole("button", { name: "编辑" }));
  await screen.findByRole("button", { name: "取消读取" });
  const search = screen.getByRole("searchbox", { name: "搜索平台入口" });
  fireEvent.change(search, { target: { value: "Entry 01" } });
  await user.click(screen.getByRole("button", { name: "取消读取" }));
  expect(document.activeElement).toBe(search);
  expect(signal()?.aborted).toBe(true);
  await act(async () => release(Response.json(records[0])));
  expect(screen.queryByRole("textbox", { name: "入口名称" })).toBeNull();
  expect(requests.filter(request => request.includes("/reveal"))).toHaveLength(1);
  expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Entry 01" })).toBeTruthy());
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "./Templates";
import { UIProviders } from "./ui-patterns/providers";
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  const templates = [
    { id: "preset", name: "Region selector", kind: "processing-preset", version: 1, spec: {} },
    { id: "client", name: "Daily client", kind: "client-profile", version: 1, spec: {} },
    { id: "future", name: "Future template", kind: "future-kind", version: 1, spec: {} },
  ];
  const bindings = Array.from({ length: 23 }, (_, i) => ({ id: `binding-${i}`, targetKind: "profiles", targetId: `profile-${i}`, templateId: i === 22 ? "missing-template" : "client", mode: "follow", appliedVersion: 1 }));
  const requests: string[] = [];
  const data: Record<string, unknown> = { "/api/templates": templates, "/api/me/template-bindings": bindings, "/api/me/profiles": bindings.map((b, i) => ({ id: b.targetId, name: `Profile ${String(i).padStart(2, "0")}` })), "/api/me/collections": [] };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const request = `${init?.method || "GET"} ${String(url)}`; requests.push(request);
    if (!request.startsWith("GET ") || !Object.hasOwn(data, String(url))) throw new Error(`Unexpected request ${request}`);
    return new Response(JSON.stringify(data[String(url)]), { headers: { "Content-Type": "application/json" } });
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><TemplatesPage /></UIProviders></QueryClientProvider>);
  await screen.findByRole("heading", { name: "Future template" });
  return { user: userEvent.setup(), requests, bindings };
}
it("finds catalog names and kinds while retaining unknown kinds in all and clearing empty matches", async () => {
  const { user, requests } = await setup();
  const search = screen.getByRole("searchbox", { name: "搜索模板" });
  await user.click(within(screen.getByRole("group", { name: "模板类型" })).getByRole("button", { name: "节点处理预设" }));
  expect(screen.queryByRole("heading", { name: "Future template" })).toBeNull();
  fireEvent.change(search, { target: { value: "  REGION  " } });
  expect(screen.getByRole("heading", { name: "Region selector" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "missing" } });
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("heading", { name: "Future template" })).toBeTruthy();
  expect(requests).toHaveLength(4);
});
it("finds reference identities across pages, restores focus and clamps shrinking results without update requests", async () => {
  const { user, requests, bindings } = await setup();
  await user.click(screen.getByRole("tab", { name: "我的引用" }));
  await screen.findByRole("cell", { name: "Profile 00" });
  await user.click(screen.getByRole("button", { name: "下一页" }));
  const search = screen.getByRole("searchbox", { name: "搜索模板引用" });
  fireEvent.change(search, { target: { value: " DAILY CLIENT " } });
  expect(screen.getByRole("cell", { name: "Profile 00" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await act(async () => { client.setQueryData(["template-bindings"], bindings.slice(0, 2)); });
  await screen.findByRole("cell", { name: "Profile 00" });
  await act(async () => { client.setQueryData(["template-bindings"], bindings); });
  expect(screen.queryByRole("cell", { name: "Profile 10" })).toBeNull();
  fireEvent.change(search, { target: { value: "missing-template" } });
  expect(screen.getByRole("cell", { name: "Profile 22" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "not found" } });
  await user.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("cell", { name: "Profile 00" })).toBeTruthy();
  expect(requests).toHaveLength(4);
});
it("searches collection display identity and keeps duplicate-name disambiguation", async () => {
  const { user, requests } = await setup();
  await act(async () => {
    client.setQueryData(["collections"], [{ id: "collection-a", name: "Shared name" }, { id: "collection-b", name: "Shared name" }]);
    client.setQueryData(["template-bindings"], ["a", "b"].map(id => ({ id: `binding-${id}`, targetKind: "collections", targetId: `collection-${id}`, templateId: "preset", mode: "follow", appliedVersion: 1 })));
  });
  await user.click(screen.getByRole("tab", { name: "我的引用" }));
  const search = await screen.findByRole("searchbox", { name: "搜索模板引用" });
  fireEvent.change(search, { target: { value: "collection-b" } });
  expect(screen.getByRole("button", { name: "检查更新 Shared name（集合 collection-b）" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "检查更新 Shared name（集合 collection-a）" })).toBeNull();
  expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "找到 1 条引用")).toBeTruthy();
  expect(screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === "共 2 条引用")).toBeTruthy();
  expect(requests).toHaveLength(4);
});

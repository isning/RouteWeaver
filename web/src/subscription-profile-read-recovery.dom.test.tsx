// @vitest-environment jsdom
// Public subscription inventory/editor tasks with failures only at the HTTP boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { SubscriptionsPage } from "./Subscriptions";
import { SubscriptionContextProvider } from "./SubscriptionContext";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const profile = (id: string, name: string): Profile => ({
  ...emptyProfile(), id, name, revisionToken: `revision-${id}-1`,
});
const output = (id: string, profileId: string, name = id): Output => ({
  id, profileId, name, target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full", status: "published",
});
const clients: QueryClient[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
function fixture(profiles: Profile[], outputs: Output[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const state = {
    profiles, outputs, failProfiles: false, failReveal: false, failAfterSave: false,
    pendingProfiles: undefined as Promise<Response> | undefined,
  };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url), method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/me/profiles")
      return state.pendingProfiles || (state.failProfiles ? json({ error: "Profile list unavailable" }, 503) : json(state.profiles));
    if (method === "GET" && path === "/api/me/outputs") return json(state.outputs);
    if (method === "GET" && path === "/api/me/overview") return json({ status: "active", routes: [] });
    if (method === "GET" && ["sources", "collections", "resources", "platform-entries"].some((name) => path === `/api/me/${name}`)) return json([]);
    const reveal = path.match(/^\/api\/me\/profiles\/([^/]+)\/reveal$/);
    if (method === "GET" && reveal) {
      if (state.failReveal) return json({ error: "Fresh profile unavailable" }, 503);
      const found = state.profiles.find((item) => item.id === reveal[1]);
      return found ? json(found) : json({ error: "Profile missing" }, 404);
    }
    const save = path.match(/^\/api\/me\/profiles\/([^/]+)$/);
    if (method === "PUT" && save) {
      const saved = { ...body, revisionToken: `revision-${save[1]}-2` } as Profile;
      state.profiles = state.profiles.map((item) => item.id === saved.id ? saved : item);
      if (state.failAfterSave) state.failProfiles = true;
      return json(saved);
    }
    unexpected.push(`${method} ${path}`);
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
  render(
    <QueryClientProvider client={client}>
      <UIProviders><SubscriptionContextProvider><SubscriptionsPage /></SubscriptionContextProvider></UIProviders>
    </QueryClientProvider>,
  );
  return { client, state, calls, unexpected };
}
const article = (name: string) => screen.getByRole("article", { name: `分流配置 ${name}` });
const expectNoFalseOrphans = () => {
  expect(screen.queryByRole("article", { name: /^关联配置不可用/ })).toBeNull();
  expect(screen.queryByText("关联配置不可用", { exact: true })).toBeNull();
  expect(screen.queryByText("不可用的分流配置", { exact: true })).toBeNull();
  expect(screen.queryByText("此分流配置不可用", { exact: true })).toBeNull();
};

it("retains saved and linked profile identities after a successful save's list refresh fails, while edits still require their own fresh read", async () => {
  const t = fixture(
    [profile("draft", "Unpublished draft"), profile("linked", "Linked profile")],
    [output("phone", "linked", "Phone")],
  );
  await screen.findByRole("article", { name: "分流配置 Unpublished draft" });
  await userEvent.click(await within(article("Unpublished draft")).findByRole("button", { name: "继续配置" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), { target: { value: "Saved newer name" } });
  t.state.failAfterSave = true;
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存", { exact: true });
  await waitFor(() => expect(t.calls.filter((call) => call.path === "/api/me/profiles")).toHaveLength(2));
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findByText("暂时无法加载分流配置");
  expect(article("Unpublished draft")).toBeTruthy();
  const linked = article("Linked profile");
  expect(within(linked).getByRole("button", { name: "查看订阅 Phone" })).toBeTruthy();
  expectNoFalseOrphans();
  expect(within(linked).getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", true);
  expect(within(linked).getByRole("button", { name: "为 Linked profile 新增客户端订阅" })).toHaveProperty("disabled", true);
  expect(within(linked).getByRole("button", { name: "获取订阅" })).toHaveProperty("disabled", false);

  // A retained row is an identity, not an editable copy or a fresh revision token.
  t.state.failReveal = true;
  await userEvent.click(within(article("Unpublished draft")).getByRole("button", { name: "继续配置" }));
  await screen.findByText("Fresh profile unavailable");
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(article("Unpublished draft")).toBeTruthy();
  t.state.failReveal = false;
  await userEvent.click(within(article("Unpublished draft")).getByRole("button", { name: "继续配置" }));
  expect(await screen.findByRole("textbox", { name: "配置名称" })).toHaveProperty("value", "Saved newer name");
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  t.state.failProfiles = false;
  await userEvent.click(await screen.findByRole("button", { name: "重试配置" }));
  await screen.findByRole("article", { name: "分流配置 Saved newer name" });
  expect(screen.queryByRole("article", { name: "分流配置 Unpublished draft" })).toBeNull();
  expect(within(article("Linked profile")).getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", false);
  expect(t.calls.filter((call) => call.path === "/api/me/profiles/draft/reveal")).toHaveLength(3);
  expect(t.calls.filter((call) => call.method !== "GET")).toEqual([
    expect.objectContaining({ method: "PUT", path: "/api/me/profiles/draft", body: expect.objectContaining({ name: "Saved newer name" }) }),
  ]);
  expect(t.unexpected).toEqual([]);
});

it("keeps search, profile page and client-link page visible during a failed cached profile refresh and successful retry", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => profile(`p${i}`, `Travel ${i}`));
  const links = Array.from({ length: 6 }, (_, i) => output(`phone${i}`, "p10", `Phone ${i}`));
  const t = fixture(rows, links);
  fireEvent.change(await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }), { target: { value: "Travel" } });
  await userEvent.click(within(screen.getByRole("navigation", { name: "配置清单分页" })).getByRole("button", { name: "下一页" }));
  await userEvent.click(within(screen.getByRole("navigation", { name: "Travel 10的客户端订阅分页" })).getByRole("button", { name: "下一页" }));
  expect(within(article("Travel 10")).getByRole("button", { name: "查看订阅 Phone 5" })).toBeTruthy();
  t.state.failProfiles = true;
  await act(async () => { await t.client.invalidateQueries({ queryKey: ["profiles"], exact: true }); });
  await screen.findByText("暂时无法加载分流配置");
  expect(screen.getByRole("textbox", { name: "搜索配置或客户端订阅" })).toHaveProperty("value", "Travel");
  expect(article("Travel 11")).toBeTruthy();
  expect(screen.queryByRole("article", { name: "分流配置 Travel 0" })).toBeNull();
  expect(within(article("Travel 10")).getByRole("button", { name: "查看订阅 Phone 5" })).toBeTruthy();
  expect(within(article("Travel 10")).queryByRole("button", { name: "查看订阅 Phone 0" })).toBeNull();
  expectNoFalseOrphans();
  expect(location.hash).toBe("#subscriptions");
  t.state.failProfiles = false;
  await userEvent.click(screen.getByRole("button", { name: "重试配置" }));
  await waitFor(() => expect(screen.queryByText("暂时无法加载分流配置")).toBeNull());
  expect(article("Travel 11")).toBeTruthy();
  expect(within(article("Travel 10")).getByRole("button", { name: "查看订阅 Phone 5" })).toBeTruthy();
  expect(t.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(t.unexpected).toEqual([]);
});

it("explains a paused cached profile refresh while retaining identity and withholding publication until reconnect", async () => {
  const t = fixture(
    [profile("linked", "Linked profile")],
    [output("phone", "linked", "Phone")],
  );
  await screen.findByRole("article", { name: "分流配置 Linked profile" });
  const update = () => within(article("Linked profile")).getByRole("button", { name: "检查更新" });
  const create = () => within(article("Linked profile")).getByRole("button", { name: "为 Linked profile 新增客户端订阅" });
  await waitFor(() => expect(update()).toHaveProperty("disabled", false));
  expect(create()).toHaveProperty("disabled", false);
  const priorReads = t.calls.filter((call) => call.path === "/api/me/profiles").length;
  act(() => {
    onlineManager.setOnline(false);
    void t.client.invalidateQueries({ queryKey: ["profiles"], exact: true });
  });
  await screen.findByText("等待网络连接");
  expect(screen.getByText("连接恢复后将继续核对配置与客户端订阅。")).toBeTruthy();
  expect(within(article("Linked profile")).getByRole("button", { name: "查看订阅 Phone" })).toBeTruthy();
  expectNoFalseOrphans();
  expect(update()).toHaveProperty("disabled", true);
  expect(create()).toHaveProperty("disabled", true);
  expect(t.calls.filter((call) => call.path === "/api/me/profiles")).toHaveLength(priorReads);

  act(() => onlineManager.setOnline(true));
  await waitFor(() => expect(update()).toHaveProperty("disabled", false));
  expect(create()).toHaveProperty("disabled", false);
  expect(screen.queryByText("等待网络连接")).toBeNull();
  expect(t.calls.filter((call) => call.path === "/api/me/profiles")).toHaveLength(priorReads + 1);
  expectNoFalseOrphans();
  expect(t.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(t.unexpected).toEqual([]);
});

it("shows a pending cached profile refresh without hiding the inventory or enabling publication before it settles", async () => {
  const t = fixture(
    [profile("linked", "Linked profile")],
    [output("phone", "linked", "Phone")],
  );
  await screen.findByRole("article", { name: "分流配置 Linked profile" });
  const update = () => within(article("Linked profile")).getByRole("button", { name: "检查更新" });
  const create = () => within(article("Linked profile")).getByRole("button", { name: "为 Linked profile 新增客户端订阅" });
  await waitFor(() => expect(update()).toHaveProperty("disabled", false));
  let finish!: (response: Response) => void;
  t.state.pendingProfiles = new Promise((resolve) => { finish = resolve; });
  act(() => { void t.client.invalidateQueries({ queryKey: ["profiles"], exact: true }); });
  try {
    await screen.findByRole("status", { name: "正在加载配置与客户端订阅" });
    expect(within(article("Linked profile")).getByRole("button", { name: "查看订阅 Phone" })).toBeTruthy();
    expectNoFalseOrphans();
    expect(update()).toHaveProperty("disabled", true);
    expect(create()).toHaveProperty("disabled", true);
    expect(screen.queryByText("等待网络连接")).toBeNull();
  } finally {
    await act(async () => { finish(json(t.state.profiles)); });
  }
  await waitFor(() => expect(update()).toHaveProperty("disabled", false));
  expect(create()).toHaveProperty("disabled", false);
  expect(screen.queryByRole("status", { name: "正在加载配置与客户端订阅" })).toBeNull();
  expect(t.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(t.unexpected).toEqual([]);
});

it.each([false, true])("keeps the selected profile through failure, then honors confirmed absence without changing scope (linked=%s)", async (linked) => {
  history.replaceState(null, "", "#subscriptions?profile=chosen");
  const t = fixture(
    [profile("chosen", "Chosen profile"), profile("other", "Other profile")],
    linked ? [output("phone", "chosen", "Phone")] : [],
  );
  await screen.findByRole("article", { name: "分流配置 Chosen profile" });
  t.state.failProfiles = true;
  await act(async () => { await t.client.invalidateQueries({ queryKey: ["profiles"], exact: true }); });
  await screen.findByText("暂时无法加载分流配置");
  expect(article("Chosen profile")).toBeTruthy();
  expect(screen.queryByRole("article", { name: "分流配置 Other profile" })).toBeNull();
  expectNoFalseOrphans();
  expect(location.hash).toBe("#subscriptions?profile=chosen");
  t.state.profiles = [];
  t.state.failProfiles = false;
  await userEvent.click(screen.getByRole("button", { name: "重试配置" }));
  await screen.findByText("此分流配置不可用", { exact: true });
  expect(screen.queryByRole("article", { name: "分流配置 Chosen profile" })).toBeNull();
  expect(screen.queryByText("暂时无法加载分流配置")).toBeNull();
  if (linked) {
    const orphan = screen.getByRole("article", { name: "关联配置不可用 chosen" });
    expect(within(orphan).getByRole("button", { name: "查看订阅 Phone" })).toBeTruthy();
    expect(within(orphan).getByRole("button", { name: "检查更新" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "编辑配置" })).toBeNull();
  } else {
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByText("当前范围内没有可访问的配置或订阅")).toBeTruthy();
  }
  expect(location.hash).toBe("#subscriptions?profile=chosen");
  expect(t.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(t.unexpected).toEqual([]);
});

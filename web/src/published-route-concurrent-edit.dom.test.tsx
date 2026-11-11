// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishedRoutesPage, type PublishedRoute } from "./PublishedRoutes";
import { hasUnsavedChanges } from "./navigation";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import { createWorkspaceHistory, type WorkspaceHistory } from "./workspace-history";
import { installSessionTransport, APIError } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const original: PublishedRoute = {
  id: "line", revisionToken: "revision-one", name: "Office line", deploymentId: "path",
  endpointIds: ["entry", "exit"], publicHost: "office.example", publicPort: 443,
  status: "draft", diagnostics: [],
};
const latest: PublishedRoute = {
  ...original, revisionToken: "revision-two", name: "Latest office line", deploymentId: "other-path",
  endpointIds: ["other-entry", "other-exit"], publicHost: "latest.example", publicPort: 9443,
};
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/managed-xray", version: "26.3.27-rw1" };
const endpoints = ["entry", "exit", "other-entry", "other-exit"].map(id => ({
  id, name: id, instanceId: "core", authentication: "principals",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
}));
const deployments = ["path", "other-path"].map((id, index) => ({
  id, name: id, status: "draft", diagnostics: [],
  ir: { schemaVersion: "1.0", id, topologyRevision: "r1", programs: endpoints.slice(index * 2, index * 2 + 2).map(listener => ({ instance, listener, rules: [], resources: [], egress: [] })) },
}));
type Call = { path: string; method: string; body?: Record<string, unknown>; token: string | null };
const clients: QueryClient[] = [];
const disposers: (() => void)[] = [];
function setup(options: {
  extra?: (call: Call) => Response | Promise<Response> | undefined;
  workspace?: { current: WorkspaceHistory | null };
} = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const call: Call = { path: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, token: new Headers(init?.headers).get("If-Match") };
    calls.push(call);
    const response = options.extra?.(call);
    if (response) return response;
    if (call.method === "PUT") return json({ error: "Record changed" }, 409);
    if (call.path.endsWith("/preview")) return json({ ...original, ...call.body });
    if (call.path.endsWith("/resolve")) return json(latest);
    if (call.path.endsWith("/published-routes")) return json([original]);
    if (call.path.endsWith("/server-deployments")) return json(deployments);
    if (call.path.endsWith("/managed-endpoints")) return json(endpoints);
    if (call.path.endsWith("/core-instances")) return json([instance]);
    if (call.path.endsWith("/hosts")) return json([{ id: "host", name: "Host", address: "office.example" }, { id: "other-host", name: "Other host", address: "other.example" }]);
    if (call.path.endsWith("/state")) return json({ users: [], services: [], routes: [], publishedRoutes: [original] });
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const mounted = render(<QueryClientProvider client={client}><UIProviders><WorkspaceHistoryContext.Provider value={options.workspace ?? null}><PublishedRoutesPage /></WorkspaceHistoryContext.Provider></UIProviders></QueryClientProvider>);
  return { calls, client, mounted, user: userEvent.setup() };
}
async function conflict(options?: Parameters<typeof setup>[0]) {
  const context = setup(options);
  await context.user.click(await screen.findByRole("button", { name: "编辑" }));
  const element = await screen.findByRole("dialog", { name: "编辑 Office line" });
  const editor = within(element);
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "My office line" } });
  await context.user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await context.user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await editor.findByText("Record changed", { exact: true });
  return { ...context, editor, element };
}
async function compare(context: Awaited<ReturnType<typeof conflict>>) {
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  return within(await screen.findByRole("dialog", { name: "比较公开线路修改" }));
}
async function choose(review: ReturnType<typeof within>, user: ReturnType<typeof userEvent.setup>, group: string, choice: "保留当前输入" | "使用最新版本") {
  await user.click(within(review.getByRole("group", { name: group })).getByRole("radio", { name: choice }));
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#published-routes");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => originalStyle(element));
});
afterEach(() => { cleanup(); disposers.splice(0).forEach(dispose => dispose()); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Public page and HTTP boundary: choices cannot mutate the saved record or skip preview.
it("requires every differing group and saves only the complete explicitly selected draft with the reviewed token", async () => {
  const context = await conflict();
  const { editor, user, calls } = context;
  const review = await compare(context);
  const apply = review.getByRole("button", { name: "使用所选内容继续编辑" });
  expect(apply.hasAttribute("disabled")).toBe(true);
  await choose(review, user, "线路名称", "保留当前输入");
  await choose(review, user, "转发路径与顺序", "使用最新版本");
  expect(apply.hasAttribute("disabled")).toBe(true);
  await choose(review, user, "对外地址与端口", "使用最新版本");
  await user.click(apply);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull());
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  const expected = { id: "line", name: "My office line", deploymentId: "other-path", endpointIds: ["other-entry", "other-exit"], publicHost: "latest.example", publicPort: 9443 };
  expect(calls.filter(call => call.path.endsWith("/preview")).at(-1)?.body).toEqual(expected);
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(calls.filter(call => call.method === "PUT")).toHaveLength(2));
  expect(calls.filter(call => call.method === "PUT")).toEqual([
    expect.objectContaining({ token: "revision-one" }),
    expect.objectContaining({ token: "revision-two", body: expected }),
  ]);
  // A third-party edit after review blocks again. Rechecking alone cannot clear it.
  await editor.findByRole("button", { name: "读取最新版本并比较" });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
});

it.each(["", "1.5", "70000", "1e"])("keeps raw port %j and every unrelated edit when comparison is cancelled or current address is selected", async (raw) => {
  const context = await conflict();
  const { user, editor, calls } = context;
  const name = editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement;
  const host = editor.getByRole("textbox", { name: "对外域名或 IP" }) as HTMLInputElement;
  const port = editor.getByRole("spinbutton", { name: "对外端口" }) as HTMLInputElement;
  fireEvent.change(host, { target: { value: "my.example" } });
  fireEvent.change(port, { target: { value: raw } });
  let review = await compare(context);
  await choose(review, user, "线路名称", "使用最新版本");
  await user.click(review.getByRole("button", { name: "取消比较" }));
  const trigger = await editor.findByRole("button", { name: "读取最新版本并比较" });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(name.value).toBe("My office line");
  expect(host.value).toBe("my.example");
  expect(port.value).toBe(raw);
  review = await compare(context);
  expect(review.getAllByRole("radio").every(radio => radio.getAttribute("aria-checked") === "false")).toBe(true);
  await choose(review, user, "线路名称", "使用最新版本");
  await choose(review, user, "转发路径与顺序", "使用最新版本");
  await choose(review, user, "对外地址与端口", "保留当前输入");
  await user.click(review.getByRole("button", { name: "使用所选内容继续编辑" }));
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(name.value).toBe("Latest office line");
  expect(host.value).toBe("my.example");
  // Changing the selected deployment must not reset the raw, unaccepted port.
  expect((editor.getByRole("spinbutton", { name: "对外端口" }) as HTMLInputElement).value).toBe(raw);
  expect(hasUnsavedChanges()).toBe(true);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByText("对外端口须为 1–65535 的整数，且不能留空。", { exact: true });
  expect(calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(calls.filter(call => call.path.endsWith("/preview"))).toHaveLength(1);
});

it("uses the latest baseline for dirty tracking without treating comparison as a save", async () => {
  const context = await conflict();
  const review = await compare(context);
  for (const group of ["线路名称", "转发路径与顺序", "对外地址与端口"])
    await choose(review, context.user, group, "使用最新版本");
  await context.user.click(review.getByRole("button", { name: "使用所选内容继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull());
  expect(hasUnsavedChanges()).toBe(false);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(context.editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  fireEvent.change(context.editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "More changes" } });
  expect(hasUnsavedChanges()).toBe(true);
  await context.user.click(context.editor.getByRole("button", { name: "取消" }));
  const discard = within(await screen.findByRole("alertdialog"));
  await context.user.click(discard.getByRole("button", { name: "继续编辑" }));
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("More changes");
});

it.each([
  ["same version", () => json({ ...latest, revisionToken: original.revisionToken }), "未发现更新的线路版本"],
  ["missing token", () => json({ ...latest, revisionToken: undefined }), "无法确认最新线路的身份或版本"],
  ["empty token", () => json({ ...latest, revisionToken: " " }), "无法确认最新线路的身份或版本"],
  ["different identity", () => json({ ...latest, id: "someone-elses-line" }), "无法确认最新线路的身份或版本"],
  ["deleted line", () => json({ error: "Deleted" }, 404), "找不到这条线路"],
  ["expired session", () => json({ error: "Expired" }, 401), "暂时无法读取这条线路"],
  ["forbidden", () => json({ error: "Forbidden" }, 403), "暂时无法读取这条线路"],
  ["service failure", () => json({ error: "Server failure" }, 503), "无法读取最新线路"],
  ["network failure", () => Promise.reject(new Error("Network")), "无法读取最新线路"],
] as const)("preserves inputs and the original conflict on %s", async (_label, response, message) => {
  const context = await conflict({ extra: call => call.path.endsWith("/resolve") ? response() : undefined });
  fireEvent.change(context.editor.getByRole("spinbutton", { name: "对外端口" }), { target: { value: "" } });
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  await context.editor.findByText(new RegExp(message));
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("My office line");
  expect((context.editor.getByRole("spinbutton", { name: "对外端口" }) as HTMLInputElement).value).toBe("");
  expect(context.editor.getByText("Record changed", { exact: true })).toBeTruthy();
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(hasUnsavedChanges()).toBe(true);
});

it("does not turn a colliding new identity into an update", async () => {
  const context = setup({ extra: call => call.path.endsWith("/published-routes") && call.method === "POST" ? json({ error: "Existing identity" }, 409) : undefined });
  await context.user.click(await screen.findByRole("button", { name: "配置公开线路" }));
  const editor = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "My new line" } });
  await context.user.click(editor.getByRole("combobox", { name: "服务器转发路径" }));
  await context.user.click(await screen.findByRole("option", { name: "path" }));
  await context.user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await context.user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await editor.findByText("Existing identity", { exact: true });
  expect(editor.queryByRole("button", { name: "读取最新版本并比较" })).toBeNull();
  await context.user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await waitFor(() => expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true));
  expect(context.calls.filter(call => call.method === "PUT" || call.path.endsWith("/resolve"))).toEqual([]);
});

it("ignores an old read after newer typing and never puts resolution extras in the comparison or query cache", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const resolution = { ...latest, privateKey: "DO-NOT-CACHE-PRIVATE-KEY", path: { secret: "DO-NOT-CACHE-PATH" } };
  let reads = 0;
  const context = await conflict({ extra: call => call.path.endsWith("/resolve") ? (++reads === 1 ? pending : json(resolution)) : undefined });
  const name = context.editor.getByRole("textbox", { name: "线路名称" });
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  fireEvent.change(name, { target: { value: "Newer local typing" } });
  await act(async () => finish(json(resolution)));
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect((name as HTMLInputElement).value).toBe("Newer local typing");
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  const review = within(await screen.findByRole("dialog", { name: "比较公开线路修改" }));
  expect(review.queryByText(/DO-NOT-CACHE/)).toBeNull();
  expect(JSON.stringify(context.client.getQueryCache().getAll().map(query => query.state.data))).not.toContain("DO-NOT-CACHE");
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

it.each(["navigation", "suspend", "unmount"] as const)("discards an outstanding comparison after %s", async (change) => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const historyOwner = { current: createWorkspaceHistory({ isDirty: () => false, accept() {}, confirm(proceed) { proceed(); } }) };
  disposers.push(() => historyOwner.current.dispose());
  const context = await conflict({ workspace: historyOwner, extra: call => call.path.endsWith("/resolve") ? pending : undefined });
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  await act(async () => {
    if (change === "navigation") historyOwner.current.navigate("#published-routes?line=elsewhere");
    else if (change === "suspend") historyOwner.current.suspend();
    else context.mounted.unmount();
    finish(json(latest));
  });
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

it("rejects a comparison returned after the authenticated account changes", async () => {
  let generation = 0;
  disposers.push(installSessionTransport({
    beforeRequest: () => {
      const owner = generation;
      const verify = () => { if (owner !== generation) throw new APIError("Session changed", 409); };
      return { beforeSend: verify, waitForResponse: async () => verify() };
    }, failed() {},
  }));
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const context = await conflict({ extra: call => call.path.endsWith("/resolve") ? pending : undefined });
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  await act(async () => { generation++; finish(json(latest)); });
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
});

it("does not reuse an old preview or a double/held gesture after comparison", async () => {
  const context = await conflict();
  const review = await compare(context);
  for (const group of ["线路名称", "转发路径与顺序", "对外地址与端口"])
    await choose(review, context.user, group, "保留当前输入");
  await context.user.dblClick(review.getByRole("button", { name: "使用所选内容继续编辑" }));
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(context.editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  const inspect = context.editor.getByRole("button", { name: "检查公开线路" });
  expect(fireEvent.keyDown(inspect, { key: "Enter", repeat: true })).toBe(false);
  expect(context.calls.filter(call => call.path.endsWith("/preview"))).toHaveLength(1);
  await context.user.click(inspect);
  const save = await context.editor.findByRole("button", { name: "保存公开线路" });
  fireEvent.click(save, { detail: 2 });
  expect(fireEvent.keyDown(save, { key: "Enter", repeat: true })).toBe(false);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  fireEvent.change(context.editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "After review" } });
  fireEvent.click(save);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(context.editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
});


it("revokes a pending comparison when a newer server choice has no endpoint yet", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const context = await conflict({ extra: call => call.path.endsWith("/resolve") ? pending : undefined });
  await context.user.click(context.editor.getByRole("button", { name: "调整公开范围（仅当需要使用路径的一部分）" }));
  await context.user.click(context.editor.getByRole("button", { name: "读取最新版本并比较" }));
  await context.user.click(context.editor.getByRole("combobox", { name: "公开路径第 1 跳服务器" }));
  await context.user.click(await screen.findByRole("option", { name: "Other host" }));
  await waitFor(() => expect(context.editor.getByRole("button", { name: "检查公开线路" }).hasAttribute("disabled")).toBe(true));
  await act(async () => finish(json(latest)));
  expect(screen.queryByRole("dialog", { name: "比较公开线路修改" })).toBeNull();
  expect(context.editor.getByRole("combobox", { name: "公开路径第 1 跳服务器" }).textContent).toBe("Other host");
  expect(context.editor.getByRole("combobox", { name: "公开路径第 1 跳端点" }).textContent).toBe("选择该服务器的端点");
  expect(context.editor.getByRole("button", { name: "读取最新版本并比较" }).hasAttribute("disabled")).toBe(true);
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("My office line");
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(hasUnsavedChanges()).toBe(true);
});


it.each(["success", "TLS refusal"] as const)("rejects a standalone inspection %s after leaving and returning to the same hash, then accepts a fresh check", async (outcome) => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  let inspections = 0;
  const context = setup({ extra: call => {
    if (call.path.endsWith("/preview")) return ++inspections === 1 ? pending : json(original);
  } });
  await context.user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  const inspect = editor.getByRole("button", { name: "检查公开线路" });
  await context.user.click(inspect);
  await waitFor(() => expect(inspections).toBe(1));
  for (const hash of ["#servers", "#published-routes"]) {
    await act(async () => {
      const changed = new Promise<void>(resolve => window.addEventListener("hashchange", () => resolve(), { once: true }));
      location.hash = hash;
      await changed;
    });
  }
  await act(async () => finish(outcome === "success" ? json(original) : json({ error: "public VLESS entries require TLS; unencrypted entries are restricted to explicit private or loopback IPs" }, 422)));
  await waitFor(() => expect(inspect.getAttribute("aria-busy")).not.toBe("true"));
  expect(location.hash).toBe("#published-routes");
  expect(editor.queryByText("路径检查完成", { exact: true })).toBeNull();
  expect(editor.queryByText("公网入口需要启用 TLS", { exact: true })).toBeNull();
  expect(editor.queryByRole("button", { name: "就地修复 TLS" })).toBeNull();
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("Office line");
  await context.user.click(inspect);
  await editor.findByText("路径检查完成", { exact: true });
  expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(false);
  expect(inspections).toBe(2);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(0);
});

async function uncertainCreation(read: (saved: PublishedRoute) => Response | Promise<Response> = saved => json(saved), options: {
  write?: (saved: PublishedRoute) => Response | Promise<Response>;
  successful?: boolean;
  workspace?: { current: WorkspaceHistory | null };
} = {}) {
  let saved!: PublishedRoute;
  let posts = 0;
  const context = setup({ workspace: options.workspace, extra: call => {
    if (call.path === "/api/published-routes" && call.method === "POST") {
      posts++;
      if (posts > 1) return json({ error: "Record changed" }, 409);
      saved = { ...original, ...call.body, revisionToken: "created-revision" } as PublishedRoute;
      return options.write ? options.write(saved) : Promise.reject(new TypeError("Controlled response lost"));
    }
    if (call.path === "/api/published-routes" && call.method === "GET")
      return json(saved ? [original, saved] : [original]);
    if (saved && call.path === `/api/published-routes/${saved.id}/resolve`) return read(saved);
  } });
  await context.user.click(await screen.findByRole("button", { name: "配置公开线路" }));
  const editor = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "New office line" } });
  await context.user.click(editor.getByRole("combobox", { name: "服务器转发路径" }));
  await context.user.click(await screen.findByRole("option", { name: "path" }));
  await context.user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByText("路径检查完成", { exact: true });
  expect(editor.getByText("可以保存线路身份；分配用户和节点应用仍是后续独立步骤。", { exact: true })).toBeTruthy();
  await context.user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  if (!options.successful) await editor.findByText("线路保存结果尚未确认", { exact: true });
  return { ...context, editor, saved: () => saved, posts: () => posts };
}

it("recovers a committed new route after its response was lost without replaying or claiming it was unsaved", async () => {
  const context = await uncertainCreation();
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("New office line");
  expect(context.editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(context.editor.queryByRole("button", { name: "检查公开线路" })).toBeNull();
  expect(context.editor.queryByText("线路未保存，当前身份与已有配置冲突。当前输入已保留。", { exact: true })).toBeNull();
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  const detail = within(await screen.findByRole("dialog", { name: "New office line" }));
  expect(detail.getByText("线路已保存")).toBeTruthy();
  expect(context.posts()).toBe(1);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(0);
});

it("keeps absent creation unknown and only retries the same identity explicitly after reading, then reconciles a late commit", async () => {
  let reads = 0;
  const context = await uncertainCreation(saved => ++reads === 1 ? json({ error: "not found" }, 404) : json(saved));
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  const retry = await context.editor.findByRole("button", { name: "重试保存同一线路" });
  expect(context.editor.getByText(/当前尚未找到此线路，先前请求仍可能完成/)).toBeTruthy();
  expect(context.posts()).toBe(1);
  await context.user.click(retry);
  await context.editor.findByRole("button", { name: "核对保存结果" });
  expect(context.editor.queryByText(/线路未保存/)).toBeNull();
  expect(context.editor.queryByRole("button", { name: "重试保存同一线路" })).toBeNull();
  expect(context.posts()).toBe(2);
  const creates = context.calls.filter(call => call.method === "POST" && call.path === "/api/published-routes");
  expect(creates[1].body).toEqual(creates[0].body);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(0);
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await screen.findByRole("dialog", { name: "New office line" });
  expect(context.posts()).toBe(2);
});

it.each(["different fields", "different hops", "wrong identity", "missing revision", "failed read"])("preserves submitted input without writes when creation recovery has %s", async kind => {
  const context = await uncertainCreation(saved => kind === "failed read" ? json({ error: "Unavailable" }, 503) : json({
    ...saved,
    ...(kind === "different fields" ? { publicHost: "someone-else.example" } : {}),
    ...(kind === "different hops" ? { hops: [{ kind: "managed", endpointId: "entry" }, { kind: "connector", connectorId: "foreign" }, { kind: "managed", endpointId: "exit" }] } : {}),
    ...(kind === "wrong identity" ? { id: "foreign-line" } : {}),
    ...(kind === "missing revision" ? { revisionToken: undefined } : {}),
  }));
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await context.editor.findByText(kind === "failed read"
    ? "暂时无法核对保存结果。已提交的线路内容保留，请稍后重试核对。"
    : kind === "different fields" || kind === "different hops"
      ? "此身份已有不同的线路内容。无法据此确认先前保存结果；当前提交内容已保留，不会覆盖已有线路。"
      : "无法确认返回的线路身份与内容，请重新核对。", { exact: true });
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("New office line");
  expect(context.editor.queryByRole("button", { name: "重试保存同一线路" })).toBeNull();
  if (kind === "different hops") {
    expect(context.editor.getByText("当前保存路径：path，entry → 外部代理 foreign → exit", { exact: true })).toBeTruthy();
  }
  expect(context.posts()).toBe(1);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(0);
});

it("retains the exact uncertain creation through local close and reopen and ignores the departed read", async () => {
  let finish!: (response: Response) => void;
  let reads = 0;
  const held = new Promise<Response>(resolve => { finish = resolve; });
  const context = await uncertainCreation(saved => ++reads === 1 ? held : json(saved));
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await context.user.click(context.editor.getByRole("button", { name: "稍后核对" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置公开线路" })).toBeNull());
  await context.user.click(screen.getByRole("button", { name: "核对保存结果" }));
  const editor = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  await act(async () => finish(json(context.saved())));
  expect(screen.queryByRole("dialog", { name: "New office line" })).toBeNull();
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("New office line");
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await context.user.click(editor.getByRole("button", { name: "核对保存结果" }));
  await screen.findByRole("dialog", { name: "New office line" });
  expect(context.posts()).toBe(1);
});

it("requires explicit confirmation to end a differing creation recovery without changing the saved record", async () => {
  const context = await uncertainCreation(saved => json({ ...saved, name: "Someone else's line" }));
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await context.editor.findByText(/此身份已有不同的线路内容/);
  await context.user.click(context.editor.getByRole("button", { name: "结束本次核对…" }));
  let confirm = within(await screen.findByRole("alertdialog"));
  expect(confirm.getByText(/不会撤销已经提交或保存的线路/)).toBeTruthy();
  await context.user.click(confirm.getByRole("button", { name: "继续核对" }));
  expect((context.editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("New office line");
  await context.user.click(context.editor.getByRole("button", { name: "结束本次核对…" }));
  confirm = within(await screen.findByRole("alertdialog"));
  await context.user.click(confirm.getByRole("button", { name: "结束核对并返回" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置公开线路" })).toBeNull());
  expect(screen.queryByText(/的保存结果尚未确认/)).toBeNull();
  await context.user.click(screen.getByRole("button", { name: "配置公开线路" }));
  const fresh = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  expect((fresh.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("");
  expect(context.posts()).toBe(1);
  expect(context.calls.filter(call => call.method === "PUT" || call.method === "DELETE")).toHaveLength(0);
});

it("accepts a valid matching creation receipt as saved without a recovery write", async () => {
  const context = await uncertainCreation(undefined, { write: saved => json(saved), successful: true });
  const detail = within(await screen.findByRole("dialog", { name: "New office line" }));
  expect(detail.getByText("线路已保存")).toBeTruthy();
  expect(screen.queryByText("线路保存结果尚未确认", { exact: true })).toBeNull();
  expect(context.posts()).toBe(1);
});

it.each(["malformed receipt", "503"])("preserves creation uncertainty after %s and recovers with an exact read", async kind => {
  const context = await uncertainCreation(undefined, { write: saved => kind === "503"
    ? json({ error: "Unavailable" }, 503) : json({ ...saved, id: "wrong-line" }) });
  expect(context.editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await screen.findByRole("dialog", { name: "New office line" });
  expect(context.posts()).toBe(1);
});

it("rejects a recovery response after session generation changes and keeps the submitted copy", async () => {
  let generation = 0;
  disposers.push(installSessionTransport({ beforeRequest() {
    const owner = generation;
    const verify = () => { if (owner !== generation) throw new APIError("Session changed", 409); };
    return { beforeSend: verify, waitForResponse: async () => verify() };
  }, failed() {} }));
  let finish!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { finish = resolve; });
  const context = await uncertainCreation(() => held);
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  await act(async () => { generation++; finish(json(context.saved())); });
  await context.editor.findByText("暂时无法核对保存结果。已提交的线路内容保留，请稍后重试核对。", { exact: true });
  expect(screen.queryByRole("dialog", { name: "New office line" })).toBeNull();
  expect(context.posts()).toBe(1);
});

it("revokes the absent-result retry permission when the workspace view is suspended", async () => {
  const workspace = { current: createWorkspaceHistory({ isDirty: () => false, accept() {}, confirm(proceed) { proceed(); } }) };
  disposers.push(() => workspace.current.dispose());
  const context = await uncertainCreation(() => json({ error: "not found" }, 404), { workspace });
  await context.user.click(context.editor.getByRole("button", { name: "核对保存结果" }));
  const retry = await context.editor.findByRole("button", { name: "重试保存同一线路" });
  await act(async () => workspace.current.suspend());
  fireEvent.click(retry);
  expect(context.posts()).toBe(1);
});

it("retires the save-ready preview during unknown creation, reopen and explicit retry while preserving the submitted route", async () => {
  let reads = 0;
  const context = await uncertainCreation(saved => ++reads === 1 ? json({ error: "not found" }, 404) : json(saved));
  const assertRecovery = (editor: ReturnType<typeof within>) => {
    expect(editor.queryByText("路径检查完成", { exact: true })).toBeNull();
    expect(editor.queryByText("可以保存线路身份；分配用户和节点应用仍是后续独立步骤。", { exact: true })).toBeNull();
    expect(editor.getByText("线路保存结果尚未确认", { exact: true })).toBeTruthy();
    expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("New office line");
    expect((editor.getByRole("textbox", { name: "对外域名或 IP" }) as HTMLInputElement).value).toBe("office.example");
    expect(editor.getByLabelText("公开线路转发路径").textContent).toContain("entry");
    expect(editor.getByRole("button", { name: "核对保存结果" })).toBeTruthy();
  };
  assertRecovery(context.editor);
  await context.user.click(context.editor.getByRole("button", { name: "稍后核对" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置公开线路" })).toBeNull());
  await context.user.click(screen.getByRole("button", { name: "核对保存结果" }));
  const reopened = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  assertRecovery(reopened);
  await context.user.click(reopened.getByRole("button", { name: "核对保存结果" }));
  await context.user.click(await reopened.findByRole("button", { name: "重试保存同一线路" }));
  await reopened.findByRole("button", { name: "核对保存结果" });
  assertRecovery(reopened);
  await context.user.click(reopened.getByRole("button", { name: "核对保存结果" }));
  const detail = within(await screen.findByRole("dialog", { name: "New office line" }));
  expect(detail.getByText("线路已保存", { exact: true })).toBeTruthy();
  expect(context.posts()).toBe(2);
  expect(context.calls.filter(call => call.method === "PUT")).toHaveLength(0);
});

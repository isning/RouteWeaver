// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishedRoutesPage } from "./PublishedRoutes";
import type { Infrastructure } from "./types";
import type { ReactNode } from "react";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const route = {
  id: "line",
  name: "Office line",
  deploymentId: "path",
  endpointIds: ["entry"],
  publicHost: "office.example",
  publicPort: 443,
  status: "draft",
  diagnostics: [],
};
const instance = {
  id: "core",
  hostId: "host",
  name: "Office core",
  adapterId: "routeweaver/managed-xray",
  version: "26.3.27-rw1",
};
const listener = {
  authentication: "principals",
  id: "entry",
  name: "Office entry",
  instanceId: "core",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
};
const inventory = {
  hosts: [{ id: "host", name: "Office host", address: "office.example" }],
  instances: [instance, { ...instance, id: "other", name: "Other core" }],
  endpoints: [listener],
  links: [],
  deployments: [
    {
      id: "path",
      name: "Office path",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "path",
        topologyRevision: "r1",
        programs: [
          { instance, listener, rules: [], resources: [], egress: [] },
        ],
      },
    },
    {
      id: "other-path",
      name: "Other path",
      ir: { programs: [{ instance: { ...instance, id: "other" }, listener }] },
    },
  ],
} as Infrastructure;
const clients: QueryClient[] = [];
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
function mockInventory(
  extra?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const requests: { path: string; method: string; body?: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      requests.push({
        path,
        method: init?.method || "GET",
        body: init?.body && JSON.parse(init.body),
      });
      const response = extra?.(path, init);
      if (response) return response;
      if (path.endsWith("/state"))
        return json({
          users: [{ id: "alice", name: "Alice", enabled: true }],
          services: [],
          routes: [],
          publishedRoutes: [route],
        });
      if (path.endsWith("/published-routes")) return json([route]);
      if (
        path.endsWith("/resolve") ||
        path.endsWith("/published-routes/preview") ||
        path.endsWith("/published-routes/line")
      )
        return json(route);
      if (path.endsWith("/hosts")) return json(inventory.hosts);
      if (path.endsWith("/core-instances")) return json(inventory.instances);
      if (path.endsWith("/managed-endpoints")) return json(inventory.endpoints);
      if (path.endsWith("/server-deployments"))
        return json(inventory.deployments);
      if (path.endsWith("/entries")) return json([]);
      return json([]);
    }),
  );
  return requests;
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#published-routes");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function openEditor(extra?: Parameters<typeof mockInventory>[0]) {
  const requests = mockInventory(extra);
  mount(<PublishedRoutesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  return { requests, user, editor, port: editor.getByRole("spinbutton", { name: "对外端口" }) };
}
// Presentation is tested through the public page and HTTP boundary. The real
// backend refusal and narrow/desktop layout are covered by forwarding-setup.
const tlsRefusal = "public VLESS entries require TLS; unencrypted entries are restricted to explicit private or loopback IPs";
const tlsTitle = "公网入口需要启用 TLS";

it.each(["preview", "save"] as const)("explains the exact public TLS %s refusal without dropping the draft or navigating", async (stage) => {
  const { requests, user, editor, port } = await openEditor((path, init) => {
    if (stage === "preview" && path.endsWith("/preview") ||
      stage === "save" && path.endsWith("/published-routes/line") && init?.method === "PUT")
      return json({ error: tlsRefusal }, 422);
  });
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "Public office line" } });
  fireEvent.change(port, { target: { value: "8443" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  if (stage === "save")
    await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  const title = await editor.findByText(tlsTitle);
  const notice = within(title.closest('[role="alert"]')! as HTMLElement);
  expect(notice.getByText(/此公开线路尚不能保存，当前输入已保留/)).toBeTruthy();
  expect(notice.getByText(/服务器 → 监听端点/)).toBeTruthy();
  expect(notice.getByText(/检查监听更新/)).toBeTruthy();
  expect(notice.getByText(/TLS 证书与安全参数/)).toBeTruthy();
  expect(notice.getByText(/保存路径后重新检查公开线路/)).toBeTruthy();
  const diagnostic = notice.getByText(tlsRefusal, { exact: true });
  const details = diagnostic.closest("details")!;
  expect(details.open).toBe(false);
  await user.click(notice.getByText("技术详情", { exact: true }));
  expect(details.open).toBe(true);
  expect(diagnostic.textContent).toBe(tlsRefusal);
  expect(notice.queryByText("操作未完成")).toBeNull();
  expect(notice.queryAllByRole("link")).toHaveLength(0);
  expect((editor.getByRole("textbox", { name: "线路名称" }) as HTMLInputElement).value).toBe("Public office line");
  expect((editor.getByRole("textbox", { name: "对外域名或 IP" }) as HTMLInputElement).value).toBe("office.example");
  expect((port as HTMLInputElement).value).toBe("8443");
  expect(editor.getByRole("combobox", { name: "服务器转发路径" }).textContent).toBe("Office path");
  expect(editor.getByLabelText("公开线路转发路径").textContent).toBe("Office entry");
  expect(location.hash).toBe("#published-routes");
  const writes = requests.filter(request => request.method !== "GET");
  expect(writes.map(request => request.path)).toEqual(stage === "preview"
    ? ["/api/published-routes/preview"]
    : ["/api/published-routes/preview", "/api/published-routes/line"]);
  if (stage === "preview")
    expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  // Editing still invalidates any prior successful check, including after a
  // save refusal. No recovery message grants permission to save a changed form.
  fireEvent.change(port, { target: { value: "9443" } });
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(editor.queryByText(tlsTitle)).toBeNull();
});

it.each([
  [422, `Different refusal: ${tlsRefusal}`],
  [401, tlsRefusal],
  [403, tlsRefusal],
  [503, tlsRefusal],
  [0, "无法连接服务。请检查网络后重试，当前输入已保留。"],
] as const)("does not relabel unknown, auth or network failures (%s) as TLS recovery", async (status, diagnostic) => {
  const { user, editor, port, requests } = await openEditor(path => {
    if (!path.endsWith("/preview")) return;
    if (!status) return Promise.reject(new TypeError("Network failed"));
    return json({ error: diagnostic }, status);
  });
  fireEvent.change(port, { target: { value: "8443" } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByText("操作未完成", { exact: true });
  expect(editor.getByText(diagnostic, { exact: true }).closest("details")).toBeNull();
  expect(editor.queryByText(tlsTitle)).toBeNull();
  expect(editor.queryByText("技术详情", { exact: true })).toBeNull();
  expect((port as HTMLInputElement).value).toBe("8443");
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(requests.filter(request => request.method !== "GET").map(request => request.path)).toEqual(["/api/published-routes/preview"]);
});


it("removes a previous TLS save refusal after a successful recheck of the same draft", async () => {
  const { user, editor, requests } = await openEditor((path, init) =>
    path.endsWith("/published-routes/line") && init?.method === "PUT"
      ? json({ error: tlsRefusal }, 422)
      : undefined,
  );
  const inspect = editor.getByRole("button", { name: "检查公开线路" });
  await user.click(inspect);
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await editor.findByText(tlsTitle);
  await user.click(inspect);
  await waitFor(() => expect(inspect.getAttribute("aria-busy")).not.toBe("true"));
  await editor.findByText("路径检查完成", { exact: true });
  expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(false);
  expect(editor.queryByText(tlsTitle)).toBeNull();
  expect(editor.queryByText(tlsRefusal, { exact: true })).toBeNull();
  expect(requests.filter(request => request.method === "PUT")).toHaveLength(1);
});

it.each(["address", "path"] as const)("invalidates TLS recovery after a draft %s change", async (field) => {
  const { user, editor, requests } = await openEditor(path =>
    path.endsWith("/preview") ? json({ error: tlsRefusal }, 422) : undefined,
  );
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByText(tlsTitle);
  if (field === "address") {
    fireEvent.change(editor.getByRole("textbox", { name: "对外域名或 IP" }), { target: { value: "updated-office.example" } });
    expect((editor.getByRole("textbox", { name: "对外域名或 IP" }) as HTMLInputElement).value).toBe("updated-office.example");
  } else {
    await user.click(editor.getByRole("combobox", { name: "服务器转发路径" }));
    await user.click(await screen.findByRole("option", { name: "Other path" }));
    expect(editor.getByRole("combobox", { name: "服务器转发路径" }).textContent).toBe("Other path");
  }
  expect(editor.queryByText(tlsTitle)).toBeNull();
  expect(editor.queryByText(tlsRefusal, { exact: true })).toBeNull();
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect(requests.filter(request => request.method !== "GET")).toHaveLength(1);
});

it("does not restore TLS recovery when a pending inspection rejects an older draft", async () => {
  let rejectInspection!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { rejectInspection = resolve; });
  const { user, editor, port, requests } = await openEditor(path =>
    path.endsWith("/preview") ? pending : undefined,
  );
  const inspect = editor.getByRole("button", { name: "检查公开线路" });
  await user.click(inspect);
  await waitFor(() => expect(requests.some(request => request.path.endsWith("/preview"))).toBe(true));
  fireEvent.change(port, { target: { value: "9443" } });
  rejectInspection(json({ error: tlsRefusal }, 422));
  await waitFor(() => expect(inspect.getAttribute("aria-busy")).not.toBe("true"));
  expect(editor.queryByText(tlsTitle)).toBeNull();
  expect(editor.queryByText(tlsRefusal, { exact: true })).toBeNull();
  expect(editor.queryByText("路径检查完成", { exact: true })).toBeNull();
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect((port as HTMLInputElement).value).toBe("9443");
});

it("retains an unknown save failure and the conflict guard after a successful recheck", async () => {
  const conflict = "This saved route was changed elsewhere";
  const { user, editor } = await openEditor((path, init) =>
    path.endsWith("/published-routes/line") && init?.method === "PUT"
      ? json({ error: conflict }, 409)
      : undefined,
  );
  const inspect = editor.getByRole("button", { name: "检查公开线路" });
  await user.click(inspect);
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await editor.findByText(conflict, { exact: true });
  await user.click(inspect);
  await waitFor(() => expect(inspect.getAttribute("aria-busy")).not.toBe("true"));
  await editor.findByText("路径检查完成", { exact: true });
  expect(editor.getByText(conflict, { exact: true }).closest("details")).toBeNull();
  expect(editor.getByText("线路已被其他修改更新。当前输入保留，但不能覆盖新版本。", { exact: true })).toBeTruthy();
  expect(editor.getByRole("button", { name: "保存公开线路" }).hasAttribute("disabled")).toBe(true);
  expect(editor.queryByText(tlsTitle)).toBeNull();
});


it("keeps a delayed unknown inspection failure visible after the draft changes", async () => {
  const diagnostic = "Unexpected upstream validation failure";
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const { user, editor, port, requests } = await openEditor(path =>
    path.endsWith("/preview") ? pending : undefined,
  );
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await waitFor(() => expect(requests.some(request => request.path.endsWith("/preview"))).toBe(true));
  fireEvent.change(port, { target: { value: "9443" } });
  complete(json({ error: diagnostic }, 422));
  await editor.findByText(diagnostic, { exact: true });
  expect(editor.getByText("操作未完成", { exact: true })).toBeTruthy();
  expect(editor.queryByText(tlsTitle)).toBeNull();
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect((port as HTMLInputElement).value).toBe("9443");
});

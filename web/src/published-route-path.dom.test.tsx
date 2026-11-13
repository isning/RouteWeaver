// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { PublishedRoutesPage } from "./PublishedRoutes";

afterEach(() => {
  cleanup();
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("compares saved and confirmed snapshot paths rather than mutable inventory", async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computed(element),
  );
  const route = {
    id: "line",
    name: "英国线路",
    deploymentId: "deployment",
    endpointIds: ["fra", "new"],
    publicHost: "entry.invalid",
    publicPort: 443,
    status: "effective",
    pendingChanges: true,
    diagnostics: [],
    savedPath: {
      hops: [
        { endpointId: "fra", name: "法兰克福", metadataState: "snapshot" },
        { endpointId: "new", name: "英国 B", metadataState: "snapshot" },
      ],
    },
    effective: {
      publicHost: "entry.invalid",
      publicPort: 443,
      endpointIds: ["fra", "old"],
      fingerprint: "synthetic",
      path: {
        hops: [
          { endpointId: "fra", name: "法兰克福", metadataState: "snapshot" },
          { endpointId: "old", name: "英国 A", metadataState: "snapshot" },
        ],
      },
    },
  };
  const data: Record<string, unknown> = {
    "/published-routes": [route],
    "/published-routes/line/resolve": route,
    "/hosts": [],
    "/core-instances": [],
    "/managed-endpoints": [
      {
        id: "old",
        name: "错误库存名称",
        instanceId: "missing",
        connection: { protocol: "vless", host: "ignored.invalid", port: 443 },
      },
    ],
    "/links": [],
    "/server-deployments": [
      {
        id: "deployment",
        name: "服务器路径",
        status: "draft",
        ir: { id: "deployment", programs: [] },
      },
    ],
    "/state": { users: [], routes: [], services: [] },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^.*\/api/, "");
      if (!Object.hasOwn(data, path)) throw new Error(`Unexpected ${path}`);
      return new Response(JSON.stringify(data[path]), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        
          <PublishedRoutesPage />
        
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "英国线路" }));
  const detail = within(
    await screen.findByRole("dialog", { name: "英国线路" }),
  );
  expect(
    (await detail.findByLabelText("已确认路径", { exact: true })).textContent,
  ).toBe("已确认路径法兰克福 → 英国 A");
  expect(detail.getByLabelText("已保存路径", { exact: true }).textContent).toBe(
    "已保存路径法兰克福 → 英国 B",
  );
  expect(detail.queryByText("错误库存名称")).toBeNull();
  client.clear();
});

it("creates a public VLESS entry with its complete real AnyTLS relay path", async () => {
  const instance = { id: "core", hostId: "host", adapterId: "routeweaver/sing-box", version: "1.14.4" };
  const listener = { id: "entry", name: "Entry", instanceId: "core", connection: { protocol: "vless", host: "0.0.0.0", port: 443, uuid: "00000000-0000-4000-8000-000000000001", tls: { enabled: true } } };
  const deployment = { id: "path", name: "AnyTLS path", status: "draft", diagnostics: [], ir: { id: "path", schemaVersion: "1.0", topologyRevision: "r1", programs: [{ instance, listener, rules: [], resources: [], egress: [], defaultAction: { kind: "forward", ref: "exit" }, connectors: [
    { id: "relay", connection: { protocol: "socks", host: "private.example", port: 1080 } },
    { id: "exit", via: "relay", connection: { protocol: "anytls", host: "private-exit.example", port: 443, password: "private-password", tls: { enabled: true } } },
  ] }] } };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const data: Record<string, unknown> = { "/published-routes": [], "/hosts": [{ id: "host", name: "Host", address: "entry.example" }], "/core-instances": [instance], "/managed-endpoints": [listener], "/links": [], "/server-deployments": [deployment], "/state": { users: [], services: [], routes: [] } };
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); calls.push({ path, body });
      return new Response(JSON.stringify({ ...body, revisionToken: "saved", status: "draft", diagnostics: [] }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(data[path] ?? []), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><PublishedRoutesPage /></UIProviders></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "配置公开线路" }));
  const editor = within(await screen.findByRole("dialog", { name: "配置公开线路" }));
  fireEvent.change(editor.getByRole("textbox", { name: "线路名称" }), { target: { value: "My AnyTLS route" } });
  await user.click(editor.getByRole("combobox", { name: "服务器转发路径" }));
  await user.click(await screen.findByRole("option", { name: "AnyTLS path" }));
  expect(editor.getByLabelText("公开线路转发路径").textContent).toBe("Entry → 外部代理 relay → 外部代理 exit");
  expect(document.body.textContent).not.toContain("private-password");
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(calls.filter(call => call.path === "/published-routes")).toHaveLength(1));
  const expected = [{ kind: "managed", endpointId: "entry" }, { kind: "connector", connectorId: "relay" }, { kind: "connector", connectorId: "exit" }];
  expect(calls[0].body.hops).toEqual(expected);
  const saved = calls.find(call => call.path === "/published-routes")?.body;
  expect(saved?.hops).toEqual(expected);
  expect(saved?.endpointIds).toEqual(["entry"]);
  expect(JSON.stringify(calls)).not.toContain("private-password");
  expect(JSON.stringify(calls)).not.toContain("private-exit.example");
  expect(JSON.stringify(calls)).not.toContain("private.example");
  client.clear();
});

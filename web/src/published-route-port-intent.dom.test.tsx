// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

async function openPortEditor(extra?: Parameters<typeof mockInventory>[0]) {
  const requests = mockInventory(extra);
  mount(<PublishedRoutesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "编辑" }));
  const editor = within(await screen.findByRole("dialog", { name: "编辑 Office line" }));
  return { requests, user, editor, port: editor.getByRole("spinbutton", { name: "对外端口" }) };
}
it.each(["", "0", "-1", "65536", "443.5", "443.000000000000000001", "65534.999999999999999999", "1e", "-", "0x1bb", " 443 "])("retains invalid public-route client port %s and blocks preview", async raw => {
  const { requests, user, editor, port } = await openPortEditor();
  fireEvent.change(port, { target: { value: raw } });
  fireEvent.blur(port);
  expect((port as HTMLInputElement).value).toBe(raw);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByText("对外端口须为 1–65535 的整数，且不能留空。");
  expect(requests.filter(r => r.path.endsWith("/preview"))).toHaveLength(0);
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
});
it.each([["1", 1], ["65535", 65535], ["4.43e2", 443], ["443.0", 443]])("previews and saves exact client port %s", async (raw, expected) => {
  const { requests, user, editor, port } = await openPortEditor();
  fireEvent.change(port, { target: { value: raw } });
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await user.click(await editor.findByRole("button", { name: "保存公开线路" }));
  await waitFor(() => expect(requests.find(r => r.method === "PUT" && r.path.endsWith("/published-routes/line"))?.body).toMatchObject({ publicPort: expected }));
  expect(requests.find(r => r.path.endsWith("/preview"))?.body).toMatchObject({ publicPort: expected });
});
it("expires a prior port review on incomplete edit, then preserves that unsaved edit on cancel", async () => {
  const { user, editor, port } = await openPortEditor();
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  fireEvent.change(port, { target: { value: "4e" } });
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  await user.click(editor.getByRole("button", { name: "取消" }));
  const discard = within(await screen.findByRole("alertdialog", { name: "放弃未保存的公开线路修改？" }));
  await user.click(discard.getByRole("button", { name: "继续编辑" }));
  expect((port as HTMLInputElement).value).toBe("4e");
});
it("ignores a late port preview after the port has changed", async () => {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const { user, editor, port, requests } = await openPortEditor(path => path.endsWith("/preview") ? pending : undefined);
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await waitFor(() => expect(requests.some(r => r.path.endsWith("/preview"))).toBe(true));
  fireEvent.change(port, { target: { value: "4e" } });
  complete(json(route));
  await waitFor(() => expect(editor.getByRole("button", { name: "检查公开线路" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(editor.queryByRole("button", { name: "保存公开线路" })).toBeNull();
  expect((port as HTMLInputElement).value).toBe("4e");
});

it("preserves the existing client port when untouched", async () => {
  const { requests, user, editor, port } = await openPortEditor();
  expect((port as HTMLInputElement).value).toBe("443");
  await user.click(editor.getByRole("button", { name: "检查公开线路" }));
  await editor.findByRole("button", { name: "保存公开线路" });
  expect(requests.find(r => r.path.endsWith("/preview"))?.body).toMatchObject({ publicPort: 443 });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlow: (props: any) => (
      <div>
        {props.nodes.map((node: any) => (
          <button key={node.id} onClick={() => props.onNodeClick({}, node)}>
            {node.data.label}
          </button>
        ))}
        <button
          onClick={() =>
            props.onNodesChange(
              props.nodes.map((node: any) => ({
                id: node.id,
                type: "dimensions",
                dimensions: { width: 185, height: 90 },
              })),
            )
          }
        >
          Measure graph nodes
        </button>
        <button
          onClick={() =>
            props.onNodesChange([
              {
                id: "entry-a",
                type: "position",
                position: { x: 330, y: 120 },
                dragging: false,
              },
            ])
          }
        >
          Move graph node
        </button>
        <button
          onClick={() =>
            props.onConnect({
              source: "entry-a",
              target: "entry-b",
              sourceHandle: null,
              targetHandle: null,
            })
          }
        >
          Connect graph nodes
        </button>
        <output aria-label="graph geometry">
          {JSON.stringify(
            props.nodes.map((node: any) => ({
              id: node.id,
              position: node.position,
              measured: node.measured,
            })),
          )}
        </output>
        <output aria-label="graph edges">{JSON.stringify(props.edges)}</output>
      </div>
    ),
  };
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const hosts = [
  { id: "a", name: "FRA", address: "192.0.2.1" },
  { id: "b", name: "UK", address: "192.0.2.2" },
];
const instances = hosts.map((h) => ({
  id: `core-${h.id}`,
  hostId: h.id,
  name: `Core ${h.name}`,
  adapterId: "routeweaver/xray",
  version: "26.3.27",
}));
const endpoints = hosts.map((h) => ({
  id: `entry-${h.id}`,
  instanceId: `core-${h.id}`,
  name: `Listener ${h.name}`,
  connection: {
    host: "0.0.0.0",
    port: 1080,
    protocol: "socks",
    username: "fixture",
    password: "synthetic",
  },
}));
let saved: any;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => original(el));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST" && path.endsWith("/server-deployments")) {
        saved = JSON.parse(init.body);
        return json(saved);
      }
      if (path.endsWith("/hosts")) return json(hosts);
      if (path.endsWith("/core-instances")) return json(instances);
      if (path.endsWith("/managed-endpoints")) return json(endpoints);
      const endpoint = endpoints.find((e) =>
        path.endsWith(`/managed-endpoints/${e.id}/reveal`),
      );
      return json(endpoint || []);
    }),
  );
  saved = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("retains measured geometry and dragging across path updates and view switches, without storing geometry in routing intent", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServerRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "新建转发路径" }))[0],
  );
  await userEvent.type(
    await screen.findByRole("textbox", { name: "转发路径名称" }),
    "Graph route",
  );
  await userEvent.click(screen.getByRole("tab", { name: "图形编辑" }));
  await screen.findByRole("button", { name: /^Listener FRA/ });
  await userEvent.click(
    screen.getByRole("button", { name: "Measure graph nodes" }),
  );
  const geometry = () =>
    JSON.parse(screen.getByLabelText("graph geometry").textContent!);
  expect(geometry()[0].measured).toEqual({ width: 185, height: 90 });
  await userEvent.click(
    screen.getByRole("button", { name: "Move graph node" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "转发路径名称" }), {
    target: { value: "Renamed graph" },
  });
  await userEvent.click(screen.getByRole("button", { name: /^Listener FRA/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Listener FRA/ }).textContent,
    ).toContain("入口"),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Connect graph nodes" }),
  );
  await waitFor(() =>
    expect(
      JSON.parse(screen.getByLabelText("graph edges").textContent!),
    ).toHaveLength(1),
  );
  expect(geometry()[0]).toEqual({
    id: "entry-a",
    position: { x: 330, y: 120 },
    measured: { width: 185, height: 90 },
  });
  await userEvent.click(screen.getByRole("tab", { name: "顺序编辑" }));
  await userEvent.click(screen.getByRole("button", { name: /^配置第 2 跳 / }));
  expect(screen.getByRole("combobox", { name: "第 2 跳端点" })).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "图形编辑" }));
  expect(geometry()[0].measured).toEqual({ width: 185, height: 90 });
  expect(geometry()[0].position).toEqual({ x: 330, y: 120 });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(saved).toBeTruthy());
  expect(saved.ir.programs.map((p: any) => p.listener.id)).toEqual([
    "entry-a",
    "entry-b",
  ]);
  expect(saved.ir.programs[0]).not.toHaveProperty("position");
});

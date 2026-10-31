// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import { DiagnosticStartForm, DiagnosticResult } from "./Diagnostics";
import type { ReactNode } from "react";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(v: ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <UIProviders>{v}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (e) => original(e);
});
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("selects only an observed managed path and queues its route identity without sending native connectors", async () => {
  const bodies: any[] = [];
  const target = {
    id: "t1",
    name: "Authorized target",
    nodeId: "host",
    url: "https://example.com/probe",
    methods: ["connectivity"] as const,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/diagnostic-paths"))
        return json([
          {
            publishedRouteId: "route1",
            name: "Three-hop route",
            instanceId: "core1",
            nodeId: "host",
            managedPath: {
              routeId: "route1",
              hops: [
                { endpointId: "entry" },
                { endpointId: "transit" },
                { endpointId: "exit" },
              ],
            },
          },
        ]);
      bodies.push(JSON.parse(init.body));
      return json({ error: "path_changed; refresh the applied path" }, 422);
    }),
  );
  mount(
    <DiagnosticStartForm
      targets={[{ ...target, methods: ["connectivity"] }]}
      instances={[
        {
          id: "core1",
          name: "Entry core",
          hostId: "host",
          adapterId: "routeweaver/managed-xray",
          version: "26.3.27-rw1",
        },
      ]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const user = userEvent.setup();
  for (const [label, option] of [
    ["测试路径方式", "已应用线路的中转与出口"],
    ["已应用线路", "Three-hop route · 3 跳"],
    ["授权目标", "Authorized target"],
    ["测试方式", "连通性"],
  ]) {
    fireEvent.click(screen.getByLabelText(label));
    await user.click(
      await screen.findByText(option, {
        selector: "[cmdk-item] span",
      }),
    );
  }
  expect(screen.getByText(/不测试公开入口 TLS 或客户端接入认证/)).toBeTruthy();
  await user.click(
    screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"),
  );
  await user.click(screen.getByRole("button", { name: "提交测试" }));
  await screen.findByText("path_changed; refresh the applied path");
  expect(bodies[0]).toMatchObject({
    pathMode: "managed_route",
    publishedRouteId: "route1",
    instanceId: "core1",
    targetId: "t1",
    maxBytes: 0,
  });
  expect(bodies[0].managedPath).toBeUndefined();
  expect(bodies[0].connectorId).toBeUndefined();
});

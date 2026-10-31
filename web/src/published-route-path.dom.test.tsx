// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

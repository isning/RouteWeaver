// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishedRoutesPage } from "./PublishedRoutes";
import { ServerRoutesPage } from "./ServerRoutes";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import {
  createWorkspaceHistory,
  type WorkspaceHistory,
} from "./workspace-history";
const route = {
  id: "line",
  name: "Office line",
  deploymentId: "path",
  endpointIds: [],
  publicHost: "office.example",
  publicPort: 443,
  status: "draft",
  diagnostics: [],
};
const path = {
  id: "path",
  name: "Office path",
  status: "draft",
  diagnostics: [],
  ir: {
    schemaVersion: "1.0",
    id: "path",
    topologyRevision: "r1",
    programs: [],
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
let controller: WorkspaceHistory | undefined;
let client: QueryClient;
beforeEach(() => {
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
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/published-routes")) return json([route]);
      if (endpoint.endsWith("/resolve")) return json(route);
      if (endpoint.endsWith("/server-deployments")) return json([path]);
      if (endpoint.endsWith("/state"))
        return json({
          users: [{ id: "alice", name: "Alice" }],
          services: [],
          routes: [],
          publishedRoutes: [route],
        });
      if (endpoint.endsWith("/effective-policy"))
        return json({
          status: "active",
          routeIds: [],
          groupIds: [],
          provenance: {},
        });
      return json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  controller?.dispose();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(hash: string, node: React.ReactNode) {
  history.replaceState(null, "", hash);
  controller = createWorkspaceHistory({
    isDirty: () => false,
    confirm: () => {},
    accept: () => {},
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <WorkspaceHistoryContext.Provider value={{ current: controller }}>
      <QueryClientProvider client={client}>
        <UIProviders>{node}</UIProviders>
      </QueryClientProvider>
    </WorkspaceHistoryContext.Provider>,
  );
}
it("opening a public line, choosing its user, and closing keep entry proof without reopening the local drawer", async () => {
  mount("#published-routes", <PublishedRoutesPage />);
  const length = history.length;
  const position = history.state.routeweaverPosition;
  await userEvent.click(
    await screen.findByRole("button", { name: "Office line" }),
  );
  const drawer = await screen.findByRole("dialog", { name: "Office line" });
  expect(location.hash).toBe("#published-routes?line=line");
  expect(history.state.routeweaverPosition).toBe(position);
  await userEvent.click(
    await within(drawer).findByRole("combobox", { name: "线路使用用户" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Alice" }),
  );
  expect(location.hash).toBe("#published-routes?line=line&user=alice");
  expect(screen.getByRole("dialog", { name: "Office line" })).toBe(drawer);
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  expect(location.hash).toBe("#published-routes");
  expect(history.state.routeweaverEntry).toBeTruthy();
  expect(history.state.routeweaverPosition).toBe(position);
  expect(history.length).toBe(length);
});
it("closing a scoped server path keeps its line/user return context and position proof", async () => {
  mount("#routes?deployment=path&line=line&user=alice", <ServerRoutesPage />);
  const position = history.state.routeweaverPosition;
  const drawer = await screen.findByRole("dialog", { name: "Office path" });
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  expect(location.hash).toBe("#routes?line=line&user=alice");
  expect(history.state.routeweaverEntry).toBeTruthy();
  expect(history.state.routeweaverPosition).toBe(position);
});

it.each(["#published-routes", "#published-routes?line=missing"])(
  "does not keep an old line detail after accepted scope %s",
  async (destination) => {
    mount("#published-routes?line=line", <PublishedRoutesPage />);
    await screen.findByRole("dialog", { name: "Office line" });
    await act(async () => controller!.navigate(destination));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Office line" })).toBeNull(),
    );
    expect(location.hash).toBe(destination);
  },
);

it.each([
  [
    "#published-routes?line=line",
    "#published-routes?line=line&user=alice",
    "Office line",
    <PublishedRoutesPage />,
  ],
  [
    "#routes?deployment=path&line=line",
    "#routes?deployment=path&line=line&user=alice",
    "Office path",
    <ServerRoutesPage />,
  ],
] as const)(
  "keeps the same exact target mounted when only return context changes from %s",
  async (origin, destination, name, page) => {
    mount(origin, page);
    const drawer = await screen.findByRole("dialog", { name });
    await act(async () => controller!.navigate(destination));
    expect(screen.getByRole("dialog", { name })).toBe(drawer);
    expect(location.hash).toBe(destination);
  },
);

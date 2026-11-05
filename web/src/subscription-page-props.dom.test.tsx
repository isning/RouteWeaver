// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PageBoundary } from "./PageBoundary";
import { SubscriptionPageLoader } from "./SubscriptionPageLoader";
import { UIProviders } from "./ui-patterns/providers";

type Props = ComponentProps<typeof SubscriptionPageLoader>;
const moduleGate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release, requested: false };
});
vi.mock("./Subscriptions", async (original) => {
  moduleGate.requested = true;
  await moduleGate.promise;
  return original<typeof import("./Subscriptions")>();
});
const clients: QueryClient[] = [];
afterEach(async () => {
  cleanup();
  moduleGate.release();
  await vi.dynamicImportSettled();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
it("settles an active import with the current source continuation and preserves its unsaved draft across view changes", async () => {
  const user = userEvent.setup();
  const oldConsumed = vi.fn(),
    latestConsumed = vi.fn();
  const writes: string[] = [],
    unexpected: string[] = [];
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  history.replaceState(null, "", "#subscriptions?sourceDraft=latest-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^.*\/api/, "");
      if (
        init?.method &&
        init.method !== "GET" &&
        path !== "/me/collections/preview"
      )
        writes.push(path);
      if (
        ![
          "/me/overview",
          "/me/profiles",
          "/me/outputs",
          "/me/sources",
          "/me/collections",
          "/me/resources",
          "/me/platform-entries",
          "/me/collections/preview",
        ].includes(path)
      )
        unexpected.push(path);
      const data =
        path === "/me/overview"
          ? { status: "active", routes: [] }
          : path === "/me/sources"
            ? [
                {
                  id: "latest-source",
                  name: "Latest source",
                  kind: "text",
                  enabled: true,
                  revision: "v1",
                  snapshot: { endpoints: [] },
                },
              ]
            : path === "/me/collections/preview"
              ? { endpoints: [], stages: [] }
              : [];
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const tree = (props: Props) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <PageBoundary>
          <SubscriptionPageLoader {...props} />
        </PageBoundary>
      </UIProviders>
    </QueryClientProvider>
  );
  const old: Props = {
    view: "overview",
    sourceDraft: { token: "old-token", sourceId: "old-source" },
    onSourceDraftConsumed: oldConsumed,
  };
  const latest: Props = {
    view: "outputs",
    sourceDraft: { token: "latest-token", sourceId: "latest-source" },
    onSourceDraftConsumed: latestConsumed,
  };
  const { rerender } = render(tree(old));
  await waitFor(() => expect(moduleGate.requested).toBe(true));
  expect(screen.getByRole("status", { name: "正在打开页面" })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  rerender(tree(latest));
  await act(async () => moduleGate.release());
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  expect(screen.queryByRole("status", { name: "正在打开页面" })).toBeNull();
  expect(latestConsumed).toHaveBeenCalledExactlyOnceWith("latest-token");
  expect(oldConsumed).not.toHaveBeenCalled();
  expect(location.hash).toBe("#subscriptions");
  await user.type(name, "Keep this source draft");
  rerender(tree({ ...latest, view: "profiles" }));
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Keep this source draft");
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});

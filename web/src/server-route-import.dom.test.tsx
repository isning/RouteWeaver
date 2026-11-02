// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";

// Hold only module delivery. The resolved exports and rendered server page are
// the actual production module, not a substitute page or synthetic heading.
const delivery = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
});
vi.mock("./Infrastructure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Infrastructure")>();
  await delivery.ready;
  return actual;
});
beforeAll(async () => {
  // Compilation is not the variable under test; delivery above is controlled.
  await vi.importActual("./Infrastructure");
});
afterEach(() => {
  delivery.release();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "#subscriptions");
});
it("keeps the authenticated servers destination pending until actual module delivery, then requests inventory and shows its heading", async () => {
  history.replaceState(null, "", "#servers");
  const requests: string[] = [],
    unexpected: string[] = [];
  const inventory = new Set([
    "/api/hosts",
    "/api/core-instances",
    "/api/managed-endpoints",
    "/api/links",
    "/api/server-deployments",
  ]);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      requests.push(`${method} ${path}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (method === "GET" && path === "/api/auth/me")
        return json({
          user: { id: "admin", name: "Admin", role: "admin" },
          csrfToken: "synthetic",
        });
      if (method === "GET" && inventory.has(path)) return json([]);
      unexpected.push(`${method} ${path}`);
      return json({ error: "Unexpected pending-route request" }, 503);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <App />
        </UIProviders>
      </QueryClientProvider>,
    );
    await screen.findByText("正在打开页面");
    expect(location.hash).toBe("#servers");
    const nav = screen.getByRole("navigation", { name: "工作空间导航" });
    expect(
      within(nav)
        .getByRole("button", { name: "服务器" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("私人工作空间")).toBeNull();
    expect(requests).toEqual(["GET /api/auth/me"]);
    // Reproduce the original heading wait's failure deterministically while
    // authenticated routing is healthy. Its default deadline is unchanged.
    await expect(
      screen.findByRole("heading", { name: "服务器", level: 1 }),
    ).rejects.toThrow();
    expect(screen.getByText("正在打开页面")).toBeTruthy();
    expect(requests).toEqual(["GET /api/auth/me"]);
    await act(async () => {
      delivery.release();
    });
    expect(
      await screen.findByRole("heading", { name: "服务器", level: 1 }),
    ).toBeTruthy();
    expect(screen.queryByText("正在打开页面")).toBeNull();
    expect(screen.queryByText("私人工作空间")).toBeNull();
    expect(new Set(requests)).toEqual(
      new Set([
        "GET /api/auth/me",
        ...[...inventory].map((path) => `GET ${path}`),
      ]),
    );
    expect(unexpected).toEqual([]);
  } finally {
    delivery.release();
    cleanup();
    client.clear();
  }
});

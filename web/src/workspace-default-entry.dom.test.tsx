// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import Workspace from "./App";
import { setToken, setCSRF } from "./api";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
  setToken("");
  setCSRF("");
});
it.each([
  ["", false, "概览"],
  ["", true, "概览"],
  ["#overview", true, "概览"],
  ["#collections?collection=travel", true, "节点集合"],
  ["#sources", false, "订阅来源"],
])(
  "opens %s after login=%s without replacing an explicit destination",
  async (hash, login, title) => {
    history.replaceState(null, "", "/" + hash);
    setToken("");
    setCSRF("");
    let authenticated = !login;
    const session = {
      user: { id: "u", name: "Test", role: "user" },
      csrfToken: "synthetic",
    };
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const path = String(url);
        if (path.endsWith("/auth/login")) {
          authenticated = true;
          return json(session);
        }
        if (path.endsWith("/auth/me"))
          return authenticated
            ? json(session)
            : json({ error: "authentication required" }, 401);
        if (path.endsWith("/me/overview"))
          return json({
            status: "active",
            user: { id: "u", enabled: true },
            usage: { rawBytes: 0, weightedBytes: 0 },
            routes: [],
          });
        if (path.endsWith("/me/actions"))
          return json({
            asOf: "2026-11-15T08:00:00Z",
            items: [],
            partial: false,
            uncheckedOutputs: [],
            platformRouteIds: [],
            platformRoutesComplete: true,
          });
        if (path.endsWith("/me/insights"))
          return json({ error: "unavailable" }, 503);
        return json([]);
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <Workspace />
        </UIProviders>
      </QueryClientProvider>,
    );
    if (login) {
      fireEvent.change(await screen.findByLabelText("账号"), {
        target: { value: "test" },
      });
      fireEvent.change(screen.getByLabelText("密码"), {
        target: { value: "synthetic-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    }
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
    expect(location.hash).toBe(hash);
  },
);

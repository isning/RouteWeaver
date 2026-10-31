// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Workspace from "./App";
import { emptyProfile } from "./model";
import { setCSRF, setToken } from "./api";

const comparisonText =
  (pattern: RegExp) => (_content: string, element: Element | null) =>
    !!element?.classList.contains("subscription-comparison-state") &&
    pattern.test(element.textContent || "");
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
  setToken("");
  setCSRF("");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps as-of evidence after same-account revalidation but clears it and fences late reads on account replacement", async () => {
  let identity = "A",
    slow = false,
    checks = 0,
    sessionReads = 0;
  const late: (() => void)[] = [];
  const profile = { ...emptyProfile(), id: "shared", name: "Shared profile" };
  const output = {
    id: "device",
    profileId: profile.id,
    name: "Shared device",
    target: profile.target,
    mode: "full",
    status: "published",
    revision: "same-revision",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/auth/me")) {
        sessionReads++;
        return json({
          user: { id: identity, name: `Account ${identity}`, role: "user" },
          csrfToken: `csrf-${identity}`,
        });
      }
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/comparison")) {
        checks++;
        const result = { ...output, draftComparison: { state: "unchanged" } };
        if (slow)
          return new Promise<Response>((resolve) =>
            late.push(() => resolve(json(result))),
          );
        return json(result);
      }
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Workspace />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByText("Account A");
  await userEvent.click(
    await screen.findByRole("button", { name: "管理配置 Shared profile" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: "检查 1 个订阅的更新 · Shared profile",
    }),
  );
  await screen.findByText(comparisonText(/与保存草稿一致.*上次核对/));
  const previous = sessionReads;
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(sessionReads).toBeGreaterThan(previous));
  await screen.findByText("Account A");
  await screen.findByText(comparisonText(/与保存草稿一致.*上次核对/));
  expect(checks).toBe(1);
  slow = true;
  await userEvent.click(
    screen.getByRole("button", { name: "管理配置 Shared profile" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: "检查 1 个订阅的更新 · Shared profile",
    }),
  );
  await waitFor(() => expect(late).toHaveLength(1));
  identity = "B";
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await screen.findByText("Account B");
  await screen.findByText("未检查更新");
  await act(async () => late.forEach((finish) => finish()));
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(screen.getByText("未检查更新")).toBeTruthy();
  expect(checks).toBe(2);
});

// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const session = (id: string) => ({
  user: { id, name: `Account ${id}`, role: "user" },
  csrfToken: `csrf-${id}`,
});
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setToken("");
  setCSRF("");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("associates the visible import label with its own field while the resource editor remains mounted", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/auth/me") ? json(session("A")) : json([]),
    ),
  );
  history.replaceState(null, "", "#resources");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Workspace />
      </UIProviders>
    </QueryClientProvider>,
  );
  // Finish real workspace/lazy-route startup before testing the form label.
  // The label task keeps its original query budgets and user interactions.
  await screen.findByRole("main");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const user = userEvent.setup();
  await user.click(
    (await screen.findAllByRole("button", { name: "导入规则文件" }))[0],
  );
  const dialog = await screen.findByRole("dialog", { name: "导入规则文件" });
  const visibleInput = within(dialog).getByRole("textbox", {
    name: "导入资源名称",
  });
  const label = within(dialog).getByText("导入资源名称", {
    selector: "label",
  }) as HTMLLabelElement;
  // Native label.control resolves the actual DOM association, independent of Testing Library label queries.
  expect.soft(label.control).toBe(visibleInput);
  await user.click(label);
  expect.soft(document.activeElement).toBe(visibleInput);
  await user.keyboard("My rules");
  expect((visibleInput as HTMLInputElement).value).toBe("My rules");
});

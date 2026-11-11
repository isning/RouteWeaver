// @vitest-environment jsdom
// Actual App/provider composition and native form submission. DOM focus evidence
// only: viewport visibility and native keyboard acceptance remain CI work.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
import { setCSRF, setToken } from "./api";

let client: QueryClient;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#resources");
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
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("returns an invalid public-reference submission to the first field requiring correction", async () => {
  const writes: string[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        writes.push(input);
        throw new Error(`Unexpected write: ${input}`);
      }
      if (input === "/api/auth/me")
        return json({
          user: { id: "resource-user", name: "Resource user", role: "user" },
          csrfToken: "resource-csrf",
        });
      if (["/api/me/resources", "/api/me/inbox"].includes(input))
        return json([]);
      throw new Error(`Unexpected read: ${input}`);
    }),
  );
  // Match main.tsx defaults; SessionBoundary supplies the real private client.
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 },
      mutations: { retry: false },
    },
  });
  render(
    <UIProviders>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </UIProviders>,
  );
  await screen.findByRole("main");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "添加公开引用" }));
  const dialog = await screen.findByRole("dialog", {
    name: "添加公开规则引用",
  });
  const name = within(dialog).getByRole("textbox", { name: "资源名称" });
  const url = within(dialog).getByRole("textbox", { name: "规则文件 URL" });
  await user.type(url, "https://example.test/retained.yaml");
  const submit = within(dialog).getByRole("button", { name: "保存公开引用" });
  await user.click(submit);
  await within(dialog).findByText("给规则资源起一个名称");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(writes).toEqual([]);
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect((url as HTMLInputElement).value).toBe(
    "https://example.test/retained.yaml",
  );
  await user.click(submit);
  await waitFor(() => expect(document.activeElement).toBe(name));
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog", {
    name: "放弃未保存的规则资源修改？",
  });
  await user.click(within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "添加公开规则引用" }),
    ).toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "添加公开引用" }));
  const reopened = await screen.findByRole("dialog", {
    name: "添加公开规则引用",
  });
  const nextName = within(reopened).getByRole("textbox", { name: "资源名称" });
  expect(
    (
      within(reopened).getByRole("textbox", {
        name: "规则文件 URL",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  await user.click(
    within(reopened).getByRole("button", { name: "保存公开引用" }),
  );
  await within(reopened).findByText("给规则资源起一个名称");
  await waitFor(() => expect(document.activeElement).toBe(nextName));
  expect(writes).toEqual([]);
});

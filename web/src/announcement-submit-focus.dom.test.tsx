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
  history.replaceState(null, "", "#notifications");
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
it("returns a whitespace-only announcement title submission to its invalid field without losing the body", async () => {
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
          user: { id: "announcement-admin", name: "Admin", role: "admin" },
          csrfToken: "synthetic",
        });
      if (input === "/api/state") return json({ users: [] });
      if (["/api/admin/announcements", "/api/me/inbox"].includes(input))
        return json([]);
      throw new Error(`Unexpected read: ${input}`);
    }),
  );
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
  await user.click(await screen.findByRole("button", { name: "创建公告" }));
  const dialog = await screen.findByRole("dialog", { name: "创建公告" });
  const title = within(dialog).getByRole("textbox", {
    name: "公告标题",
  }) as HTMLInputElement;
  const body = within(dialog).getByRole("textbox", {
    name: "公告正文",
  }) as HTMLTextAreaElement;
  await user.type(title, "   ");
  await user.type(body, "Retained maintenance announcement");
  const submit = within(dialog).getByRole("button", {
    name: "保存并安排发布",
  }) as HTMLButtonElement;
  expect(submit.form).toBe(title.form);
  expect(submit.closest("form")).toBeNull();
  // This is rc custom validation, not a browser-native required/type failure.
  expect(title.form!.checkValidity()).toBe(true);
  await user.click(submit);
  await within(dialog).findByText("请填写标题，不能只包含空白。");
  expect(title.getAttribute("aria-invalid")).toBe("true");
  expect(writes).toEqual([]);
  expect(title.value).toBe("   ");
  expect(body.value).toBe("Retained maintenance announcement");
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.click(submit);
  await waitFor(() => expect(document.activeElement).toBe(title));
  expect(body.value).toBe("Retained maintenance announcement");

  // With both fields invalid, rendered order gives the title first recovery.
  await user.clear(body);
  await user.click(submit);
  await within(dialog).findByText("请填写正文，不能只包含空白。");
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.clear(title);
  await user.type(title, "Retained title");
  await user.click(submit);
  await waitFor(() => expect(document.activeElement).toBe(body));
  expect(title.value).toBe("Retained title");
  expect(body.value).toBe("");
  expect(writes).toEqual([]);

  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的公告修改？",
  });
  await user.click(within(review).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(title.value).toBe("Retained title");
  expect(body.value).toBe("");
  await user.click(submit);
  await waitFor(() => expect(document.activeElement).toBe(body));
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog", {
    name: "放弃未保存的公告修改？",
  });
  await user.click(within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "创建公告" })).toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "创建公告" }));
  const reopened = await screen.findByRole("dialog", { name: "创建公告" });
  const newTitle = within(reopened).getByRole("textbox", {
    name: "公告标题",
  }) as HTMLInputElement;
  expect(newTitle.value).toBe("");
  expect(
    (
      within(reopened).getByRole("textbox", {
        name: "公告正文",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  expect(newTitle.getAttribute("aria-invalid")).toBeNull();
  await user.click(
    within(reopened).getByRole("button", { name: "保存并安排发布" }),
  );
  await waitFor(() => expect(document.activeElement).toBe(newTitle));
  expect(writes).toEqual([]);
});

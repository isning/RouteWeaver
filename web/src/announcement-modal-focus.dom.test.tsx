// @vitest-environment jsdom
// Public announcement task and held HTTP seam; native geometry is browser evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationsAdminPage } from "./Notifications";
const clients: QueryClient[] = [];
const notice = {
  id: "notice-a",
  title: "Maintenance",
  body: "Existing notice",
  audience: "all",
  userIds: [],
  startsAt: "2026-10-27T10:00:00.000Z",
  expiresAt: "2026-10-28T10:00:00.000Z",
  enabled: true,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount() {
  const writes: { url: string; body: any; method: string }[] = [];
  let release: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "PUT" || init?.method === "POST") {
        writes.push({
          url,
          body: JSON.parse(String(init.body)),
          method: init.method,
        });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(
        json(
          url === "/api/admin/announcements"
            ? [notice]
            : url === "/api/admin/state"
              ? { users: [] }
              : [],
        ),
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        
          <NotificationsAdminPage />
        
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, view, release: (response: Response) => release(response) };
}
async function edit() {
  const opener = await screen.findByRole("button", { name: /^编\s*辑$/ });
  await userEvent.click(opener);
  return {
    opener,
    dialog: await screen.findByRole("dialog", { name: "编辑公告" }),
  };
}
it("keeps an externally associated footer submit focusable while busy and preserves values for failure retry", async () => {
  const state = mount();
  const { dialog, opener } = await edit();
  const title = within(dialog).getByRole("textbox", { name: "公告标题" });
  fireEvent.change(title, { target: { value: "Keep maintenance draft" } });
  await userEvent.click(title);
  const submit = within(dialog).getByRole("button", {
    name: "保存并安排发布",
  }) as HTMLButtonElement;
  expect(submit.form).toBe(title.closest("form"));
  expect(submit.closest("[data-task-overlay-body]")).toBeNull();
  expect(within(dialog).getByText(/公告仅在站内向所选受众展示/).closest("[data-task-overlay-body]")).toBeNull();
  // user-event does not discover external submit buttons for implicit Enter.
  // Assert the browser-native association here; actual Enter is browser QA.
  fireEvent.submit(submit.form!);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(submit.getAttribute("aria-busy")).toBe("true");
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(submit);
  expect((title as HTMLInputElement).disabled).toBe(true);
  await userEvent.keyboard("{Enter} ");
  await userEvent.click(submit);
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  expect(screen.getByRole("dialog", { name: "编辑公告" })).toBe(dialog);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toEqual({
    url: "/api/admin/announcements/notice-a",
    method: "PUT",
    body: { ...notice, title: "Keep maintenance draft" },
  });
  await act(async () =>
    state.release(json({ error: "Synthetic unavailable" }, 503)),
  );
  await within(dialog).findByText("Synthetic unavailable");
  expect((title as HTMLInputElement).value).toBe("Keep maintenance draft");
  expect((title as HTMLInputElement).disabled).toBe(false);
  await userEvent.click(submit);
  await waitFor(() => expect(state.writes).toHaveLength(2));
  expect(state.writes[1]).toEqual(state.writes[0]);
  await act(async () =>
    state.release(json({ ...notice, title: "Keep maintenance draft" })),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑公告" })).toBeNull(),
  );
  expect(document.activeElement).toBe(opener);
});
it("keeps the announcement draft through nested discard cancellation and returns to its opener only after discard", async () => {
  const state = mount();
  const { dialog, opener } = await edit();
  const title = within(dialog).getByRole("textbox", { name: "公告标题" });
  fireEvent.change(title, { target: { value: "Unsubmitted draft" } });
  const cancel = within(dialog).getByRole("button", { name: /^取\s*消$/ });
  await userEvent.click(cancel);
  let review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的公告修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "放弃未保存的公告修改？" }),
    ).toBeNull(),
  );
  expect(document.activeElement).toBe(cancel);
  expect((title as HTMLInputElement).value).toBe("Unsubmitted draft");
  await userEvent.click(cancel);
  review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的公告修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "编辑公告" })).toBeNull(),
  );
  expect(document.activeElement).toBe(opener);
  expect(state.writes).toEqual([]);
});
it("does not let a departed announcement save close or focus the replacement editor", async () => {
  const old = mount();
  const first = await edit();
  fireEvent.change(
    within(first.dialog).getByRole("textbox", { name: "公告标题" }),
    { target: { value: "Old captured draft" } },
  );
  await userEvent.click(
    within(first.dialog).getByRole("button", { name: "保存并安排发布" }),
  );
  await waitFor(() => expect(old.writes).toHaveLength(1));
  old.view.unmount();
  const current = mount();
  const second = await edit();
  const title = within(second.dialog).getByRole("textbox", {
    name: "公告标题",
  });
  fireEvent.change(title, { target: { value: "Replacement draft" } });
  await userEvent.click(title);
  await act(async () =>
    old.release(json({ ...notice, title: "Old captured draft" })),
  );
  expect(screen.getByRole("dialog", { name: "编辑公告" })).toBe(second.dialog);
  expect((title as HTMLInputElement).value).toBe("Replacement draft");
  expect(document.activeElement).toBe(title);
  expect(current.writes).toEqual([]);
  expect(screen.queryByText("公告安排已保存")).toBeNull();
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import { hasUnsavedChanges } from "./navigation";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});
function mount() {
  const requests: Record<string, unknown>[] = [];
  const responses: ((response: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/invites" && init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => responses.push(resolve));
      }
      if (url === "/api/state")
        return json({
          users: [],
          nodes: [],
          routes: [],
          capabilities: [],
          revisions: [],
        });
      if (url === "/api/settings")
        return json({
          name: "RouteWeaver",
          timezone: "UTC+8",
          registration: "invite",
        });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="users" />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { requests, responses, view };
}
async function open() {
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "邀请用户" }))[0],
  );
  return screen.getByRole("dialog", { name: "邀请用户" });
}
it("keeps one pending invite bound to its recipient and starts the next invitation cleanly", async () => {
  const state = mount();
  const user = userEvent.setup();
  const dialog = await open();
  fireEvent.change(within(dialog).getByLabelText("受邀人名称"), {
    target: { value: "Alice" },
  });
  await user.click(within(dialog).getByRole("button", { name: "生成邀请" }));
  await waitFor(() => expect(state.requests).toHaveLength(1));
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBe(dialog);
  expect(
    (within(dialog).getByLabelText("受邀人名称") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.submit(dialog.querySelector("form")!);
  await act(async () => {});
  expect(state.requests).toHaveLength(1);
  await act(async () =>
    state.responses[0](
      json({
        url: "https://example.invalid/?invite=alice-token",
        expiresAt: "2026-11-01T00:00:00Z",
      }),
    ),
  );
  await screen.findByLabelText("邀请链接");
  expect(within(dialog).getByText("Alice · 普通用户")).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(false);
  await user.click(within(dialog).getByRole("button", { name: "关闭" }));
  const next = await open();
  expect(within(next).queryByLabelText("邀请链接")).toBeNull();
  expect(
    (within(next).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("");
});

it("retains a rejected invitation draft and requires explicit discard before clearing it", async () => {
  const state = mount();
  const user = userEvent.setup();
  const dialog = await open();
  fireEvent.change(within(dialog).getByLabelText("受邀人名称"), {
    target: { value: "Bob" },
  });
  await user.click(within(dialog).getByRole("combobox", { name: "角色" }));
  await user.click(screen.getByRole("option", { name: "管理员" }));
  await user.click(within(dialog).getByRole("button", { name: "生成邀请" }));
  await waitFor(() => expect(state.requests).toHaveLength(1));
  await act(async () =>
    state.responses[0](json({ error: "邀请未能创建" }, 503)),
  );
  await screen.findByText("邀请未能创建");
  expect(
    (within(dialog).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("Bob");
  expect(
    within(dialog).getByRole("combobox", { name: "角色" }).textContent,
  ).toContain("管理员");
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "继续编辑",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (within(dialog).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("Bob");
  await user.keyboard("{Escape}");
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "放弃修改",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBeNull(),
  );
  expect(hasUnsavedChanges()).toBe(false);
  const next = await open();
  expect(
    (within(next).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("");
  expect(
    within(next).getByRole("combobox", { name: "角色" }).textContent,
  ).toContain("普通用户");
});

it.each([200, 503])(
  "does not deliver an old invitation outcome (%s) into a replacement page task",
  async (status) => {
    const first = mount();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("受邀人名称"), {
      target: { value: "Alice" },
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "生成邀请" }),
    );
    await waitFor(() => expect(first.requests).toHaveLength(1));
    first.view.unmount();
    const second = mount();
    const next = await open();
    fireEvent.change(within(next).getByLabelText("受邀人名称"), {
      target: { value: "Bob" },
    });
    await act(async () =>
      first.responses[0](
        json(
          status === 200
            ? { url: "https://example.invalid/?invite=alice-token" }
            : { error: "Alice request failed" },
          status,
        ),
      ),
    );
    expect(
      (within(next).getByLabelText("受邀人名称") as HTMLInputElement).value,
    ).toBe("Bob");
    expect(within(next).queryByLabelText("邀请链接")).toBeNull();
    expect(within(next).queryByText("Alice request failed")).toBeNull();
    expect(second.requests).toHaveLength(0);
  },
);

it("closes a fully reverted invitation without a discard decision or navigation warning", async () => {
  const state = mount();
  const user = userEvent.setup();
  const dialog = await open();
  const name = within(dialog).getByLabelText("受邀人名称");
  const duration = within(dialog).getByLabelText("有效时长（小时）");
  fireEvent.change(name, { target: { value: "Temporary recipient" } });
  await user.click(within(dialog).getByRole("combobox", { name: "角色" }));
  await user.click(screen.getByRole("option", { name: "管理员" }));
  fireEvent.change(duration, { target: { value: "24" } });
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.change(name, { target: { value: "" } });
  await user.click(within(dialog).getByRole("combobox", { name: "角色" }));
  await user.click(screen.getByRole("option", { name: "普通用户" }));
  // Restoring only two fields must not lose the remaining changed duration.
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.change(duration, { target: { value: "72" } });
  expect(hasUnsavedChanges()).toBe(false);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBeNull(),
  );
  expect(state.requests).toHaveLength(0);
});

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
  expect(within(dialog).getByText("Alice")).toBeTruthy();
  expect(within(dialog).getByText("普通用户")).toBeTruthy();
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

it("returns the invitation to its stable Close control after canceled discard", async () => {
  const state = mount();
  const dialog = await open();
  const name = within(dialog).getByLabelText("受邀人名称");
  fireEvent.change(name, { target: { value: "Retained invite" } });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((name as HTMLInputElement).value).toBe("Retained invite");
  }
  expect(state.requests).toEqual([]);
});


it.each(["-", "1e", "72.00000000000000001", "168.00000000000000001", "0.99999999999999999", "0", "169", " "])(
  "retains invalid invitation expiry %s and blocks submission",
  async (raw) => {
    const state = mount();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("受邀人名称"), { target: { value: "Alice" } });
    const duration = within(dialog).getByLabelText("有效时长（小时）") as HTMLInputElement;
    fireEvent.change(duration, { target: { value: raw } });
    fireEvent.blur(duration);
    fireEvent.submit(dialog.querySelector("form")!);
    await within(dialog).findByText("有效时长为 1–168 整数小时");
    expect(duration.value).toBe(raw);
    expect(state.requests).toEqual([]);
    expect(hasUnsavedChanges()).toBe(true);
  },
);

it.each([["72", 72], ["", undefined], ["1", 1], ["168", 168], ["7.2e1", 72], ["+024.0", 24]] as const)(
  "submits invitation expiry %s without changing its draft spelling",
  async (raw, expected) => {
    const state = mount();
    const dialog = await open();
    const duration = within(dialog).getByLabelText("有效时长（小时）") as HTMLInputElement;
    expect(duration.value).toBe("72");
    expect(within(dialog).getByText("留空使用默认 24 小时。")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("受邀人名称"), { target: { value: "Alice" } });
    fireEvent.change(duration, { target: { value: raw } });
    await userEvent.click(within(dialog).getByRole("button", { name: "生成邀请" }));
    await waitFor(() => expect(state.requests).toHaveLength(1));
    expect(state.requests[0]).toEqual({ name: "Alice", role: "user", ...(expected === undefined ? {} : { expiresInHours: expected }) });
    await act(async () => state.responses[0](json({ error: "Invitation rejected" }, 400)));
    await within(dialog).findByText("Invitation rejected");
    expect(duration.value).toBe(raw);
    expect(hasUnsavedChanges()).toBe(true);
  },
);

it("protects a partial expiry edit even when the other invitation fields are untouched", async () => {
  const state = mount();
  const dialog = await open();
  const duration = within(dialog).getByLabelText("有效时长（小时）") as HTMLInputElement;
  fireEvent.change(duration, { target: { value: "7e" } });
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(duration.value).toBe("7e");
  fireEvent.change(duration, { target: { value: "72" } });
  expect(hasUnsavedChanges()).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBeNull());
  expect(state.requests).toEqual([]);
});


it("retains expiry spinbutton semantics and bounded arrow stepping", async () => {
  const state = mount();
  const dialog = await open();
  const duration = within(dialog).getByRole("spinbutton", { name: "有效时长（小时）" }) as HTMLInputElement;
  expect(duration.getAttribute("aria-valuemin")).toBe("1");
  expect(duration.getAttribute("aria-valuemax")).toBe("168");
  expect(duration.getAttribute("aria-valuenow")).toBe("72");
  fireEvent.keyDown(duration, { key: "ArrowUp" });
  expect(duration.value).toBe("73");
  expect(hasUnsavedChanges()).toBe(true);
  fireEvent.keyDown(duration, { key: "ArrowDown" });
  expect(duration.value).toBe("72");
  expect(hasUnsavedChanges()).toBe(false);
  for (const [raw, key, expected] of [
    ["168", "ArrowUp", "168"],
    ["1", "ArrowDown", "1"],
    ["7.2e1", "ArrowUp", "73"],
    ["", "ArrowUp", "1"],
    ["", "ArrowDown", "1"],
  ]) {
    fireEvent.change(duration, { target: { value: raw } });
    fireEvent.keyDown(duration, { key });
    expect(duration.value).toBe(expected);
    expect(duration.getAttribute("aria-valuenow")).toBe(expected);
  }
  fireEvent.change(within(dialog).getByLabelText("受邀人名称"), { target: { value: "Alice" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "生成邀请" }));
  await waitFor(() => expect(state.requests).toHaveLength(1));
  expect(state.requests[0].expiresInHours).toBe(1);
  fireEvent.keyDown(duration, { key: "ArrowUp" });
  expect(duration.value).toBe("1");
});

it.each(["1e", "72.00000000000000001", "169", "0", " "])(
  "does not coerce invalid expiry %s through arrow stepping",
  async (raw) => {
    const state = mount();
    const dialog = await open();
    const duration = within(dialog).getByRole("spinbutton", { name: "有效时长（小时）" }) as HTMLInputElement;
    fireEvent.change(duration, { target: { value: raw } });
    for (const key of ["ArrowUp", "ArrowDown"]) {
      fireEvent.keyDown(duration, { key });
      expect(duration.value).toBe(raw);
      expect(duration.getAttribute("aria-valuenow")).toBeNull();
      expect(duration.getAttribute("aria-invalid")).toBe("true");
    }
    expect(hasUnsavedChanges()).toBe(true);
    expect(state.requests).toEqual([]);
  },
);

// @vitest-environment jsdom
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { getNavigationWarning } from "./navigation";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  setToken("");
  setCSRF("");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  history.replaceState(null, "", "/#users");
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
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
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      postMessage() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(invite: () => Promise<Response>) {
  const writes: { path: string; body: Record<string, string> }[] = [];
  const me: () => Promise<Response> = async () =>
    json({
      user: { id: "admin", name: "Admin", role: "admin" },
      csrfToken: "fixture",
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST") {
        writes.push({ path, body: {} }); // Omit secret-bearing bodies from diagnostics.
        if (path.endsWith("/invites")) return invite();
        throw new Error(`Unexpected write: ${path}`);
      }
      if (path.endsWith("/auth/me")) return me();
      if (path.endsWith("/state"))
        return json({
          users: [],
          nodes: [],
          routes: [],
          capabilities: [],
          revisions: [],
        });
      if (path.endsWith("/settings"))
        return json({ name: "RouteWeaver", registration: "invite" });
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
        <App />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes };
}
async function submit(name = "Alice") {
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "邀请用户" }))[0],
  );
  const dialog = screen.getByRole("dialog", { name: "邀请用户" });
  fireEvent.change(within(dialog).getByLabelText("受邀人名称"), {
    target: { value: name },
  });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "生成邀请" }),
  );
  return dialog;
}
it("does not confirm an invitation or invent its link from an empty success receipt in the actual workspace", async () => {
  const { writes } = mount(async () => json(null, 201));
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() =>
    expect(within(dialog).queryByText("邀请已创建")).toBeNull(),
  );
  expect(within(dialog).queryByLabelText("邀请链接")).toBeNull();
  expect(
    (within(dialog).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("Alice");
});
it("does not describe a dispatched invitation as unsubmitted after its response is lost", async () => {
  const { writes } = mount(async () => {
    throw new TypeError("response lost after persistence");
  });
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  expect(writes).toHaveLength(1);
  expect(
    (within(dialog).getByLabelText("受邀人名称") as HTMLInputElement).value,
  ).toBe("Alice");
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog");
  expect(
    within(discard).queryByText("当前受邀人、角色与有效时长尚未提交。"),
  ).toBeNull();
});

const receipt = (name = "Alice") => ({
  id: "iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
  token: "ttttttttttttttttttttttttttttttttttttttttttt",
  name,
  role: "user",
  expiresAt: "2027-01-01T00:00:00Z",
});
it.each([
  ["missing token", { ...receipt(), token: undefined }],
  ["wrong recipient", { ...receipt(), name: "Bob" }],
  ["wrong role", { ...receipt(), role: "admin" }],
  ["invalid expiry", { ...receipt(), expiresAt: "not-a-date" }],
  ["URL-only receipt", { url: "javascript:alert(1)" }],
])("keeps %s uncertain without exposing a link", async (_name, body) => {
  const { writes } = mount(async () => json(body, 201));
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  expect(within(dialog).queryByLabelText("邀请链接")).toBeNull();
  expect(within(dialog).getByLabelText("受邀人名称")).toHaveProperty(
    "disabled",
    true,
  );
  expect(within(dialog).getByLabelText("有效时长（小时）")).toHaveProperty(
    "value",
    "72",
  );
  expect(getNavigationWarning()).toContain("离开不会撤销邀请");
  fireEvent.submit(dialog.querySelector("form")!);
  expect(writes).toHaveLength(1);
});
it("shows only a validated server receipt and starts a clean task after close", async () => {
  mount(async () => json(receipt(), 201));
  const dialog = await submit();
  await within(dialog).findByText("邀请已创建");
  // Assert boolean, not the secret-bearing value, to keep failure diagnostics clean.
  expect(
    (within(dialog).getByLabelText("邀请链接") as HTMLInputElement).value ===
      `${location.origin}/?invite=ttttttttttttttttttttttttttttttttttttttttttt`,
  ).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "邀请用户" }))[0],
  );
  const next = screen.getByRole("dialog", { name: "邀请用户" });
  expect(within(next).getByLabelText("受邀人名称")).toHaveProperty("value", "");
  expect(within(next).queryByLabelText("邀请链接")).toBeNull();
});
it("preserves correction after definite rejection without an unknown warning", async () => {
  const { writes } = mount(async () =>
    json({ error: "invite expiry must be 1–168 hours" }, 400),
  );
  const dialog = await submit();
  await within(dialog).findByText("invite expiry must be 1–168 hours");
  expect(within(dialog).queryByText("邀请创建结果尚未确认")).toBeNull();
  const name = within(dialog).getByLabelText("受邀人名称");
  expect(name).toHaveProperty("disabled", false);
  fireEvent.change(name, { target: { value: "Corrected recipient" } });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "生成邀请" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
});
it("requires a distinct decision before preparing another invitation after uncertainty", async () => {
  const { writes } = mount(async () => {
    throw new TypeError("lost response");
  });
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "准备另一份邀请" }),
  );
  let decision = await screen.findByRole("alertdialog");
  expect(within(decision).getByText(/不会撤销上一次邀请/)).toBeTruthy();
  await userEvent.click(
    within(decision).getByRole("button", { name: "保留当前结果" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(writes).toHaveLength(1);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "准备另一份邀请" }),
  );
  decision = await screen.findByRole("alertdialog");
  await userEvent.click(
    within(decision).getByRole("button", { name: "准备另一份邀请" }),
  );
  await within(dialog).findByRole("button", { name: "生成邀请" });
  expect(writes).toHaveLength(1);
  expect(within(dialog).getByLabelText("受邀人名称")).toHaveProperty(
    "value",
    "Alice",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "生成邀请" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  await within(dialog).findByText("邀请创建结果尚未确认");
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  decision = await screen.findByRole("alertdialog");
  expect(within(decision).getByText(/离开不会撤销邀请/)).toBeTruthy();
  await userEvent.click(
    within(decision).getByRole("button", { name: "离开邀请" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBeNull(),
  );
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "邀请用户" }))[0],
  );
  expect(screen.getByLabelText("受邀人名称")).toHaveProperty("value", "");
  expect(screen.queryByText("邀请创建结果尚未确认")).toBeNull();
  expect(writes).toHaveLength(2);
});

it.each([
  [
    "unencodable token",
    async () => json({ ...receipt(), token: "\uD800" }, 201),
  ],
  ["wrong success status", async () => json(receipt(), 200)],
  ["malformed JSON", async () => new Response("{", { status: 201 })],
  ["missing response body", async () => new Response(null, { status: 201 })],
  [
    "unreadable response",
    async () => {
      const r = json(receipt(), 201);
      r.text = async () => {
        throw new TypeError("body interrupted");
      };
      return r;
    },
  ],
  ["non-string token", async () => json({ ...receipt(), token: 42 }, 201)],
  ["pseudo-date", async () => json({ ...receipt(), expiresAt: "0" }, 201)],
  ["server failure", async () => json({ error: "service unavailable" }, 503)],
])("keeps %s unknown without automatic replay", async (_name, response) => {
  const { writes } = mount(response);
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  expect(within(dialog).queryByLabelText("邀请链接")).toBeNull();
  expect(writes).toHaveLength(1);
});
it("retains the backend's unchanged display name and accepts its offset/nanosecond receipt", async () => {
  mount(async () =>
    json(
      {
        ...receipt(" Alice "),
        expiresAt: "2027-01-01T08:00:00.123456789+08:00",
      },
      201,
    ),
  );
  const dialog = await submit(" Alice ");
  await within(dialog).findByText("邀请已创建");
  expect(within(dialog).getByLabelText("邀请链接")).toBeTruthy();
});
it("does not resend a pending invitation and warns that navigation cannot cancel it", async () => {
  let resolve!: (response: Response) => void;
  const { writes } = mount(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const dialog = await submit();
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.submit(dialog.querySelector("form")!);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "邀请用户" })).toBe(dialog);
  expect(getNavigationWarning()).toContain("离开不会撤销邀请");
  await act(async () => {
    resolve(json(receipt(), 201));
  });
  await within(dialog).findByText("邀请已创建");
  expect(writes).toHaveLength(1);
});

it("shows actual history-departure consequences and retains unknown inputs when staying", async () => {
  const { writes } = mount(async () => {
    throw new TypeError("lost response");
  });
  const dialog = await submit();
  await within(dialog).findByText("邀请创建结果尚未确认");
  await act(async () => {
    location.hash = "#nodes";
  });
  const decision = await screen.findByRole("alertdialog", {
    name: "离开当前页面？",
  });
  expect(within(decision).getByText(/离开不会撤销邀请/)).toBeTruthy();
  await userEvent.click(
    within(decision).getByRole("button", { name: "留在当前页面" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(within(dialog).getByLabelText("受邀人名称")).toHaveProperty(
    "value",
    "Alice",
  );
  expect(writes).toHaveLength(1);
  await act(async () => {
    location.hash = "#nodes";
  });
  const leave = await screen.findByRole("alertdialog", {
    name: "离开当前页面？",
  });
  await userEvent.click(
    within(leave).getByRole("button", { name: "仍然离开" }),
  );
  await screen.findByRole("heading", { name: "连接端点" });
  expect(screen.queryByRole("dialog", { name: "邀请用户" })).toBeNull();
  expect(writes).toHaveLength(1);
});

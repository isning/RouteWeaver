// @vitest-environment jsdom
// Form/HTTP contract; runtime execution belongs to CI in the recovery workspace.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const session = (id: string) => ({
  user: { id, name: `Account ${id}`, role: "user" },
  csrfToken: `csrf-${id}`,
});
const clients: QueryClient[] = [];
beforeEach(() => {
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/?invite=synthetic-invite#collections");
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
  let me: () => Promise<Response> = async () =>
    json({ error: "authentication required" }, 401);
  let login: () => Promise<Response> = async () =>
    json({ error: "invalid credentials" }, 401);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST") {
        writes.push({ path, body: JSON.parse(String(init.body)) });
        if (path.endsWith("/auth/accept-invite")) return invite();
        if (path.endsWith("/auth/login")) return login();
        throw new Error(`Unexpected write: ${path}`);
      }
      if (path.endsWith("/auth/me")) return me();
      if (path.endsWith("/state")) return json({ error: "invalid token" }, 401);
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
  return {
    writes,
    setMe: (read: typeof me) => {
      me = read;
    },
    setLogin: (write: typeof login) => {
      login = write;
    },
  };
}
async function fill(
  username = "invited.user",
  password = "synthetic-password",
) {
  fireEvent.change(await screen.findByLabelText("账号"), {
    target: { value: username },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: password },
  });
}
async function create() {
  await userEvent.click(screen.getByRole("button", { name: "创建账号并继续" }));
}
const usernameError =
  "账号须为 3–128 位，以英文字母或数字开头，仅使用英文字母、数字和 _ . @ + -。";

it("explains requirements at the fields and preserves an invalid invitation until explicitly corrected", async () => {
  const flow = mount(async () => {
    flow.setMe(async () => json(session("created")));
    return json(session("created"));
  });
  await fill("中文账号");
  for (const label of ["账号", "密码"]) {
    const field = screen.getByLabelText(label);
    const descriptions = field
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(descriptions).toContain(label === "账号" ? "3–128" : "12–72");
  }
  await create();
  await screen.findByText(usernameError);
  expect(flow.writes).toEqual([]);
  expect((screen.getByLabelText("邀请码") as HTMLInputElement).value).toBe(
    "synthetic-invite",
  );
  expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe(
    "中文账号",
  );
  expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe(
    "synthetic-password",
  );
  fireEvent.change(screen.getByLabelText("账号"), {
    target: { value: "Valid.User" },
  });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  expect(flow.writes).toEqual([]);
  await create();
  await screen.findByRole("navigation", { name: "工作空间导航" });
  expect(flow.writes).toEqual([
    {
      path: "/api/auth/accept-invite",
      body: {
        token: "synthetic-invite",
        username: "Valid.User",
        password: "synthetic-password",
      },
    },
  ]);
});

it.each([
  ["two characters", "ab"],
  ["129 characters", "a".repeat(129)],
  ["leading punctuation", "_abc"],
  ["embedded space", "ab cd"],
  ["BOM is not Go whitespace", "\uFEFFabc"],
])("rejects %s without sending signup", async (_name, username) => {
  const { writes } = mount(async () => json({ error: "must not send" }, 400));
  await fill(username);
  await create();
  await screen.findByText(usernameError);
  expect(writes).toEqual([]);
});

it.each([
  ["three characters", "Ab1"],
  ["128 characters", "a".repeat(128)],
  ["all allowed punctuation", "a_.@+-"],
  ["Go whitespace and case folding", "\u0085 İK.User \u0085"],
])(
  "accepts %s while leaving normalization to the server",
  async (_name, username) => {
    const { writes } = mount(async () =>
      json({ error: "invite invalid or expired" }, 400),
    );
    await fill(username);
    await create();
    await screen.findByText("邀请码无效、已使用或已过期。若已完成注册，请返回账号登录；否则请向邀请人获取新邀请。");
    expect(writes).toHaveLength(1);
    expect(writes[0].body.username).toBe(username);
  },
);

it.each([
  ["short ASCII", "a".repeat(11), "密码太短：当前 11 字节，至少需要 12 字节。"],
  ["overlong ASCII", "a".repeat(73), "密码太长：当前 73 字节，最多允许 72 字节。"],
  ["short multibyte", "界界界", "密码太短：当前 9 字节，至少需要 12 字节。"],
  ["overlong multibyte", "界".repeat(24) + "a", "密码太长：当前 73 字节，最多允许 72 字节。"],
])(
  "rejects %s password without consuming the invitation or retrying",
  async (_name, password, passwordError) => {
    const { writes } = mount(async () => json({ error: "must not send" }, 400));
    await fill("invited.user", password);
    await create();
    await screen.findByText(passwordError);
    expect(writes).toEqual([]);
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe(
      password,
    );
    expect((screen.getByLabelText("邀请码") as HTMLInputElement).value).toBe(
      "synthetic-invite",
    );
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(writes).toEqual([]);
    expect(screen.queryByText("账号创建结果尚未确认")).toBeNull();
  },
);

it.each([
  ["12 ASCII bytes", "a".repeat(12)],
  ["72 ASCII bytes", "a".repeat(72)],
  ["12 multibyte bytes", "界界界界"],
  ["72 multibyte bytes", "界".repeat(24)],
  ["12 emoji bytes", "😀😀😀"],
  ["untrimmed spaces", "            "],
])(
  "submits %s password unchanged and retains it after rejection",
  async (_name, password) => {
    const { writes } = mount(async () =>
      json({ error: "invite invalid or expired" }, 400),
    );
    await fill("invited.user", password);
    await create();
    await screen.findByText("邀请码无效、已使用或已过期。若已完成注册，请返回账号登录；否则请向邀请人获取新邀请。");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({
      token: "synthetic-invite",
      username: "invited.user",
      password,
    });
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe(
      password,
    );
  },
);

it("does not impose creation rules on ordinary login or administrator tokens", async () => {
  const { writes } = mount(async () => json({ error: "must not create" }, 400));
  await screen.findByLabelText("账号");
  await userEvent.click(screen.getByRole("button", { name: "返回账号登录" }));
  await fill("中文账号", "short");
  expect(screen.queryByText(/使用 12–72/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByText(/登录未通过，请核对账号和密码/);
  expect(writes).toEqual([
    {
      path: "/api/auth/login",
      body: { username: "中文账号", password: "short" },
    },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "管理员令牌登录" }));
  fireEvent.change(screen.getByLabelText("管理员令牌"), {
    target: { value: "tiny" },
  });
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "进入工作空间" })
        .getAttribute("aria-busy"),
    ).not.toBe("true"),
  );
  expect(screen.queryByText(/密码太短：|密码太长：/)).toBeNull();
  expect(writes).toHaveLength(1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/auth/me") &&
          new Headers(init?.headers).get("Authorization") === "Bearer tiny",
      ),
  ).toBe(true);
});

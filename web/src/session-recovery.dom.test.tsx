// @vitest-environment jsdom
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
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
it("reconciles the account selected by a later session check after form login", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let identity: string | null = null;
  let reads = 0;
  const notifications: unknown[] = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      postMessage(value: unknown) {
        notifications.push(value);
      }
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) {
        identity = "A";
        return json(session("A"));
      }
      if (url.endsWith("/auth/me")) {
        reads++;
        return identity
          ? json(session(identity))
          : json({ error: "authentication required" }, 401);
      }
      return json([]);
    }),
  );
  location.hash = "#collections";
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        
          <Workspace />
        
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText("账号"), {
    target: { value: "a.test" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByText("Account A");
  expect(notifications).toEqual(["session-changed"]);
  identity = "B";
  const prior = reads;
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(reads).toBeGreaterThan(prior));
  await screen.findByText("Account B");
  expect(screen.queryByText("Account A")).toBeNull();
});

it("retains a concealed draft after expiry and retries only after same-account login and another Save", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let loggedIn = true;
  let version = 1;
  const writes: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/login")) {
        loggedIn = true;
        version = 2;
        return json({ ...session("A"), csrfToken: "csrf-renewed" });
      }
      if (url.endsWith("/auth/me"))
        return loggedIn
          ? json({
              ...session("A"),
              csrfToken: version === 1 ? "csrf-A" : "csrf-renewed",
            })
          : json({ error: "session invalid or expired" }, 401);
      if (init?.method === "POST") {
        writes.push({
          body: JSON.parse(String(init.body)),
          csrf: new Headers(init.headers).get("X-CSRF-Token"),
        });
        if (writes.length === 1) {
          loggedIn = false;
          return json({ error: "session invalid or expired" }, 401);
        }
        return json(JSON.parse(String(init.body)));
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  fireEvent.change(await screen.findByLabelText("集合名称"), {
    target: { value: "Private A draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存集合" }));
  fireEvent.change(await screen.findByLabelText("账号"), {
    target: { value: "a.test" },
  });
  expect(screen.queryByRole("button", { name: "保存集合" })).toBeNull();
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByRole("button", { name: "保存集合" });
  expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
    "Private A draft",
  );
  expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({ body: writes[0].body, csrf: "csrf-renewed" });
});

it("discards a prior account draft before rendering another account and ignores its late private read", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let identity = "A";
  let complete!: (response: Response) => void;
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json(session(identity));
      if (init?.method === "POST") {
        writes.push(init.body);
        return json({});
      }
      if (url.endsWith("/me/collections") && identity === "A")
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      if (url.endsWith("/me/collections"))
        return json([
          { id: "b", name: "Private B collection", sources: [], steps: [] },
        ]);
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(await screen.findByRole("button", { name: "新建集合" }));
  fireEvent.change(await screen.findByLabelText("集合名称"), {
    target: { value: "Private A unsaved" },
  });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  identity = "B";
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await screen.findByText("Account B");
  expect(screen.queryByDisplayValue("Private A unsaved")).toBeNull();
  await screen.findByText("Private B collection");
  complete(
    json([
      { id: "a", name: "Late private A collection", sources: [], steps: [] },
    ]),
  );
  await waitFor(() =>
    expect(screen.queryByText("Late private A collection")).toBeNull(),
  );
  expect(writes).toHaveLength(0);
});

it("keeps an ordinary permission error and the draft when the account is still valid", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json(session("A"));
      if (init?.method === "POST") {
        writes++;
        return json({ error: "resource owner mismatch" }, 403);
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  fireEvent.change(await screen.findByLabelText("集合名称"), {
    target: { value: "Retained permission draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await screen.findByText("resource owner mismatch");
  await screen.findByRole("button", { name: "保存集合" });
  expect(screen.queryByLabelText("账号")).toBeNull();
  expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
    "Retained permission draft",
  );
  expect(writes).toBe(1);
});

it("allows the explicit legacy token bootstrap but not a general private read before authentication", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let stateReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json({ error: "not found" }, 404);
      if (url.endsWith("/state")) {
        stateReads++;
        return new Headers(init?.headers).get("Authorization") ===
          "Bearer synthetic-local-test-token"
          ? json({ users: [] })
          : json({ error: "not authorized" }, 401);
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(
    await screen.findByRole("button", { name: "管理员令牌登录" }),
  );
  const { request } = await import("./api");
  await expect(request("/state")).rejects.toMatchObject({ status: 401 });
  expect(stateReads).toBe(0);
  fireEvent.change(screen.getByLabelText("管理员令牌"), {
    target: { value: "synthetic-local-test-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await waitFor(() => expect(stateReads).toBe(1));
  await screen.findByRole("button", { name: /管理员/ });
});

it("reconciles a token-free cross-tab session notification without rebroadcasting it", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let channel: EventTarget | undefined;
  const messages: unknown[] = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      constructor() {
        super();
        channel = this;
      }
      postMessage(value: unknown) {
        messages.push(value);
      }
      close() {}
    },
  );
  let identity = "A";
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/auth/me")
        ? identity === "A"
          ? json(session(identity))
          : new Promise<Response>((resolve) => {
              complete = resolve;
            })
        : json([]),
    ),
  );
  history.replaceState(null, "", "#collections");
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
  await screen.findByText("Account A");
  expect(channel).toBeDefined();
  identity = "B";
  act(() => {
    channel!.dispatchEvent(
      new MessageEvent("message", { data: "session-changed" }),
    );
  });
  expect(
    screen.getByText("Account A").closest("[hidden][inert]"),
  ).not.toBeNull();
  await act(async () => {
    complete(json(session("B")));
  });
  await screen.findByText("Account B");
  expect(messages).toEqual([]);
});

it("does not queue an offline Save to replay when connectivity returns", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return json(session("A"));
      if (init?.method === "POST") {
        writes++;
        return json(JSON.parse(String(init.body)));
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  fireEvent.change(await screen.findByLabelText("集合名称"), {
    target: { value: "Offline draft" },
  });
  const save = screen.getByRole("button", { name: "保存集合" });
  fireEvent(window, new Event("offline"));
  // A click already targeting the editor must fail, not create a paused write.
  fireEvent.click(save);
  fireEvent(window, new Event("online"));
  await screen.findByRole("button", { name: "保存集合" });
  await waitFor(() => expect(save.className).not.toContain("loading"));
  expect(writes).toBe(0);
});

it("conceals portal dialogs on expiry and preserves the source draft after same-account renewal in StrictMode", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let loggedIn = true;
  let renewed = false;
  let sourceReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me"))
        return loggedIn
          ? json({
              ...session("A"),
              csrfToken: renewed ? "renewed" : "original",
            })
          : json({ error: "session invalid or expired" }, 401);
      if (url.endsWith("/auth/login")) {
        loggedIn = true;
        renewed = true;
        return json({ ...session("A"), csrfToken: "renewed" });
      }
      if (url.endsWith("/me/sources")) sourceReads++;
      return json([]);
    }),
  );
  history.replaceState(null, "", "#sources");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>
    </StrictMode>,
  );
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "添加来源" }))[0],
  );
  const editor = await screen.findByRole("dialog", { name: "添加订阅来源" });
  fireEvent.change(within(editor).getByLabelText("来源名称"), {
    target: { value: "Source draft kept only for A" },
  });
  const readsBeforeRenewal = sourceReads;
  loggedIn = false;
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: "进入工作空间" });
  fireEvent.change(await screen.findByLabelText("账号"), {
    target: { value: "a.test" },
  });
  expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull();
  expect(
    screen.getByLabelText("来源名称").closest("[hidden][inert]"),
  ).not.toBeNull();
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "synthetic-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  const restored = await screen.findByRole("dialog", { name: "添加订阅来源" });
  expect(
    (within(restored).getByLabelText("来源名称") as HTMLInputElement).value,
  ).toBe("Source draft kept only for A");
  await waitFor(() => expect(sourceReads).toBeGreaterThan(readsBeforeRenewal));
});

it("rejects a private response after its workspace has unmounted", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me")) return json(session("A"));
      if (url.endsWith("/me/late-read"))
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        
          <Workspace />
        
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByText("Account A");
  const { request } = await import("./api");
  const result = request("/me/late-read");
  rendered.unmount();
  complete(json({ private: "A" }));
  await expect(result).rejects.toMatchObject({ status: 409 });
});

it("keeps the labelled workspace visible but read-only during routine focus verification, then restores input focus", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let hold = false;
  let complete!: (response: Response) => void;
  let writes = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me"))
        return hold
          ? new Promise<Response>((resolve) => {
              complete = resolve;
            })
          : json(session("A"));
      if (init?.method === "POST") writes++;
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(await screen.findByRole("button", { name: "新建集合" }));
  const name = screen.getByLabelText("集合名称") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Keep my place" } });
  name.focus();
  name.setSelectionRange(2, 5);
  hold = true;
  fireEvent(window, new Event("focus"));
  expect(screen.getByLabelText("集合名称")).toBe(name);
  expect(name.closest("[hidden]")).toBeNull();
  expect(name.closest("[inert]")).not.toBeNull();
  expect(screen.getByText("Account A").closest("[hidden]")).toBeNull();
  // JSDOM does not implement inert focus eviction; mimic the browser's body focus.
  name.blur();
  const { request } = await import("./api");
  await expect(
    request("/me/collections", { method: "POST", body: "{}" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(writes).toBe(0);
  await act(async () => {
    complete(json(session("A")));
  });
  await waitFor(() => expect(name.closest("[inert]")).toBeNull());
  expect(document.activeElement).toBe(name);
  expect([name.selectionStart, name.selectionEnd]).toEqual([2, 5]);
});

it("keeps an ordinary forbidden read visible without a session-check/refetch loop", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let sessionReads = 0;
  let collectionReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me")) {
        sessionReads++;
        return json(session("A"));
      }
      if (url.endsWith("/me/collections")) {
        collectionReads++;
        // Cap the faulty cycle so RED cannot flood the runner with requests.
        if (collectionReads > 3) return new Promise<Response>(() => {});
        return json({ error: "collection access denied" }, 403);
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  await screen.findByText("Account A");
  await waitFor(() => expect(sessionReads).toBeGreaterThan(1));
  // Observe a quiet window after the confirmed same-session 403; no user retry occurs.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(collectionReads).toBe(1);
  expect(screen.getByText("collection access denied")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "进入工作空间" })).toBeNull();
});

it.each(["during", "after"])(
  "accepts one already-sent Save resolved %s routine same-session verification",
  async (timing) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let checking = false;
    let verify!: (response: Response) => void;
    let finishSave!: (response: Response) => void;
    let saved: Record<string, unknown> | null = null;
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/me"))
          return checking
            ? new Promise<Response>((resolve) => {
                verify = resolve;
              })
            : json(session("A"));
        if (init?.method === "POST") {
          writes++;
          saved = JSON.parse(String(init.body));
          return new Promise<Response>((resolve) => {
            finishSave = resolve;
          });
        }
        return json(url.endsWith("/me/collections") && saved ? [saved] : []);
      }),
    );
    history.replaceState(null, "", "#collections");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "新建集合" }));
    fireEvent.change(screen.getByLabelText("集合名称"), {
      target: { value: "Slow save once" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存集合" }));
    await waitFor(() => expect(writes).toBe(1));
    checking = true;
    fireEvent(window, new Event("focus"));
    if (timing === "during") {
      await act(async () => {
        finishSave(json(saved));
      });
      expect(screen.queryByText("集合已保存")).toBeNull();
    }
    await act(async () => {
      verify(json(session("A")));
    });
    if (timing === "after")
      await act(async () => {
        finishSave(json(saved));
      });
    await screen.findByText("集合已保存");
    expect(screen.queryByLabelText("集合名称")).toBeNull();
    expect(writes).toBe(1);
  },
);

it.each(["B", "new-csrf", "session-changed", "expired", "unmount"])(
  "releases a held result without accepting it after %s",
  async (change) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let channel!: EventTarget;
    vi.stubGlobal(
      "BroadcastChannel",
      class extends EventTarget {
        constructor() {
          super();
          channel = this;
        }
        postMessage() {}
        close() {}
      },
    );
    let checking = false;
    let verify!: (response: Response) => void;
    let finish!: (response: Response) => void;
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/me"))
          return checking
            ? new Promise<Response>((resolve) => {
                verify = resolve;
              })
            : json(session("A"));
        if (init?.method === "POST") {
          writes++;
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return json([]);
      }),
    );
    history.replaceState(null, "", "#collections");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const rendered = render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    await screen.findByText("Account A");
    const { request } = await import("./api");
    let settled = false;
    const result = request("/me/late-operation", {
      method: "POST",
      body: "{}",
    }).then(
      () => {
        settled = true;
        return { accepted: true, status: 200 };
      },
      (error) => {
        settled = true;
        return { accepted: false, status: error.status };
      },
    );
    checking = true;
    fireEvent(window, new Event("focus"));
    await act(async () => {
      finish(json({ private: "A" }));
    });
    expect(settled).toBe(false);
    if (change === "unmount") rendered.unmount();
    else if (change === "session-changed")
      act(() => {
        channel.dispatchEvent(
          new MessageEvent("message", { data: "session-changed" }),
        );
      });
    else
      await act(async () => {
        verify(
          change === "expired"
            ? json({ error: "expired" }, 401)
            : json(
                change === "B"
                  ? session("B")
                  : { ...session("A"), csrfToken: "new-csrf" },
              ),
        );
      });
    await expect(result).resolves.toEqual({ accepted: false, status: 409 });
    expect(writes).toBe(1);
  },
);

it("shows a delayed routine-check status and a bounded failure with explicit reconnect", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let hold = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me"))
        return hold ? new Promise<Response>(() => {}) : json(session("A"));
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  fireEvent.click(await screen.findByRole("button", { name: "新建集合" }));
  fireEvent.change(screen.getByLabelText("集合名称"), {
    target: { value: "Timeout keeps this draft" },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  hold = true;
  fireEvent(window, new Event("focus"));
  expect(screen.queryByRole("button", { name: "重新确认" })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
  expect(screen.getByRole("button", { name: "重新确认" })).toBeTruthy();
  expect(screen.getByLabelText("集合名称").closest("[hidden]")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14200);
  });
  expect(screen.getByText("确认登录状态超时。请重试。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新连接" })).toBeTruthy();
  vi.useRealTimers();
  hold = false;
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  await screen.findByRole("button", { name: "保存集合" });
  expect((screen.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
    "Timeout keeps this draft",
  );
});

it("clears the workspace and rejects late data when the same account loses its role", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let role = "admin";
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/me"))
        return json({ ...session("A"), user: { ...session("A").user, role } });
      if (url.endsWith("/me/late-read"))
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return json(
        url.endsWith("/me/collections") && role === "admin"
          ? [
              {
                id: "privileged",
                name: "Privileged record",
                sources: [],
                steps: [],
              },
            ]
          : [],
      );
    }),
  );
  history.replaceState(null, "", "#collections");
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
  await screen.findByText("Privileged record");
  fireEvent.click(screen.getByRole("button", { name: "新建集合" }));
  fireEvent.change(screen.getByLabelText("集合名称"), {
    target: { value: "Privileged draft" },
  });
  const { request } = await import("./api");
  const result = request("/me/late-read").then(
    () => "accepted",
    (error) => error.status,
  );
  role = "user";
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  await act(async () => {
    complete(json({ private: "old-role" }));
  });
  await expect(result).resolves.toBe(409);
  expect(screen.queryByLabelText("集合名称")).toBeNull();
  expect(screen.queryByText("Privileged record")).toBeNull();
});

it.each(["A", "B"])(
  "finishes a file prepared under A only when the verified account remains %s",
  async (nextAccount) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let finishFile!: () => void;
    vi.stubGlobal(
      "FileReader",
      class {
        result = "";
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL() {
          finishFile = () => {
            this.result = "data:application/octet-stream;base64,YQ==";
            this.onload?.();
          };
        }
      },
    );
    let identity = "A";
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/me")) return json(session(identity));
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          return json(body.resource);
        }
        return json([]);
      }),
    );
    history.replaceState(null, "", "#resources");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole(
        "button",
        { name: "导入规则文件" },
        { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
      ))[0],
    );
    const dialog = await screen.findByRole("dialog", { name: "导入规则文件" });
    await user.type(within(dialog).getByRole("textbox", { name: "导入资源名称" }), "A file intent");
    await user.upload(
      screen.getByLabelText("选择规则文件"),
      new File(["a"], "rules.yaml", { type: "text/yaml" }),
    );
    await user.click(screen.getByRole("button", { name: "导入并保存文件" }));
    await waitFor(() => expect(finishFile).toBeDefined());
    identity = nextAccount;
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await act(async () => {
      finishFile();
    });
    if (nextAccount === "A") {
      await screen.findByText("规则文件已接纳，发布配置时会一并打包");
      expect(writes).toEqual([
        expect.objectContaining({
          contentBase64: "YQ==",
          resource: expect.objectContaining({ name: "A file intent" }),
        }),
      ]);
    } else {
      await screen.findByText("Account B");
      expect(writes).toEqual([]);
      expect(screen.queryByRole("dialog", { name: "导入规则文件" })).toBeNull();
    }
  },
);

it.each([
  { notified: true, invite: false },
  { notified: false, invite: false },
  { notified: true, invite: true },
  { notified: false, invite: true },
])(
  "does not replace the cookie-authoritative B workspace with a late A login body (%j)",
  async ({ notified, invite }) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let channel!: EventTarget;
    vi.stubGlobal(
      "BroadcastChannel",
      class extends EventTarget {
        constructor() {
          super();
          channel = this;
        }
        postMessage() {}
        close() {}
      },
    );
    let identity: string | null = null;
    let finishBody!: (text: string) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (
          url.endsWith("/auth/login") ||
          url.endsWith("/auth/accept-invite")
        ) {
          identity = "A"; // Cookie/header completion occurs before the body is delivered.
          const response = json(session("A"));
          vi.spyOn(response, "text").mockImplementation(
            () =>
              new Promise((resolve) => {
                finishBody = resolve;
              }),
          );
          return response;
        }
        if (url.endsWith("/auth/me"))
          return identity
            ? json(session(identity))
            : json({ error: "authentication required" }, 401);
        return json([]);
      }),
    );
    history.replaceState(null, "", "#collections");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    await screen.findByLabelText("账号");
    if (invite) {
      fireEvent.click(screen.getByRole("button", { name: "我有邀请码" }));
      fireEvent.change(await screen.findByLabelText("邀请码"), {
        target: { value: "synthetic-invite" },
      });
    }
    fireEvent.change(await screen.findByLabelText("账号"), {
      target: { value: "a.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: invite ? "创建账号并继续" : "进入工作空间",
      }),
    );
    await waitFor(() => expect(finishBody).toBeDefined());
    identity = "B";
    if (notified) {
      await act(async () => {
        channel.dispatchEvent(
          new MessageEvent("message", { data: "session-changed" }),
        );
      });
      await screen.findByText("Account B");
      fireEvent.click(
        (await screen.findAllByRole("button", { name: "新建集合" }))[0],
      );
      fireEvent.change(await screen.findByLabelText("集合名称"), {
        target: { value: "B draft must survive" },
      });
    }
    await act(async () => {
      finishBody(JSON.stringify(session("A")));
    });
    await screen.findByText("Account B");
    expect(screen.queryByText("Account A")).toBeNull();
    if (notified)
      expect(screen.getByLabelText("集合名称")).toHaveProperty(
        "value",
        "B draft must survive",
      );
  },
);

it.each([false, true])(
  "preserves the later cookie-authoritative admin token when an obsolete login fails (old token login: %s)",
  async (oldAdmin) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let channel!: EventTarget;
    vi.stubGlobal(
      "BroadcastChannel",
      class extends EventTarget {
        constructor() {
          super();
          channel = this;
        }
        postMessage() {}
        close() {}
      },
    );
    let identity: string | null = null;
    let finishFailure!: (text: string) => void;
    let oldHeld = false;
    const meTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const authorization =
          new Headers(init?.headers).get("Authorization") || "";
        if (
          url.endsWith("/auth/login") ||
          (oldAdmin &&
            url.endsWith("/auth/me") &&
            authorization === "Bearer obsolete-token" &&
            !oldHeld)
        ) {
          oldHeld = true;
          const response = json({ error: "obsolete failure" }, 401);
          vi.spyOn(response, "text").mockImplementation(
            () =>
              new Promise((resolve) => {
                finishFailure = resolve;
              }),
          );
          return response;
        }
        if (url.endsWith("/auth/me")) {
          meTokens.push(authorization);
          if (authorization === "Bearer current-token")
            return json({
              ...session("operator"),
              user: {
                id: "operator",
                name: "Current administrator",
                role: "admin",
              },
            });
          return identity
            ? json(session(identity))
            : json({ error: "authentication required" }, 401);
        }
        if (url.endsWith("/state"))
          return json({ error: "token not accepted here" }, 401);
        return json([]);
      }),
    );
    history.replaceState(null, "", "#collections");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    await screen.findByLabelText("账号");
    if (oldAdmin) {
      fireEvent.click(screen.getByRole("button", { name: "管理员令牌登录" }));
      fireEvent.change(await screen.findByLabelText("管理员令牌"), {
        target: { value: "obsolete-token" },
      });
    } else {
      fireEvent.change(screen.getByLabelText("账号"), {
        target: { value: "a.test" },
      });
      fireEvent.change(screen.getByLabelText("密码"), {
        target: { value: "synthetic-password" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    await waitFor(() => expect(finishFailure).toBeDefined());
    identity = "B";
    await act(async () => {
      channel.dispatchEvent(
        new MessageEvent("message", { data: "session-changed" }),
      );
    });
    await screen.findByText("Account B");
    identity = null;
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByLabelText("账号");
    fireEvent.click(screen.getByRole("button", { name: "管理员令牌登录" }));
    fireEvent.change(await screen.findByLabelText("管理员令牌"), {
      target: { value: "current-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    await screen.findByText("Current administrator");
    await act(async () => {
      finishFailure(JSON.stringify({ error: "obsolete failure" }));
    });
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByText("Current administrator");
    expect(meTokens.at(-1)).toBe("Bearer current-token");
  },
);

it("reconciles the cleared cookie when logout completes across a changed-session check with late A data", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let channel!: EventTarget;
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      constructor() {
        super();
        channel = this;
      }
      postMessage() {}
      close() {}
    },
  );
  let identity: string | null = "A";
  let holdCheck = false;
  let finishCheck!: (body: string) => void;
  let finishLogout!: (response: Response) => void;
  let logoutWrites = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/logout")) {
        logoutWrites++;
        return new Promise<Response>((resolve) => {
          finishLogout = resolve;
        });
      }
      if (url.endsWith("/auth/me")) {
        if (holdCheck) {
          holdCheck = false;
          const response = json(session("A"));
          vi.spyOn(response, "text").mockImplementation(
            () =>
              new Promise((resolve) => {
                finishCheck = resolve;
              }),
          );
          return response;
        }
        return identity
          ? json(session(identity))
          : json({ error: "authentication required" }, 401);
      }
      // Do not depend on a later unrelated private fetch to discover logout.
      return identity ? json([]) : new Promise<Response>(() => {});
    }),
  );
  history.replaceState(null, "", "#collections");
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
  await userEvent.click(await screen.findByRole("button", { name: /Account A/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() => expect(finishLogout).toBeDefined());
  holdCheck = true;
  await act(async () => {
    channel.dispatchEvent(
      new MessageEvent("message", { data: "session-changed" }),
    );
  });
  await waitFor(() => expect(finishCheck).toBeDefined());
  identity = null;
  await act(async () => {
    finishLogout(json({ ok: true }));
  });
  await act(async () => {
    finishCheck(JSON.stringify(session("A")));
  });
  await screen.findByRole("heading", { name: "登录 RouteWeaver" });
  expect(logoutWrites).toBe(1);
});

it("does not forget B or its draft when the old A logout failure body arrives", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let channel!: EventTarget;
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      constructor() {
        super();
        channel = this;
      }
      postMessage() {}
      close() {}
    },
  );
  let identity = "A";
  let finishLogout!: (body: string) => void;
  let logoutWrites = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/logout")) {
        logoutWrites++;
        const response = json({ error: "old session expired" }, 401);
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise((resolve) => {
              finishLogout = resolve;
            }),
        );
        return response;
      }
      if (url.endsWith("/auth/me")) return json(session(identity));
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
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
  await userEvent.click(await screen.findByRole("button", { name: /Account A/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() => expect(finishLogout).toBeDefined());
  identity = "B";
  await act(async () => {
    channel.dispatchEvent(
      new MessageEvent("message", { data: "session-changed" }),
    );
  });
  await screen.findByText("Account B");
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "新建集合" }))[0],
  );
  fireEvent.change(await screen.findByLabelText("集合名称"), {
    target: { value: "B logout draft" },
  });
  const bURL = location.href;
  await act(async () => {
    finishLogout(JSON.stringify({ error: "old session expired" }));
  });
  await screen.findByText("Account B");
  expect(screen.getByLabelText("集合名称")).toHaveProperty(
    "value",
    "B logout draft",
  );
  expect(logoutWrites).toBe(1);
  expect(location.href).toBe(bURL);
});

it.each([false, true])(
  "clears its own workspace only after authoritative logout confirmation (offline: %s)",
  async (offline) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let identity: string | null = "A";
    let checkingOffline = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/logout")) {
          identity = null;
          checkingOffline = offline;
          return json({ error: "session expired" }, 401);
        }
        if (url.endsWith("/auth/login")) {
          identity = "A";
          return json(session("A"));
        }
        if (url.endsWith("/auth/me") && checkingOffline)
          throw new Error("offline");
        if (url.endsWith("/auth/me"))
          return identity
            ? json(session(identity))
            : json({ error: "authentication required" }, 401);
        return json([]);
      }),
    );
    history.replaceState(null, "", "#sources");
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("搜索来源"), {
      target: { value: "private-filter" },
    });
    history.replaceState(
      { ...history.state, obsoleteContext: "synthetic-private-filter" },
      "",
      location.href,
    );
    await userEvent.click(screen.getByRole("button", { name: /Account A/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    if (offline) {
      await screen.findByText("暂时无法确认登录状态");
      checkingOffline = false;
      identity = "A";
      await act(async () => {
        fireEvent(window, new Event("online"));
      });
      await screen.findByText("Account A");
      expect(await screen.findByLabelText("搜索来源")).toHaveProperty(
        "value",
        "private-filter",
      );
      return;
    }
    await screen.findByRole("heading", { name: "登录 RouteWeaver" });
    await waitFor(() => expect(location.hash).toBe(""));
    expect(Object.keys(history.state).sort()).toEqual(
      ["routeweaverEntry", "routeweaverLineage", "routeweaverPosition"].sort(),
    );
    fireEvent.change(await screen.findByLabelText("账号"), {
      target: { value: "a.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
    await screen.findByText("Account A");
    if (screen.getByRole("button", {name:"订阅素材"}).getAttribute("aria-expanded") !== "true") await userEvent.click(screen.getByRole("button", {name:"订阅素材"}));
    await userEvent.click(await screen.findByRole("button", { name: "订阅来源" }));
    expect(await screen.findByLabelText("搜索来源")).toHaveProperty(
      "value",
      "",
    );
  },
);

it("does not start an ownerless session read for a logout completed after App unmount", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let finishLogout!: (response: Response) => void;
  let meReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/logout"))
        return new Promise<Response>((resolve) => {
          finishLogout = resolve;
        });
      if (url.endsWith("/auth/me")) {
        meReads++;
        return json(session("A"));
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        
          <Workspace />
        
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole("button", { name: /Account A/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() => expect(finishLogout).toBeDefined());
  const readsBeforeUnmount = meReads;
  view.unmount();
  await act(async () => {
    finishLogout(json({ ok: true }));
  });
  expect(meReads).toBe(readsBeforeUnmount);
});

it("does not let a disposed logout authority clear the new App administrator token", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let oldApp = true;
  let oldAuthorized = true;
  let finishBody!: (body: string) => void;
  const meTokens: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const authorization =
        new Headers(init?.headers).get("Authorization") || "";
      if (url.endsWith("/auth/logout")) {
        oldAuthorized = false;
        const response = json({ error: "old logout expired" }, 401);
        vi.spyOn(response, "text").mockImplementation(
          () =>
            new Promise((resolve) => {
              finishBody = resolve;
            }),
        );
        return response;
      }
      if (url.endsWith("/auth/me")) {
        meTokens.push(authorization);
        if (oldApp)
          return oldAuthorized
            ? json(session("A"))
            : json({ error: "authentication required" }, 401);
        if (authorization === "Bearer new-app-token")
          return json({
            ...session("operator"),
            user: {
              id: "operator",
              name: "New App administrator",
              role: "admin",
            },
          });
        return json({ error: "authentication required" }, 401);
      }
      return json([]);
    }),
  );
  history.replaceState(null, "", "#collections");
  const mount = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <UIProviders>
          
            <Workspace />
          
        </UIProviders>
      </QueryClientProvider>,
    );
  const first = mount();
  await userEvent.click(await screen.findByRole("button", { name: /Account A/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() => expect(finishBody).toBeDefined());
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  await screen.findByRole("heading", { name: "登录 RouteWeaver" });
  first.unmount();
  oldApp = false;
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "管理员令牌登录" }),
  );
  fireEvent.change(await screen.findByLabelText("管理员令牌"), {
    target: { value: "new-app-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  await screen.findByText("New App administrator");
  const newURL = location.href;
  await act(async () => {
    finishBody(JSON.stringify({ error: "old logout expired" }));
  });
  await act(async () => {
    fireEvent(window, new Event("focus"));
  });
  expect(meTokens.at(-1)).toBe("Bearer new-app-token");
  expect(location.href).toBe(newURL);
  await screen.findByText("New App administrator");
});

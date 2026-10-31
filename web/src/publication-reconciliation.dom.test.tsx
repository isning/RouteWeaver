// @vitest-environment jsdom
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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
const storageKey = "routeweaver.publication-request.v1";
const envelope = {
  version: 1,
  actorId: "admin-a",
  deploymentId: "path-a",
  operationId: "publication-a",
  request: {
    leaseSeconds: 300,
    accessAllowed: true,
    quotaCertain: true,
    expectedFingerprint: "a".repeat(64),
  },
};
const accepted = {
  operationId: "publication-a",
  deploymentId: "path-a",
  status: "publication-accepted",
  nativeChecked: false,
  instances: [
    {
      instanceId: "instance-a",
      generation: "9007199254740993",
      operationId: "agent-a",
      revisionId: "revision-a",
    },
  ],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setToken("");
  setCSRF("");
  sessionStorage.clear();
  location.hash = "#routes";
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
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computed(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  sessionStorage.clear();
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Workspace />
      </UIProviders>
    </QueryClientProvider>,
  );
}
it("restores a same-actor request without submission and explicitly adopts historical receipt before clearing storage", async () => {
  sessionStorage.setItem(storageKey, JSON.stringify(envelope));
  const requests: { path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ path: url, method: init?.method || "GET" });
      if (url.endsWith("/auth/me"))
        return json({
          user: { id: "admin-a", name: "Administrator A", role: "admin" },
          csrfToken: "synthetic-csrf",
        });
      if (url.endsWith("/publication-requests/publication-a"))
        return json({ request: envelope.request, result: accepted });
      return json([]);
    }),
  );
  const started = performance.now();
  mount();
  let reconcile: HTMLElement;
  try {
    await screen.findByRole(
      "heading",
      { name: "转发路径", level: 1 },
      { timeout: Math.max(1, 5000 - (performance.now() - started) - 100) },
    );
    reconcile = await screen.findByRole("button", { name: "查询提交结果" });
  } catch (error) {
    console.info(
      "publication restore phase",
      JSON.stringify({
        textEncoder: typeof globalThis.TextEncoder,
        hash: location.hash,
        main: document.querySelector("main")?.textContent,
        stored: sessionStorage.getItem(storageKey) !== null,
        paths: requests.map((r) => r.path),
        buttons: [...document.querySelectorAll("button")].map(
          (b) => b.textContent,
        ),
      }),
    );
    throw error;
  }
  expect(
    requests.filter(
      (r) => r.path.includes("publication-requests") || r.method === "POST",
    ),
  ).toHaveLength(0);
  await userEvent.setup().click(reconcile);
  expect(
    await screen.findByText("该次提交已接收", { exact: true }),
  ).toBeTruthy();
  await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
  expect(
    requests.filter((r) => r.path.includes("publication-requests")),
  ).toHaveLength(1);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});

async function restoredApp(
  options: {
    lookup?: unknown;
    lookupStatus?: number;
    logoutFails?: boolean;
  } = {},
) {
  sessionStorage.setItem(storageKey, JSON.stringify(envelope));
  let actor = "admin-a";
  let nextCheck: Promise<void> | undefined;
  const requests: { path: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        path: url,
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/auth/me")) {
        const wait = nextCheck;
        nextCheck = undefined;
        await wait;
        return json({
          user: {
            id: actor,
            name: actor === "admin-a" ? "Administrator A" : "Administrator B",
            role: "admin",
          },
          csrfToken: `synthetic-${actor}`,
        });
      }
      if (url.endsWith("/auth/logout"))
        return options.logoutFails
          ? json({ error: "unavailable" }, 503)
          : json({});
      if (url.endsWith("/publication-requests/publication-a"))
        return json(
          (await options.lookup) ?? {
            request: envelope.request,
            result: accepted,
          },
          options.lookupStatus ?? 200,
        );
      if (url.endsWith("/publish")) return json(accepted);
      return json([]);
    }),
  );
  const started = performance.now();
  mount();
  await screen.findByRole(
    "heading",
    { name: "转发路径", level: 1 },
    { timeout: Math.max(1, 5000 - (performance.now() - started) - 100) },
  );
  return {
    requests,
    user: userEvent.setup(),
    holdNextCheck: () => {
      let finish!: () => void;
      nextCheck = new Promise((resolve) => {
        finish = resolve;
      });
      return finish;
    },
    switchActor: (next: string) => {
      actor = next;
      window.dispatchEvent(new Event("online"));
    },
  };
}
it("retains the frozen request through a failed logout and same-actor re-verification", async () => {
  const { requests, user } = await restoredApp({ logoutFails: true });
  await user.click(screen.getByRole("button", { name: /Administrator A/ }));
  await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  await waitFor(() =>
    expect(requests.filter((r) => r.path.endsWith("/auth/me"))).toHaveLength(2),
  );
  expect(
    await screen.findByRole("button", { name: "查询提交结果" }),
  ).toBeTruthy();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  expect(
    requests.filter(
      (r) =>
        r.path.includes("publication-requests") || r.path.endsWith("/publish"),
    ),
  ).toHaveLength(0);
});
it("never resends automatically after a missing receipt and explicitly resends the exact original command", async () => {
  const { requests, user } = await restoredApp({
    lookupStatus: 404,
    lookup: { error: "not found" },
  });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  const resend = await screen.findByRole("button", { name: "恢复本次提交" });
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  await user.click(resend);
  expect(
    await screen.findByText("该次提交已接收", { exact: true }),
  ).toBeTruthy();
  expect(requests.filter((r) => r.method === "POST")).toEqual([
    {
      path: "/api/server-deployments/path-a/publish",
      method: "POST",
      body: { operationId: envelope.operationId, ...envelope.request },
    },
  ]);
});
it("keeps malformed receipts unresolved and exposes no terminal dismissal", async () => {
  const { user } = await restoredApp({
    lookup: {
      request: envelope.request,
      result: { ...accepted, operationId: "other" },
    },
  });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "查询提交结果",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(screen.getByText("提交结果待确认", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "关闭结果" })).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
});
it("permits a safely adopted deleted-target rejection to be dismissed without another request", async () => {
  const { requests, user } = await restoredApp({
    lookup: {
      request: envelope.request,
      result: {
        operationId: envelope.operationId,
        deploymentId: envelope.deploymentId,
        status: "definitively-rejected",
        nativeChecked: false,
        code: "PUBLICATION_REJECTED",
        detail:
          "The saved deployment no longer exists; select a current deployment and review again.",
      },
    },
  });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  expect(
    await screen.findByText(
      "该转发路径已不存在，请选择现有转发路径并重新检查。",
      { exact: true },
    ),
  ).toBeTruthy();
  await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
  const count = requests.length;
  await user.click(screen.getByRole("button", { name: "关闭结果" }));
  expect(screen.queryByText("该次提交未被接收", { exact: true })).toBeNull();
  expect(requests).toHaveLength(count);
});
it("never exposes or replays actor A's retained bytes when removal fails during an account switch", async () => {
  const { requests, switchActor } = await restoredApp();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("unavailable", "SecurityError");
  });
  await act(async () => switchActor("admin-b"));
  expect(
    await screen.findByRole("button", { name: /Administrator B/ }),
  ).toBeTruthy();
  await screen.findByRole("heading", { name: "转发路径", level: 1 });
  expect(screen.queryByRole("button", { name: "查询提交结果" })).toBeNull();
  expect(screen.queryByText("path-a", { exact: true })).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  expect(
    requests.filter(
      (r) =>
        r.path.includes("publication-requests") || r.path.endsWith("/publish"),
    ),
  ).toHaveLength(0);
});
it("retains an adopted terminal result on cleanup failure and never offers resend or terminal dismissal", async () => {
  const { requests, user } = await restoredApp();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new DOMException("unavailable", "SecurityError");
  });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  expect(
    await screen.findByText("该次提交已接收", { exact: true }),
  ).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: "清理本页记录" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "恢复本次提交" })).toBeNull();
  expect(screen.queryByRole("button", { name: "关闭结果" })).toBeNull();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
it("ignores a late actor A receipt without adopting it or removing actor B's restored handle", async () => {
  let release!: (value: unknown) => void;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  const { user, switchActor, requests } = await restoredApp({ lookup });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  await waitFor(() =>
    expect(
      requests.filter((r) => r.path.includes("publication-requests")),
    ).toHaveLength(1),
  );
  const next = {
    ...envelope,
    actorId: "admin-b",
    deploymentId: "path-b",
    operationId: "publication-b",
  };
  sessionStorage.setItem(storageKey, JSON.stringify(next));
  await act(async () => switchActor("admin-b"));
  await screen.findByRole("button", { name: /Administrator B/ });
  await screen.findByRole("button", { name: "查询提交结果" });
  await act(async () =>
    release({ request: envelope.request, result: accepted }),
  );
  expect(screen.queryByText("该次提交已接收", { exact: true })).toBeNull();
  expect(screen.getByText("path-b", { exact: true })).toBeTruthy();
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(next);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
it("does not clear a receipt while the document is hidden and reconciles local cleanup after visible verified return", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { user, requests, holdNextCheck } = await restoredApp({ lookup: gate });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () =>
    release({ request: envelope.request, result: accepted }),
  );
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  const finishCheck = holdNextCheck();
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  await act(async () => finishCheck());
  await screen.findByText("该次提交已接收", { exact: true });
  await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
  expect(
    requests.filter((r) => r.path.includes("publication-requests")),
  ).toHaveLength(1);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
it("does not acknowledge behind a new editor or leave recovery hidden by its persistent isNew mode", async () => {
  let release!: (value: unknown) => void;
  const lookup = new Promise((resolve) => {
    release = resolve;
  });
  const { user } = await restoredApp({ lookup });
  await user.click(screen.getByRole("button", { name: "查询提交结果" }));
  const header = screen
    .getByRole("heading", { name: "转发路径", level: 1 })
    .closest("header")!;
  await user.click(
    within(header).getByRole("button", { name: "新建转发路径" }),
  );
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  await act(async () =>
    release({ request: envelope.request, result: accepted }),
  );
  expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual(envelope);
  expect(screen.queryByText("该次提交已接收", { exact: true })).toBeNull();
  await user.click(within(editor).getByRole("button", { name: "关闭" }));
  await screen.findByText("该次提交已接收", { exact: true });
  await waitFor(() => expect(sessionStorage.getItem(storageKey)).toBeNull());
});

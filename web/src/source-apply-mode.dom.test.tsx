// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourcesPage } from "./Sources";
import { sourceRowAction } from "./test-support/source-row-actions";
import type { Source } from "./types";
import { hasUnsavedChanges } from "./navigation";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const source = {
  id: "airport",
  name: "My airport",
  kind: "text",
  enabled: true,
  revision: "source-1",
  snapshot: {
    endpoints: [
      {
        id: "endpoint",
        name: "London",
        connection: { protocol: "socks", host: "proxy.example", port: 1080 },
      },
    ],
  },
};
const candidate = {
  ...source,
  revision: "source-2",
  candidate: {
    id: "candidate-1",
    createdAt: "2026-10-19T10:00:00Z",
    diff: {
      added: [],
      removed: [],
      connectionChanged: [
        { id: "endpoint", name: "London", fields: ["password"] },
      ],
      renamed: [],
      beforeCount: 1,
      afterCount: 1,
    },
    affected: [
      {
        kind: "group",
        id: "group",
        name: "ChatGPT",
        profileName: "Work",
        reason: "selected-options-changed",
      },
      {
        kind: "subscription",
        id: "feed",
        name: "Work feed",
        reason: "published-unchanged",
      },
    ],
  },
};
const clients: QueryClient[] = [];
function mount(content = <SourcesPage />) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{content}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
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
  vi.spyOn(window, "getComputedStyle").mockImplementation((e) => original(e));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps manual refresh in the row menu and applies the exact pending version without a review or completion step", async () => {
  const user = userEvent.setup();
  let current: Source = { ...source, applyMode: "manual" };
  const writes: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/refresh")) {
        current = { ...candidate, applyMode: "manual" };
        return json(current);
      }
      if (path.endsWith("/apply")) {
        writes.push({ path, body: JSON.parse(String(init?.body)) });
        current = {
          ...source,
          applyMode: "manual",
          revision: "source-3",
          refreshStatus: "accepted",
        };
        return json(current);
      }
      return json(path.endsWith("/me/sources") ? [current] : []);
    }),
  );
  mount();
  await user.click(await sourceRowAction("刷新", "My airport"));
  const apply = await screen.findByRole("button", {
    name: "应用更新 My airport",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toHaveLength(0);
  await user.click(apply);
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: "/api/me/sources/airport/apply",
        body: { candidateId: "candidate-1", sourceRevision: "source-2" },
      },
    ]),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "应用更新 My airport" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retains pending application and read-only recovery after its row is filtered away", async () => {
  let reject!: (reason: Error) => void;
  const writes: string[] = [];
  let current: Source = { ...candidate, applyMode: "manual" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        writes.push(path);
        return new Promise<Response>((_resolve, fail) => {
          reject = fail;
        });
      }
      return json(
        path.endsWith("/me/sources/airport")
          ? current
          : [current, { ...source, id: "other", name: "Other source" }],
      );
    }),
  );
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "应用更新 My airport" }),
  );
  await waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(
    screen.getByRole("button", { name: "查看变化" }).hasAttribute("disabled"),
  ).toBe(true);
  const sourceMenu = screen.getByRole("button", {
    name: "更多操作 My airport",
  });
  expect(sourceMenu.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(sourceMenu);
  const otherMenu = screen.getByRole("button", {
    name: "更多操作 Other source",
  });
  expect(otherMenu.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(otherMenu);
  expect(screen.queryByRole("menu")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看变化" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual(["/api/me/sources/airport/apply"]);
  fireEvent.change(screen.getByPlaceholderText("搜索来源"), {
    target: { value: "missing-row" },
  });
  expect(
    screen.queryByRole("button", { name: "应用更新 My airport" }),
  ).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  current = { ...source, revision: "after-apply", refreshStatus: "accepted" };
  await act(async () => reject(new TypeError("response lost")));
  const recovery = within(await screen.findByRole("dialog"));
  expect(
    recovery.getByRole("button", { name: "应用更新" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(recovery.getByRole("button", { name: "核对当前状态" }));
  await recovery.findByText("当前没有待检查内容");
  expect(writes).toEqual(["/api/me/sources/airport/apply"]);
  expect(screen.queryByRole("dialog", { name: "上次应用详情" })).toBeNull();
});

it("ignores an application response after the authenticated source scope changes", async () => {
  let complete!: (response: Response) => void;
  const applied = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return json([{ ...candidate, applyMode: "manual" }]);
    }),
  );
  const host = mount(
    <SourcesPage acceptanceScope="account-one" onAccepted={applied} />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "应用更新 My airport" }),
  );
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  const client = clients.at(-1)!;
  host.rerender(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourcesPage acceptanceScope="account-two" onAccepted={applied} />
      </UIProviders>
    </QueryClientProvider>,
  );
  await act(async () => complete(json({ ...source, revision: "after-apply" })));
  expect(applied).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("applies an automatic refresh in one request without opening a review or publishing", async () => {
  let current: Source = { ...source, applyMode: "auto" };
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        writes.push(path);
        current = {
          ...current,
          revision: "auto-r2",
          refreshStatus: "accepted",
          snapshot: { endpoints: [] },
        };
        return json(current);
      }
      return json([current]);
    }),
  );
  mount();
  await userEvent.click(await sourceRowAction("刷新", "My airport"));
  await waitFor(() =>
    expect(writes).toEqual(["/api/me/sources/airport/refresh"]),
  );
  await screen.findByText("来源已更新");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "应用更新 My airport" }),
  ).toBeNull();
});

it("shows persisted count-only application history on demand after a new mount", async () => {
  const current: Source = {
    ...source,
    applyMode: "manual",
    applyHistory: [
      {
        id: "event-r2",
        appliedAt: "2026-10-30T10:00:00Z",
        mode: "manual",
        beforeCount: 3,
        afterCount: 4,
        added: 2,
        removed: 1,
        connectionChanged: 1,
        renamed: 0,
        reordered: false,
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([current])),
  );
  mount();
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(
    await screen.findByRole("button", { name: "My airport 文本导入" }),
  );
  const detail = within(await screen.findByRole("dialog"));
  expect(detail.getByRole("heading", { name: "应用记录" })).toBeTruthy();
  const historyEntry = detail.getByText("3 → 4 个节点").closest("li")!;
  for (const fact of ["新增 2", "移除 1", "连接变化 1", "改名 0"]) {
    expect(within(historyEntry).getByText(fact)).toBeTruthy();
  }
  expect(detail.queryByText(/已发布成功|服务器已应用/)).toBeNull();
});

it("does not apply an older candidate while a refresh is still running", async () => {
  let complete!: (response: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        writes.push(path);
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      }
      return json([candidate]);
    }),
  );
  mount();
  await userEvent.click(await sourceRowAction("刷新", "My airport"));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  const apply = screen.getByRole("button", { name: "应用更新 My airport" });
  expect(apply.hasAttribute("disabled")).toBe(true);
  await userEvent.click(apply);
  await userEvent.click(screen.getByRole("button", { name: "查看变化" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual(["/api/me/sources/airport/refresh"]);
  await act(async () => complete(json(candidate)));
  await waitFor(() => expect(apply.hasAttribute("disabled")).toBe(false));
});

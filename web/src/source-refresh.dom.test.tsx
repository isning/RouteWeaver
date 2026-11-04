// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourcesPage } from "./Sources";
import { sourceRowAction } from "./test-support/source-row-actions";
import { SourceUpdateReview } from "./SourceUpdateReview";
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
it("offers optional change details and applies the exact manual update without a forced completion step", async () => {
  let listed = source;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/refresh")) {
      listed = candidate;
      return json(candidate);
    }
    if (String(url).endsWith("/apply")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        candidateId: "candidate-1",
        sourceRevision: "source-2",
      });
      listed = { ...source, revision: "source-3" };
      return json(listed);
    }
    return json([listed]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const user = userEvent.setup();
  await user.click(await sourceRowAction("刷新", "My airport"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "查看变化" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("查看变化")).toBeTruthy();
  expect(within(dialog).getByText("连接变更 · 1")).toBeTruthy();
  expect(within(dialog).getByText("登录密码")).toBeTruthy();
  expect(within(dialog).getByText("ChatGPT")).toBeTruthy();
  expect(within(dialog).getByText("Work feed")).toBeTruthy();
  expect(within(dialog).queryByText("新增 · 0")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "应用更新" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await screen.findByText("「My airport」已应用，已发布订阅未改变"),
  ).toBeTruthy();
  const dismiss = vi.spyOn(toast, "dismiss");
  await user.click(
    await screen.findByRole("button", { name: "查看上次应用结果 My airport" }),
  );
  const accepted = await screen.findByRole("dialog", { name: "上次应用详情" });
  // The durable receipt owns this success now; unrelated/error feedback is not cleared.
  expect(dismiss).toHaveBeenCalledExactlyOnceWith("source-application:airport");
  expect(hasUnsavedChanges()).toBe(false);
  expect(
    within(accepted).getByText("来源已更新，已发布订阅未改变。"),
  ).toBeTruthy();
  expect(
    within(accepted)
      .getByRole("link", { name: "查看订阅 Work feed" })
      .getAttribute("href"),
  ).toBe("#subscriptions?output=feed");
  expect(
    within(accepted).queryByRole("button", { name: "应用更新" }),
  ).toBeNull();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes("/publish")),
  ).toHaveLength(0);
  await user.click(within(accepted).getByRole("button", { name: "完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(
    screen.getByRole("button", { name: "查看上次应用结果 My airport" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "上次应用详情" }),
  ).toBeTruthy();
});
it("does not interrupt an unchanged refresh with a review dialog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) =>
      String(url).endsWith("/refresh")
        ? json({ ...source, refreshStatus: "unchanged" })
        : json([source]),
    ),
  );
  mount();
  await userEvent.setup().click(await sourceRowAction("刷新", "My airport"));
  await screen.findByText("已是最新内容");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retains failed edited text and uses the saved revision when retrying", async () => {
  let attempts = 0;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/reveal"))
      return json({ ...source, content: "socks5://proxy.example:1080#London" });
    if (!init?.method && String(url).endsWith(`/sources/${source.id}`))
      return json(source);
    if (init?.method === "PUT") {
      attempts++;
      const body = JSON.parse(String(init.body));
      if (attempts === 1)
        return json(
          {
            detail: "Unable to import the changed input",
            source: {
              ...source,
              revision: "retained-2",
              lastError: "Unable to import the changed input",
            },
          },
          422,
        );
      expect(body.content).toBe("fixed-input");
      expect(body.revision).toBe("retained-2");
      return json({ ...source, revision: "retained-3" });
    }
    return json([source]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const user = userEvent.setup();
  await user.click(await sourceRowAction("编辑", "My airport"));
  const input = await screen.findByRole("textbox", {
    name: "节点链接或配置内容",
  });
  await user.clear(input);
  await user.type(input, "failed-input");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await screen.findByText(/导入未完成。请检查来源设置和内容后重试。/);
  expect((input as HTMLTextAreaElement).value).toBe("failed-input");
  await user.clear(input);
  await user.type(input, "fixed-input");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps a stale candidate visible and requires read-only verification before another decision", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) =>
      String(url).endsWith("/apply")
        ? json({ detail: "source or affected selections changed" }, 409)
        : json([candidate]),
    ),
  );
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "查看变化" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "应用更新" }));
  await within(dialog).findByText("来源或相关选择已变化");
  expect(screen.queryByRole("dialog", { name: "上次应用详情" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 My airport" }),
  ).toBeNull();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "应用更新",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    within(dialog).getByRole("button", { name: "核对当前状态" }),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("button", { name: "忽略本次更新" }),
  ).toBeTruthy();
});

it("corrects a failed first import without creating a duplicate source or dropping its fields", async () => {
  let first: { id: string } | undefined;
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      first = JSON.parse(String(init.body));
      return json(
        {
          detail: "Fix this input",
          source: { ...first, revision: "failed-add", content: undefined },
        },
        422,
      );
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      expect(body.id).toBe(first!.id);
      expect(body.revision).toBe("failed-add");
      expect(body.content).toBe("corrected-input");
      return json({ ...body, revision: "accepted-add" });
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount();
  const user = userEvent.setup();
  await user.click(
    (await screen.findAllByRole("button", { name: "添加来源" }))[0],
  );
  await user.type(
    screen.getByRole("textbox", { name: "来源名称" }),
    "New airport",
  );
  const input = screen.getByRole("textbox", { name: "节点链接或配置内容" });
  await user.click(input);
  await user.paste("bad-input");
  await user.click(screen.getByRole("button", { name: "导入来源" }));
  await screen.findByText(/导入未完成。请检查来源设置和内容后重试。/);
  expect((input as HTMLTextAreaElement).value).toBe("bad-input");
  await user.clear(input);
  await user.paste("corrected-input");
  await user.click(screen.getByRole("button", { name: "导入来源" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});

it("distinguishes removed and added same-name connections with safe address summaries", async () => {
  const replacement = {
    ...candidate,
    candidate: {
      ...candidate.candidate,
      diff: {
        ...candidate.candidate.diff,
        removed: [
          {
            id: "old",
            name: "Same UK",
            beforeConnection: "socks · [2001:db8::50]:1080",
          },
        ],
        added: [
          {
            id: "new",
            name: "Same UK",
            afterConnection: "socks · [2001:db8::50]:1081",
          },
        ],
        connectionChanged: [],
      },
    },
  };
  let listed = source;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/refresh")) {
        listed = replacement;
        return json(replacement);
      }
      return json([listed]);
    }),
  );
  mount();
  await userEvent.click(await sourceRowAction("刷新", "My airport"));
  await userEvent.click(
    await screen.findByRole("button", { name: "查看变化" }),
  );
  const review = within(await screen.findByRole("dialog"));
  expect(review.getByText("socks · [2001:db8::50]:1080")).toBeTruthy();
  expect(review.getByText("socks · [2001:db8::50]:1081")).toBeTruthy();
  expect(review.getAllByText("Same UK")).toHaveLength(2);
  expect(review.getByRole("button", { name: "忽略本次更新" })).toBeTruthy();
});

it("rejects the candidate without creating an acceptance continuation", async () => {
  let listed = candidate;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/candidate/reject")) {
        listed = { ...source, revision: "rejected" } as typeof candidate;
        return json(listed);
      }
      return json([listed]);
    }),
  );
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "查看变化" }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "忽略本次更新",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 My airport" }),
  ).toBeNull();
});

it("verifies a lost acceptance response by reading the source without inventing an acceptance receipt", async () => {
  let current = candidate as typeof source & {
    candidate?: typeof candidate.candidate;
  };
  const operations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      operations.push(`${init?.method || "GET"} ${path}`);
      if (path.endsWith("/apply")) {
        current = { ...source, revision: "accepted-elsewhere" };
        throw new TypeError("Lost response");
      }
      if (path.endsWith("/me/sources/airport")) return json(current);
      return json([current]);
    }),
  );
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "查看变化" }),
  );
  let review = within(await screen.findByRole("dialog", { name: "查看变化" }));
  await userEvent.click(review.getByRole("button", { name: "应用更新" }));
  await review.findByText("尚未确认这次选择的结果");
  expect(review.queryByText(/原有选项仍然保留/)).toBeNull();
  await userEvent.click(review.getByRole("button", { name: "核对当前状态" }));
  review = within(await screen.findByRole("dialog", { name: "核对来源状态" }));
  await review.findByText("当前没有待检查内容");
  expect(screen.queryByRole("dialog", { name: "上次应用详情" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 My airport" }),
  ).toBeNull();
  expect(operations.filter((item) => item.startsWith("POST"))).toEqual([
    "POST /api/me/sources/airport/apply",
  ]);
  expect(operations).toContain("GET /api/me/sources/airport");
});

it("shows safe localized failed-source detail rather than raw server text", async () => {
  const failed = {
    ...source,
    refreshStatus: "failed",
    lastError: "private-detail-token",
    lastErrorCode: "source_url_not_allowed",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([failed])),
  );
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: /My airport.*文本导入/ }),
  );
  await screen.findByText(
    "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
  );
  expect(screen.queryByText("private-detail-token")).toBeNull();
});

it("shows localized failed-source review without hiding the accepted snapshot", async () => {
  const failed = {
    ...source,
    refreshStatus: "failed",
    lastError: "private-detail-token",
    lastErrorCode: "source_url_not_allowed",
  } as Source;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(failed)),
  );
  mount(<SourceUpdateReview source={failed} onClose={() => {}} />);
  await screen.findByText(
    "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
  );
  expect(
    screen.getByText("之前的节点仍可使用，不会应用失败的输入。"),
  ).toBeTruthy();
  expect(screen.queryByText("private-detail-token")).toBeNull();
});

it("shows unknown source status as unconfirmed rather than green imported", async () => {
  const unknown = {
    ...source,
    refreshStatus: "future-status",
    lastError: "private-detail-token",
    lastErrorCode: "source_url_not_allowed",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([unknown])),
  );
  mount();
  await screen.findByText("状态待确认");
  expect(screen.queryByText("已导入")).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: /My airport.*文本导入/ }),
  );
  await screen.findByText("来源状态待确认");
  expect(
    screen.getByText("暂时无法确认来源状态。请重新打开来源后再试。"),
  ).toBeTruthy();
  expect(screen.queryByText("private-detail-token")).toBeNull();
});

it("keeps unknown review copy neutral rather than asserting a failed input", async () => {
  const unknown = {
    ...source,
    refreshStatus: "future-status",
    lastError: "private-detail",
    lastErrorCode: "source_url_not_allowed",
  } as Source;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(unknown)),
  );
  mount(<SourceUpdateReview source={unknown} onClose={() => {}} />);
  await screen.findByText("来源状态待确认");
  expect(
    screen.getByText("暂时无法确认来源状态。请重新打开来源后再试。"),
  ).toBeTruthy();
  expect(screen.queryByText(/这不会接受失败的输入/)).toBeNull();
  expect(screen.queryByText("最近一次导入未完成")).toBeNull();
  expect(screen.queryByText("private-detail")).toBeNull();
});

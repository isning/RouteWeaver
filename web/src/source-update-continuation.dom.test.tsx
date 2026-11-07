// @vitest-environment jsdom
// This file tests session-scoped acceptance receipts, not cold lazy loading.
// Preload the real page; transport fixtures and navigation/session assertions stay unchanged.
import "./Sources";
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
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
import {
  SourceUpdateContinuation,
  sourceAcceptanceReceipt,
} from "./SourceUpdateContinuation";
import type { Source, SourceApplicationResult } from "./types";

const source: Source = {
  id: "private-source",
  name: "私有来源",
  kind: "text",
  enabled: true,
  revision: "source-2",
  url: "https://private.invalid/token",
  content: "private input",
  snapshot: { endpoints: [] },
  candidate: {
    id: "candidate-1",
    createdAt: "2026-10-22T00:00:00Z",
    diff: {
      beforeCount: 2,
      afterCount: 1,
      removed: [
        { id: "missing", name: "已移除选项", beforeConnection: "private-host" },
      ],
      added: [],
      renamed: [],
      connectionChanged: [
        {
          id: "changed",
          name: "更改选项",
          fields: ["password"],
          beforeConnection: "old-private",
          afterConnection: "new-private",
        },
      ],
    },
    affected: [
      {
        kind: "collection",
        id: "collection",
        name: "整理结果",
        reason: "source-options-changed",
      },
      {
        kind: "profile",
        id: "profile/one",
        name: "同名配置",
        reason: "draft-inputs-changed",
      },
      {
        kind: "profile",
        id: "profile/two",
        name: "同名配置",
        reason: "draft-inputs-changed",
      },
      {
        kind: "group",
        id: "not-a-profile",
        name: "失效分组",
        profileName: "同名配置",
        reason: "selected-options-changed",
      },
      {
        kind: "rule",
        id: "not-a-profile-either",
        name: "同名配置",
        reason: "rule-option-changed",
      },
      {
        kind: "subscription",
        id: "output/one",
        name: "同名订阅",
        reason: "published-unchanged",
      },
      {
        kind: "subscription",
        id: "output/two",
        name: "同名订阅",
        reason: "published-unchanged",
      },
    ],
  },
};
const appliedSource: Source = {
  ...source,
  revision: "applied-source-revision",
  candidate: undefined,
  updatedAt: "2026-11-07T10:00:00Z",
};
const appliedResult: SourceApplicationResult = {
  ...appliedSource,
  application: {
    candidateId: "candidate-1",
    sourceRevision: "applied-source-revision",
    affected: source.candidate!.affected,
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
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
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "#sources");
});
function mount(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
  return client;
}
it("retains only allowlisted acceptance evidence, never connection descriptions or private input", () => {
  const receipt = sourceAcceptanceReceipt(source, appliedResult);
  expect(Object.keys(receipt).sort()).toEqual([
    "acceptedAt",
    "affected",
    "affectedVerified",
    "diff",
    "sourceId",
    "sourceName",
  ]);
  expect(receipt.diff.removed).toEqual([{ id: "missing", name: "已移除选项" }]);
  expect(receipt.diff.connectionChanged).toEqual([
    { id: "changed", name: "更改选项", fields: ["password"] },
  ]);
  for (const secret of [
    "private.invalid",
    "private input",
    "private-host",
    "old-private",
    "new-private",
    "candidate-1",
    "source-2",
  ])
    expect(JSON.stringify(receipt)).not.toContain(secret);
  expect(receipt.affected).not.toBe(source.candidate!.affected);
  expect(receipt.diff.connectionChanged[0].fields).not.toBe(
    source.candidate!.diff.connectionChanged[0].fields,
  );
});
it("routes duplicate names by exact object IDs and keeps unresolved group and rule evidence without guessing parents", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  mount(
    <SourceUpdateContinuation
      receipt={sourceAcceptanceReceipt(source, appliedResult)}
      onClose={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "上次应用详情" });
  expect(
    within(dialog)
      .getAllByRole("link", { name: /^查看配置 同名配置/ })
      .map((link) => link.getAttribute("href")),
  ).toEqual([
    "#subscriptions?profile=profile%2Fone",
    "#subscriptions?profile=profile%2Ftwo",
  ]);
  expect(
    within(dialog)
      .getAllByRole("link", { name: /^查看订阅 同名订阅/ })
      .map((link) => link.getAttribute("href")),
  ).toEqual([
    "#subscriptions?output=output%2Fone",
    "#subscriptions?output=output%2Ftwo",
  ]);
  expect(within(dialog).getAllByRole("link")).toHaveLength(4);
  await userEvent.click(within(dialog).getByText("查看本次更新"));
  expect(within(dialog).getByText("已移除选项")).toBeTruthy();
  expect(within(dialog).getByText("登录密码")).toBeTruthy();
  expect(within(dialog).getByText("失效分组")).toBeTruthy();
  expect(within(dialog).queryByText("有待发布修改")).toBeNull();
});
it("retains accepted evidence across page navigation only in the current authenticated session", async () => {
  history.replaceState(null, "", "#sources");
  let current = source;
  let identity = {
    user: { id: "first", name: "First", role: "member" },
    csrfToken: "session-one",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const path = String(url);
      if (path.endsWith("/auth/me")) return json(identity);
      if (path.endsWith("/apply")) {
        current = appliedSource;
        return json(appliedResult);
      }
      if (path.endsWith("/me/sources")) return json([current]);
      return json([]);
    }),
  );
  mount(<Workspace />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole(
      "button",
      { name: "查看变化" },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "应用更新",
    }),
  );

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => {
    location.hash = "#subscriptions";
  });
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  await act(async () => {
    location.hash = "#sources";
  });
  await user.click(
    await screen.findByRole("button", { name: "查看上次应用结果 私有来源" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "上次应用详情" }),
  ).toBeTruthy();
  await act(async () => {
    identity = {
      user: { id: "second", name: "Second", role: "member" },
      csrfToken: "session-two",
    };
    window.dispatchEvent(new Event("online"));
  });
  await screen.findByText("Second");
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(screen.queryByRole("dialog", { name: "上次应用详情" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 私有来源" }),
  ).toBeNull();
  await act(async () => {
    identity = {
      user: { id: "first", name: "First", role: "member" },
      csrfToken: "session-three",
    };
    window.dispatchEvent(new Event("online"));
  });
  await screen.findByText("First");
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 私有来源" }),
  ).toBeNull();
});
it("does not restore an old-session receipt when acceptance finishes after identity changes", async () => {
  history.replaceState(null, "", "#sources");
  let complete!: (value: Response) => void;
  let current = source;
  let identity = {
    user: { id: "first", name: "First", role: "member" },
    csrfToken: "session-one",
  };
  const fetcher = vi.fn(async (url: unknown) => {
    const path = String(url);
    if (path.endsWith("/auth/me")) return json(identity);
    if (path.endsWith("/apply"))
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    if (path.endsWith("/me/sources")) return json([current]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetcher);
  mount(<Workspace />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole(
      "button",
      { name: "查看变化" },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "应用更新",
    }),
  );
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  current = appliedSource;
  await act(async () => {
    identity = {
      user: { id: "second", name: "Second", role: "member" },
      csrfToken: "new-session",
    };
    window.dispatchEvent(new Event("online"));
  });
  await screen.findByText("Second");
  await act(async () => {
    complete(json(appliedResult));
  });
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(screen.queryByRole("dialog", { name: "上次应用详情" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 私有来源" }),
  ).toBeNull();
  await act(async () => {
    location.hash = "#subscriptions";
  });
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  await act(async () => {
    location.hash = "#sources";
  });
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(
    screen.queryByRole("button", { name: "查看上次应用结果 私有来源" }),
  ).toBeNull();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).includes("/publish")),
  ).toHaveLength(0);
});
it("visibly distinguishes duplicate names using read-only client metadata and profile relationships", async () => {
  const fetcher = vi.fn(async (_url: unknown) =>
    json([
      {
        id: "output/one",
        name: "同名订阅",
        profileId: "profile/one",
        target: { adapterId: "sing-box" },
        mode: "full",
      },
      {
        id: "output/two",
        name: "同名订阅",
        profileId: "profile/two",
        target: { adapterId: "xray" },
        mode: "nodes-only",
      },
    ]),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(
    <SourceUpdateContinuation
      receipt={sourceAcceptanceReceipt(source, appliedResult)}
      onClose={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "上次应用详情" });
  await within(dialog).findByText("sing-box 完整配置");
  expect(within(dialog).getByText("xray 纯节点")).toBeTruthy();
  expect(
    within(dialog).getByText("关联订阅：同名订阅（sing-box 完整配置）"),
  ).toBeTruthy();
  expect(
    within(dialog).getByText("关联订阅：同名订阅（xray 纯节点）"),
  ).toBeTruthy();
  expect(within(dialog).queryByText("配置标识：profile/one")).toBeNull();
  expect(
    within(dialog)
      .getByRole("link", { name: "查看订阅 同名订阅 sing-box 完整配置" })
      .getAttribute("href"),
  ).toBe("#subscriptions?output=output%2Fone");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0][0])).toBe("/api/me/outputs");
});
it("keeps full differing ID tails visible while metadata loads and when duplicate summaries still match", async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const receipt = sourceAcceptanceReceipt(source, appliedResult);
  const identities: Record<string, string> = {
    "profile/one": "shared-profile-prefix-000000000000-A",
    "profile/two": "shared-profile-prefix-000000000000-B",
    "output/one": "shared-output-prefix-000000000000-A",
    "output/two": "shared-output-prefix-000000000000-B",
  };
  receipt.affected = receipt.affected.map((item) => ({
    ...item,
    id: identities[item.id] || item.id,
  }));
  mount(<SourceUpdateContinuation receipt={receipt} onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "上次应用详情" });
  expect(
    within(dialog).getByText(`订阅标识：${identities["output/one"]}`),
  ).toBeTruthy();
  expect(
    within(dialog).getByText(`订阅标识：${identities["output/two"]}`),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/0 个订阅/)).toBeNull();
  await act(async () =>
    complete(
      json(
        ["one", "two"].map((suffix) => ({
          id: identities[`output/${suffix}`],
          name: "同名订阅",
          profileId: identities[`profile/${suffix}`],
          target: { adapterId: "sing-box" },
          mode: "full",
        })),
      ),
    ),
  );
  await within(dialog).findAllByText(/关联订阅：同名订阅（sing-box 完整配置）/);
  for (const id of Object.values(identities)) {
    const detail = within(dialog).getByText(new RegExp(`标识：${id}$`));
    expect(detail.textContent).toContain(id);
    expect(detail.classList.contains("wrap-anywhere")).toBe(true);
    expect(detail.classList.contains("whitespace-normal")).toBe(true);
  }
  expect(
    within(dialog)
      .getByRole("link", {
        name: new RegExp(`查看订阅.*${identities["output/two"]}$`),
      })
      .getAttribute("href"),
  ).toBe(`#subscriptions?output=${identities["output/two"]}`);
});
it("falls back to visible exact identities on metadata error and retries only the metadata read", async () => {
  const fetcher = vi.fn(
    async (_url: unknown) =>
      new Response(JSON.stringify({ detail: "metadata unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount(
    <SourceUpdateContinuation
      receipt={sourceAcceptanceReceipt(source, appliedResult)}
      onClose={() => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog", { name: "上次应用详情" });
  await within(dialog).findByText("暂无法读取订阅信息");
  expect(within(dialog).getByText("配置标识：profile/one")).toBeTruthy();
  expect(within(dialog).getByText("订阅标识：output/two")).toBeTruthy();
  expect(within(dialog).getAllByRole("link")).toHaveLength(4);
  fetcher.mockImplementation(async () => json([]));
  await userEvent.click(
    within(dialog).getByRole("button", { name: "重试读取" }),
  );
  await waitFor(() =>
    expect(within(dialog).queryByText("暂无法读取订阅信息")).toBeNull(),
  );
  expect(within(dialog).getByText("配置标识：profile/one")).toBeTruthy();
  expect(within(dialog).queryByText(/0 个订阅/)).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/me/outputs",
    "/api/me/outputs",
  ]);
});
it("adds no metadata request or disambiguation text to uniquely named related objects", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const receipt = sourceAcceptanceReceipt(source, appliedResult);
  receipt.affected = receipt.affected.filter((item) =>
    ["profile/one", "output/one"].includes(item.id),
  );
  mount(<SourceUpdateContinuation receipt={receipt} onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "上次应用详情" });
  expect(
    within(dialog).getByRole("link", { name: "查看配置 同名配置" }),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("link", { name: "查看订阅 同名订阅" }),
  ).toBeTruthy();
  expect(within(dialog).queryByText(/标识：|关联订阅：/)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

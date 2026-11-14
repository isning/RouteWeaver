// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { SourceUpdateReview } from "./SourceUpdateReview";
import type { Source } from "./types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { UIProviders } from "./ui-patterns/providers";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import { invalidateOutputInputs } from "./output-comparison";

async function singleCheckAction(
  scenario: ReturnType<typeof ownedClickScenario>,
) {
  await scenario.click(() =>
    screen.findByRole("button", { name: "管理配置 日常分流" }),
  );
  return screen.findByRole("menuitem", {
    name: "检查 日常分流 的 1 个订阅更新",
  });
}

const profile = { ...emptyProfile(), id: "shared", name: "日常分流" };
const outputs = ["MacBook", "Android"].map((name) => ({
  id: name.toLowerCase(),
  name,
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
  revision: `${name}-publication`,
}));
const comparisonText =
  (pattern: RegExp) => (_content: string, element: Element | null) =>
    !!element?.classList.contains("subscription-comparison-state") &&
    pattern.test(element.textContent || "");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

it("bounds an explicit visible page to five checks with two in flight and never follows pagination", async (context) => {
  const scenario = ownedClickScenario(context);
  const many = Array.from({ length: 100 }, (_, index) => ({
    ...outputs[0],
    id: `device-${index}`,
    name: `Device ${index}`,
    revision: `revision-${index}`,
  }));
  const pending: {
    output: (typeof many)[number];
    resolve: (value: Response) => void;
  }[] = [];
  let active = 0,
    maximum = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(many);
      if (path.endsWith("/comparison")) {
        const output = many.find((item) => path.includes(`/${item.id}/`))!;
        active++;
        maximum = Math.max(maximum, active);
        return new Promise<Response>((resolve) =>
          pending.push({
            output,
            resolve: (value) => {
              active--;
              resolve(value);
            },
          }),
        );
      }
      throw new Error(`Unexpected read: ${path}`);
    }),
  );
  mount();
  const group = await screen.findByRole("article", {
    name: "分流配置 日常分流",
  });
  expect(
    within(group).getAllByRole("row", { name: /^客户端订阅 / }),
  ).toHaveLength(5);
  expect(pending).toHaveLength(0);
  await scenario.click(() =>
    within(group).getByRole("button", {
      name: "检查 日常分流 的 5 个订阅更新",
    }),
  );
  await waitFor(() => expect(pending).toHaveLength(2));
  await waitFor(() => {
    expect(within(group).getAllByText("正在检查更新")).toHaveLength(2);
    expect(within(group).getAllByText("等待检查更新")).toHaveLength(3);
  });
  for (let index = 0; index < 5; index++) {
    await waitFor(() => expect(pending.length).toBeGreaterThan(index));
    await act(async () =>
      pending[index].resolve(
        json({
          ...pending[index].output,
          draftComparison: { state: "changed" },
        }),
      ),
    );
  }
  await waitFor(() =>
    expect(
      within(group).getAllByText(comparisonText(/有未发布修改.*上次核对/)),
    ).toHaveLength(5),
  );
  expect(maximum).toBe(2);
  expect(pending.map((item) => item.output.id)).toEqual([
    "device-0",
    "device-1",
    "device-2",
    "device-3",
    "device-4",
  ]);
  await scenario.click(() =>
    within(group).getByRole("button", { name: "下一页" }),
  );
  await within(group).findByText("Device 5");
  expect(within(group).getAllByText("未检查更新")).toHaveLength(5);
  expect(pending).toHaveLength(5);
});

it("keeps known invalid intent, unknown failures and never-checked rows distinct", async (context) => {
  const scenario = ownedClickScenario(context);
  const three = [
    ...outputs,
    {
      ...outputs[0],
      id: "tablet",
      name: "Tablet",
      revision: "tablet-revision",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(three);
      if (path.endsWith("/macbook/comparison"))
        return json({
          ...three[0],
          draftComparison: {
            state: "unavailable",
            reason: "missing-action-reference",
            location: "default",
          },
        });
      if (path.endsWith("/android/comparison"))
        return json({ detail: "temporarily unavailable" }, 503);
      if (path.endsWith("/tablet/comparison"))
        return json({ ...three[2], draftComparison: { state: "unavailable" } });
      return json([]);
    }),
  );
  mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 3 个订阅更新" }),
  );
  await screen.findByText(comparisonText(/默认流量需修复.*上次核对/));
  const failed = screen.getByRole("row", { name: "客户端订阅 Android" });
  await within(failed).findByText("暂时无法比较");
  await screen.findByText(comparisonText(/暂时无法比较.*上次核对/));
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(screen.getAllByText("已发布")).toHaveLength(3);
  expect(within(failed).getByRole("button", { name: "检查更新" })).toBeTruthy();
  expect(within(failed).getByRole("button", { name: "获取订阅" })).toBeTruthy();
  expect(within(failed).queryByText(/请重新核对/)).toBeNull();
  expect(within(failed).queryByRole("button", { name: "查看修改" })).toBeNull();
});

it("fences a second known input mutation even when the input query stayed invalidated after a failed refresh", async (context) => {
  const scenario = ownedClickScenario(context);
  let checks = 0;
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json([outputs[0]]);
      if (path.endsWith("/comparison")) {
        checks++;
        if (checks === 1)
          return json({
            ...outputs[0],
            draftComparison: { state: "unchanged" },
          });
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return json([], 503);
    }),
  );
  const { client } = mount();
  await screen.findByRole("button", { name: "检查更新" });
  expect(
    screen.queryByRole("button", { name: "检查 日常分流 的 1 个订阅更新" }),
  ).toBeNull();
  const check = await singleCheckAction(scenario);
  await scenario.click(() => check);
  await screen.findByText(comparisonText(/与保存草稿一致.*上次核对/));
  expect(screen.queryByRole("dialog")).toBeNull();
  // This public callback is shared by actual source/collection/resource mutation
  // boundaries. Unlike observing cache events, a second call always advances it.
  client.setQueryData(["collections"], []);
  await act(async () => {
    invalidateOutputInputs(client);
    await client.invalidateQueries({
      queryKey: ["collections"],
      refetchType: "none",
    });
    await client
      .fetchQuery({
        queryKey: ["collections"],
        queryFn: async () => {
          throw new Error("refresh failed");
        },
        retry: false,
      })
      .catch(() => {});
  });
  expect(client.getQueryState(["collections"])?.isInvalidated).toBe(true);
  await screen.findByText("需要重新检查更新");
  expect(checks).toBe(1);
  await scenario.click(() => singleCheckAction(scenario));
  await waitFor(() => expect(checks).toBe(2));
  await act(async () => {
    invalidateOutputInputs(client);
    await client.invalidateQueries({
      queryKey: ["collections"],
      refetchType: "none",
    });
    finish(json({ ...outputs[0], draftComparison: { state: "unchanged" } }));
  });
  await screen.findByText("需要重新检查更新");
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(checks).toBe(2);
});

it("discards late results after search changes and never checks a replacement scope", async (context) => {
  const scenario = ownedClickScenario(context);
  const late: (() => void)[] = [];
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/comparison")) {
        calls.push(path);
        const output = outputs.find((item) => path.includes(`/${item.id}/`))!;
        return new Promise<Response>((resolve) =>
          late.push(() =>
            resolve(
              json({ ...output, draftComparison: { state: "unchanged" } }),
            ),
          ),
        );
      }
      return json([]);
    }),
  );
  mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 2 个订阅更新" }),
  );
  await waitFor(() => expect(late).toHaveLength(2));
  scenario.change(
    () => screen.getByRole("textbox", { name: "搜索配置或客户端订阅" }),
    { target: { value: "Android" } },
  );
  await act(async () => late.forEach((finish) => finish()));
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(screen.getByText("未检查更新")).toBeTruthy();
  expect(calls).toHaveLength(2);
});

it("never records a late private detail as fresh evidence after a known input mutation", async (context) => {
  const scenario = ownedClickScenario(context);
  let finishStatus!: (value: Response) => void;
  let statusCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/comparison")) {
        const output = outputs.find((item) => path.includes(`/${item.id}/`))!;
        return json({ ...output, draftComparison: { state: "changed" } });
      }
      if (path.endsWith("/macbook/status")) {
        statusCalls++;
        return new Promise<Response>((resolve) => {
          finishStatus = resolve;
        });
      }
      return json([]);
    }),
  );
  const { client } = mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 2 个订阅更新" }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByText(comparisonText(/有未发布修改.*上次核对/)),
    ).toHaveLength(2),
  );
  await scenario.click(() =>
    screen.getByRole("button", { name: "查看订阅 MacBook" }),
  );
  await waitFor(() => expect(statusCalls).toBe(1));
  await act(async () => {
    invalidateOutputInputs(client, profile.id);
    // Deliberately ignore AbortSignal in this transport fixture.
    finishStatus(
      json({
        ...outputs[0],
        routingIntent: {
          version: 1,
          kind: "portable",
          rules: [{ id: "private-rule" }],
        },
        draftComparison: { state: "unchanged" },
      }),
    );
  });
  const dialog = screen.getByRole("dialog", { name: "MacBook 的订阅详情" });
  await within(dialog).findByText(
    "暂时无法比较已保存的修改。已发布内容未因此改变。",
  );
  await scenario.click(() =>
    within(dialog).getByRole("button", { name: "关闭" }),
  );
  await within(
    screen.getByRole("row", { name: "客户端订阅 MacBook" }),
  ).findByText("未检查更新");
  await within(
    screen.getByRole("row", { name: "客户端订阅 Android" }),
  ).findByText("需要重新检查更新");
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(statusCalls).toBe(1);
  const coarse = client
    .getQueryCache()
    .findAll({ queryKey: ["output-comparisons"] })
    .map((query) => query.state.data);
  expect(JSON.stringify(coarse)).not.toContain("private-rule");
  expect(JSON.stringify(coarse)).not.toContain("routingIntent");
});

it("projects a successful private detail without private rules and preserves it across same-account global invalidation and unchanged inventory refresh", async (context) => {
  const scenario = ownedClickScenario(context);
  let statusCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/macbook/status")) {
        statusCalls++;
        return json({
          ...outputs[0],
          routingIntent: {
            version: 1,
            kind: "portable",
            defaultAction: { kind: "direct" },
            ruleCount: 1,
            rules: [
              {
                id: "private-rule",
                match: {
                  state: "exact",
                  expression: { op: "domain", value: "private.invalid" },
                },
                action: { kind: "direct" },
              },
            ],
          },
          draftComparison: { state: "changed" },
        });
      }
      return json([]);
    }),
  );
  const { client } = mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "查看订阅 MacBook" }),
  );
  const dialog = screen.getByRole("dialog", { name: "MacBook 的订阅详情" });
  await within(dialog).findByText("已保存的修改尚未发布");
  await scenario.click(() =>
    within(dialog).getByRole("button", { name: "关闭" }),
  );
  await screen.findByText(comparisonText(/有未发布修改.*上次核对/));
  await act(async () => {
    await client.invalidateQueries();
    await client.refetchQueries({ queryKey: ["outputs"], exact: true });
  });
  expect(
    screen.getByText(comparisonText(/有未发布修改.*上次核对/)),
  ).toBeTruthy();
  expect(screen.getByText("未检查更新")).toBeTruthy();
  expect(statusCalls).toBe(1);
  const coarse = client
    .getQueryCache()
    .findAll({ queryKey: ["output-comparisons"] })
    .map((query) => query.state.data);
  expect(JSON.stringify(coarse)).not.toContain("private-rule");
  expect(JSON.stringify(coarse)).not.toContain("private.invalid");
  expect(JSON.stringify(coarse)).not.toContain("routingIntent");
});
const clients: QueryClient[] = [];
function mount(extra?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <SubscriptionsPage />
          {extra}
        </UIProviders>
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  clients.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("checks only after an explicit scoped action and keeps publication separate from per-device as-of results", async (context) => {
  const scenario = ownedClickScenario(context);
  const comparisons: string[] = [],
    privateReads: string[] = [],
    writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method && init.method !== "GET") writes.push(path);
      if (/\/(status|preview|reveal|access)$/.test(path))
        privateReads.push(path);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/comparison")) {
        comparisons.push(path);
        const output = outputs.find((item) => path.includes(`/${item.id}/`))!;
        return json({
          ...output,
          draftComparison: {
            state: output.id === "macbook" ? "unchanged" : "changed",
          },
        });
      }
      return json([]);
    }),
  );
  mount();
  const group = await screen.findByRole("article", {
    name: "分流配置 日常分流",
  });
  expect(within(group).getAllByText("未检查更新")).toHaveLength(2);
  expect(comparisons).toEqual([]);
  await scenario.click(() =>
    within(group).getByRole("button", {
      name: "检查 日常分流 的 2 个订阅更新",
    }),
  );
  const macbook = within(group).getByRole("row", {
    name: "客户端订阅 MacBook",
  });
  const android = within(group).getByRole("row", {
    name: "客户端订阅 Android",
  });
  await within(macbook).findByText(comparisonText(/与保存草稿一致.*上次核对/));
  await within(android).findByText(comparisonText(/有未发布修改.*上次核对/));
  expect(within(macbook).getByText("已发布")).toBeTruthy();
  expect(within(android).getByText("已发布")).toBeTruthy();
  expect(within(android).getByText("有未发布修改").tagName).toBe("STRONG");
  expect(
    within(android).getByText(comparisonText(/有未发布修改.*上次核对/))
      .textContent,
  ).toMatch(/^有未发布修改 上次核对 \d{4}\//);
  expect(within(macbook).getByText("与保存草稿一致").tagName).toBe("SPAN");
  expect(
    within(android).getByRole("button", { name: "查看修改" }),
  ).toBeTruthy();
  expect(
    within(android).queryByRole("button", { name: "检查更新" }),
  ).toBeNull();
  expect(
    within(macbook).getByRole("button", { name: "检查更新" }),
  ).toBeTruthy();
  expect(
    within(android).getByRole("button", { name: "获取订阅" }),
  ).toBeTruthy();
  expect(
    within(macbook).getByRole("button", { name: "获取订阅" }),
  ).toBeTruthy();
  const publishedState = within(android).getByText("已发布");
  expect(publishedState.tagName).toBe("SPAN");
  expect(publishedState.classList.contains("text-muted-foreground")).toBe(true);
  expect(publishedState.closest('[data-slot="badge"]')).toBeNull();
  expect(within(android).queryByText(/客户端已更新|已同步/)).toBeNull();
  await waitFor(() => expect(comparisons).toHaveLength(2));
  expect(privateReads).toEqual([]);
  expect(writes).toEqual([]);
});

it("replaces an older unchanged receipt when a newer private recheck fails", async (context) => {
  const scenario = ownedClickScenario(context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/comparison")) {
        const output = outputs.find((item) => path.includes(`/${item.id}/`))!;
        return json({ ...output, draftComparison: { state: "unchanged" } });
      }
      if (path.endsWith("/status")) return json({ detail: "offline" }, 503);
      return json([]);
    }),
  );
  mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 2 个订阅更新" }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByText(comparisonText(/与保存草稿一致.*上次核对/)),
    ).toHaveLength(2),
  );
  await scenario.click(() =>
    screen.getByRole("button", { name: "查看订阅 MacBook" }),
  );
  const dialog = screen.getByRole("dialog", { name: "MacBook 的订阅详情" });
  await within(dialog).findByText(
    "暂时无法比较已保存的修改。已发布内容未因此改变。",
  );
  await scenario.click(() =>
    within(dialog).getByRole("button", { name: "关闭" }),
  );
  await within(
    screen.getByRole("row", { name: "客户端订阅 MacBook" }),
  ).findByText(comparisonText(/暂时无法比较.*上次核对/));
  expect(
    within(screen.getByRole("row", { name: "客户端订阅 Android" })).getByText(
      comparisonText(/与保存草稿一致.*上次核对/),
    ),
  ).toBeTruthy();
});

it.for([false, true])(
  "invalidates only the explicitly published device, including a lost publication response (%s)",
  async (lostResponse, context) => {
    const scenario = ownedClickScenario(context);
    let inventory = outputs.map((output) => ({ ...output }));
    const publications: { path: string; body: unknown }[] = [];
    let comparisons = 0,
      previews = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/outputs")) return json(inventory);
        if (path.endsWith("/comparison")) {
          comparisons++;
          const output = inventory.find((item) =>
            path.includes(`/${item.id}/`),
          )!;
          return json({ ...output, draftComparison: { state: "changed" } });
        }
        if (path.endsWith("/preview")) {
          previews++;
          return json({
            valid: true,
            previewScope: "output-update",
            outputId: "macbook",
            previewDigest: "a".repeat(64),
            publicationEffect: { version: 1, link: "preserve" },
            artifacts: [],
          });
        }
        if (path.endsWith("/publish")) {
          publications.push({ path, body: JSON.parse(String(init?.body)) });
          inventory = inventory.map((output) =>
            output.id === "macbook"
              ? { ...output, revision: "macbook-after-publish" }
              : output,
          );
          return lostResponse
            ? json({ detail: "response lost" }, 503)
            : json(inventory[0]);
        }
        return json([]);
      }),
    );
    mount();
    await scenario.click(() =>
      screen.findByRole("button", {
        name: "检查 日常分流 的 2 个订阅更新",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByText(comparisonText(/有未发布修改.*上次核对/)),
      ).toHaveLength(2),
    );
    expect(publications).toHaveLength(0);
    await scenario.click(() =>
      within(
        screen.getByRole("row", { name: "客户端订阅 MacBook" }),
      ).getByRole("button", { name: "查看修改" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "检查订阅更新「MacBook」",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "确认更新「MacBook」",
    });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    expect(previews).toBe(1);
    expect(publications).toHaveLength(0);
    await scenario.click(() => confirm);
    await waitFor(() => expect(publications).toHaveLength(1));
    if (lostResponse) {
      await within(dialog).findByText(/response lost/);
      await scenario.click(() =>
        within(dialog).getByRole("button", { name: /取\s*消/ }),
      );
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "检查订阅更新「MacBook」" }),
      ).toBeNull(),
    );
    await within(
      screen.getByRole("row", { name: "客户端订阅 MacBook" }),
    ).findByText("未检查更新");
    expect(
      within(
        screen.getByRole("row", { name: "客户端订阅 Android" }),
      ).getByText(comparisonText(/有未发布修改.*上次核对/)),
    ).toBeTruthy();
    expect(publications).toEqual([
      {
        path: "/api/me/outputs/macbook/publish",
        body: { previewDigest: "a".repeat(64) },
      },
    ]);
    expect(comparisons).toBe(2);
  },
);

it("does not request deleted or reassigned devices and rejects mismatched comparison identities", async (context) => {
  const scenario = ownedClickScenario(context);
  let inventoryReads = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) {
        inventoryReads++;
        return json(inventoryReads === 1 ? outputs : [{ ...outputs[1] }]);
      }
      if (path.endsWith("/comparison")) {
        calls.push(path);
        return json({
          ...outputs[1],
          profileId: "another-profile",
          draftComparison: { state: "unchanged" },
        });
      }
      return json([]);
    }),
  );
  mount();
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 2 个订阅更新" }),
  );
  await screen.findByText("暂时无法比较");
  expect(calls).toEqual(["/api/me/outputs/android/comparison"]);
  expect(
    screen.queryByRole("row", { name: "客户端订阅 MacBook" }),
  ).toBeNull();
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
});

it("invalidates accepted-input evidence for recovery refresh but not read-only source verification", async (context) => {
  const scenario = ownedClickScenario(context);
  const source: Source = {
    id: "airport",
    name: "My airport",
    kind: "text",
    enabled: true,
    revision: "source-2",
    snapshot: { endpoints: [] },
    candidate: {
      id: "candidate-1",
      createdAt: "2026-10-23",
      diff: {
        beforeCount: 0,
        afterCount: 1,
        added: [{ id: "new", name: "New option" }],
        removed: [],
        renamed: [],
        connectionChanged: [],
      },
      affected: [],
    },
  };
  let finishRefresh!: (value: Response) => void;
  let comparisons = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/comparison")) {
        comparisons++;
        const output = outputs.find((item) => path.includes(`/${item.id}/`))!;
        return json({ ...output, draftComparison: { state: "unchanged" } });
      }
      if (path.endsWith("/candidate/reject"))
        return json({ detail: "related selection changed" }, 409);
      if (path.endsWith("/sources/airport")) return json(source);
      if (path.endsWith("/sources/airport/refresh"))
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      return json([]);
    }),
  );
  function ReviewEntry() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Review source</button>
        {open && (
          <SourceUpdateReview source={source} onClose={() => setOpen(false)} />
        )}
      </>
    );
  }
  const { client } = mount(<ReviewEntry />);
  await scenario.click(() =>
    screen.findByRole("button", { name: "检查 日常分流 的 2 个订阅更新" }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByText(comparisonText(/与保存草稿一致.*上次核对/)),
    ).toHaveLength(2),
  );
  await scenario.click(() =>
    screen.getByRole("button", { name: "Review source" }),
  );
  const dialog = screen.getByRole("dialog", { name: "查看变化" });
  await scenario.click(() =>
    within(dialog).getByRole("button", { name: "忽略本次更新" }),
  );
  await scenario.click(() =>
    within(dialog).findByRole("button", { name: "核对当前状态" }),
  );
  const refresh = await within(dialog).findByRole("button", {
    name: "重新获取来源",
  });
  expect(
    client
      .getQueryCache()
      .findAll({ queryKey: ["output-comparisons"] })
      .every((query) => !query.state.isInvalidated),
  ).toBe(true);
  await scenario.click(() => refresh);
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: ["output-comparisons"] })
        .every((query) => query.state.isInvalidated),
    ).toBe(true),
  );
  await act(async () =>
    finishRefresh(
      json({ ...source, revision: "source-3", candidate: undefined }),
    ),
  );
  await within(screen.getByRole("dialog", { name: "核对来源状态" })).findByText(
    "当前没有待检查内容",
  );
  expect(
    client
      .getQueryCache()
      .findAll({ queryKey: ["output-comparisons"] })
      .every((query) => query.state.isInvalidated),
  ).toBe(true);
  expect(comparisons).toBe(2);
});

it.for(["missing-revision", "missing-state"])(
  "never calls an incomplete comparison unchanged (%s)",
  async (failure, context) => {
    const scenario = ownedClickScenario(context);
    const output = {
      ...outputs[0],
      ...(failure === "missing-revision" ? { revision: undefined } : {}),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = String(url);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/outputs")) return json([output]);
        if (path.endsWith("/comparison"))
          return json({
            ...output,
            draftComparison:
              failure === "missing-state" ? {} : { state: "unchanged" },
          });
        return json([]);
      }),
    );
    mount();
    await scenario.click(() => singleCheckAction(scenario));
    await screen.findByText("暂时无法比较");
    expect(
      screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
    ).toBeNull();
  },
);

it("immediately stales a visible receipt after known inputs change even when its coarse query was already globally invalidated", async (context) => {
  const scenario = ownedClickScenario(context);
  let inventoryReads = 0,
    checks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) {
        inventoryReads++;
        return json([outputs[0]]);
      }
      if (path.endsWith("/comparison")) {
        checks++;
        return json({ ...outputs[0], draftComparison: { state: "unchanged" } });
      }
      return json([]);
    }),
  );
  const { client } = mount();
  await scenario.click(() => singleCheckAction(scenario));
  await screen.findByText(comparisonText(/与保存草稿一致.*上次核对/));
  client.setQueryData(["collections"], []);
  await act(async () => {
    await client.invalidateQueries({ refetchType: "none" });
  });
  expect(
    client.getQueryCache().findAll({ queryKey: ["output-comparisons"] })[0]
      ?.state.isInvalidated,
  ).toBe(true);
  expect(
    screen.getByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeTruthy();
  await act(async () => {
    invalidateOutputInputs(client);
    await client
      .fetchQuery({
        queryKey: ["collections"],
        queryFn: async () => {
          throw new Error("refresh failed");
        },
        retry: false,
      })
      .catch(() => {});
  });
  // No close, remount, list refresh or user-triggered recheck may be necessary.
  await screen.findByText("需要重新检查更新");
  expect(
    screen.queryByText(comparisonText(/与保存草稿一致.*上次核对/)),
  ).toBeNull();
  expect(inventoryReads).toBe(2);
  expect(checks).toBe(1);
});

it("settles an explicit check as unavailable if connectivity drops after inventory, without queuing a reconnect check", async (context) => {
  const scenario = ownedClickScenario(context);
  let inventoryReads = 0,
    checks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) {
        if (++inventoryReads === 2) onlineManager.setOnline(false);
        return json([outputs[0]]);
      }
      if (path.endsWith("/comparison")) {
        checks++;
        throw new TypeError("Network unavailable");
      }
      return json([]);
    }),
  );
  mount();
  const check = await singleCheckAction(scenario);
  await scenario.click(() => check);
  await screen.findByText("暂时无法比较");
  expect(
    (await singleCheckAction(scenario)).getAttribute("aria-disabled"),
  ).not.toBe("true");
  expect(checks).toBe(1);
  await act(async () => {
    onlineManager.setOnline(true);
  });
  expect(checks).toBe(1);
  expect(screen.getByText("暂时无法比较")).toBeTruthy();
});

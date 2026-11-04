// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage, UpdateOutput } from "./Subscriptions";
import type { ReactNode } from "react";
const summary = (chat: string, other: string) => ({
  version: 1 as const,
  kind: "basic" as const,
  chatGPT: { endpointId: "chat", label: chat },
  default: { endpointId: "other", label: other },
});
const output = {
  id: "one",
  name: "Daily",
  profileId: "profile",
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  status: "published",
  routingSummary: summary("Published UK", "Published Tokyo"),
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["overview", "outputs"] as const)("shows only the selected publication in %s and restores exact detail opener after repeated dismissal", async (view) => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([]);
      if (path.endsWith("/outputs"))
        return json([
          output,
          {
            ...output,
            id: "two",
            name: "Travel",
            routingSummary: summary("Travel UK", "Travel Tokyo"),
          },
        ]);
      if (path.endsWith("/one/status"))
        return json({ ...output, draftComparison: { state: "changed" } });
      if (path.endsWith("/two/status"))
        return json({
          ...output,
          id: "two",
          routingSummary: summary("Travel UK", "Travel Tokyo"),
          draftComparison: { state: "unchanged" },
        });
      throw new Error(`Unexpected ${path}`);
    }),
  );
  history.replaceState(null, "", view === "outputs" ? "#outputs" : "#subscriptions");
  mount(<SubscriptionsPage view={view} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Daily" }),
  );
  const region = await screen.findByRole("region", { name: "已发布分流" });
  const detail = screen.getByRole("dialog", { name: "Daily 的订阅详情" });
  const publicationState = within(detail).getByText("已发布", { exact: true });
  expect(
    publicationState.classList.contains("subscription-publication-state"),
  ).toBe(true);
  expect(publicationState.closest("[data-tone=success]")).toBeNull();
  expect(await within(region).findByText("Published UK")).toBeTruthy();
  expect(within(region).getByText("Published Tokyo")).toBeTruthy();
  expect(await screen.findByText("已保存的修改尚未发布")).toBeTruthy();
  expect(screen.getByRole("button", { name: "更多操作" })).toBeTruthy();
  expect(paths.filter((p) => p.endsWith("/status"))).toEqual([
    "/api/me/outputs/one/status",
  ]);
  expect(paths.some((p) => /reveal|access/.test(p))).toBe(false);
  const dailyOpener = screen.getByRole("button", { name: "查看订阅 Daily", hidden: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(dailyOpener));
    if (attempt === 0) {
      await userEvent.click(dailyOpener);
      await screen.findByRole("dialog", { name: "Daily 的订阅详情" });
    }
  }
  await userEvent.click(
    screen.getByRole("button", { name: "查看订阅 Travel" }),
  );
  const travel = await screen.findByRole("region", { name: "已发布分流" });
  expect(await within(travel).findByText("Travel UK")).toBeTruthy();
  expect(within(travel).queryByText("Published UK")).toBeNull();
  expect(screen.queryByText("已保存的修改尚未发布")).toBeNull();
  expect(await screen.findByText("与已保存草稿一致")).toBeTruthy();
  expect([...new Set(paths.filter((p) => p.endsWith("/status")))]).toEqual([
    "/api/me/outputs/one/status",
    "/api/me/outputs/two/status",
  ]);
  expect(paths.some((p) => /reveal|access/.test(p))).toBe(false);
});
it("reviews the server's frozen publication against its candidate, not cached output or profile labels", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        valid: true,
        previewDigest: "a".repeat(64),
        outputId: output.id,
        previewScope: "output-update",
        publicationEffect: { version: 1, link: "preserve" },
        publishedRoutingSummary: summary("Frozen UK", "Frozen Tokyo"),
        routingSummary: summary("Candidate US", "Candidate Osaka"),
        artifacts: [{ path: "config.yaml", content: "safe" }],
      }),
    ),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  const review = await screen.findByRole("region", { name: "分流比较" });
  expect(within(review).getByText("Frozen UK → Candidate US")).toBeTruthy();
  expect(
    within(review).getByText("Frozen Tokyo → Candidate Osaka"),
  ).toBeTruthy();
  expect(within(review).queryByText("Published UK")).toBeNull();
});
it.each([
  [undefined, "这份订阅暂无可用的分流摘要。"],
  [{ version: 1, kind: "advanced" }, "这份高级配置暂无可用的分流详情。"],
  [
    { version: 1, kind: "native-override" },
    "使用原生配置覆盖，无法提供可靠的分流摘要。",
  ],
  [{ version: 1, kind: "nodes-only" }, "纯节点订阅，仅交付连接。"],
])(
  "does not invent basic selections for an unavailable or non-basic summary",
  async (routingSummary, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/overview"))
          return json({ user: {}, routes: [] });
        if (String(url).endsWith("/status"))
          return json({
            ...output,
            routingSummary,
            draftComparison: { state: "unavailable" },
          });
        if (String(url).endsWith("/profiles")) return json([]);
        return json([{ ...output, routingSummary }]);
      }),
    );
    mount(<SubscriptionsPage navigate={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "查看订阅 Daily" }),
    );
    const region = await screen.findByRole("region", { name: "已发布分流" });
    expect(within(region).getByText(message)).toBeTruthy();
    expect(
      await screen.findByText(
        "暂时无法比较已保存的修改。已发布内容未因此改变。",
      ),
    ).toBeTruthy();
    expect(within(region).queryByText("ChatGPT")).toBeNull();
    expect(within(region).queryByText("Published UK")).toBeNull();
  },
);
it("keeps published routing available when saved-change comparison fails and offers retry", async () => {
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).endsWith("/overview"))
        return json({ user: {}, routes: [] });
      if (String(url).endsWith("/status")) {
        if (fail) throw new TypeError("Offline");
        return json({ ...output, draftComparison: { state: "changed" } });
      }
      if (String(url).endsWith("/profiles")) return json([]);
      return json([output]);
    }),
  );
  mount(<SubscriptionsPage navigate={() => {}} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Daily" }),
  );
  const retry = await screen.findByRole("button", { name: "重新检查更新" });
  const region = screen.getByRole("region", { name: "已发布分流" });
  expect(within(region).getByText("Published UK")).toBeTruthy();
  expect(screen.queryByText("已保存的修改尚未发布")).toBeNull();
  fail = false;
  await userEvent.click(retry);
  expect(await screen.findByText("已保存的修改尚未发布")).toBeTruthy();
});

it("keeps a legacy publication unknown during review instead of filling it from the cached output", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        valid: true,
        previewDigest: "a".repeat(64),
        outputId: output.id,
        previewScope: "output-update",
        publicationEffect: { version: 1, link: "preserve" },
        routingSummary: summary("New UK", "New Tokyo"),
        artifacts: [{ path: "config.yaml", content: "safe" }],
      }),
    ),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  const review = await screen.findByRole("region", { name: "分流比较" });
  expect(within(review).getByText("这份订阅暂无可用的分流摘要。")).toBeTruthy();
  expect(within(review).getByText("New UK")).toBeTruthy();
  expect(within(review).queryByText("Published UK")).toBeNull();
});

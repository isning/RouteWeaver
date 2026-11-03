// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfilePublicationDialog, UpdateOutput } from "./Subscriptions";
import { RoutingReview } from "./RoutingSummary";
import type { Profile, RoutingSummary } from "./types";
import type { ReactNode } from "react";
const output = {
  id: "one",
  name: "日常",
  profileId: "profile",
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  status: "published",
};
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

it("keeps the reviewed unchanged URL and other-subscription scope visible before confirming one update", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            valid: true,
            outputId: output.id,
            previewScope: "output-update",
            previewDigest: "a".repeat(64),
            publicationEffect: { version: 1, link: "preserve" },
            artifacts: [],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  expect(screen.queryByText("链接不变，其他订阅不受影响。")).toBeNull();
  expect(screen.getByText(/mihomo 1.19.32/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "确认更新「日常」" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  const consequence = await screen.findByText("链接不变，其他订阅不受影响。");
  expect(
    screen.getByRole("group", { name: "更新确认" }).contains(consequence),
  ).toBe(true);
  expect(
    screen
      .getByRole("group", { name: "更新确认" })
      .contains(screen.getByRole("button", { name: "确认更新「日常」" })),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "确认更新「日常」" }),
  ).toHaveProperty("disabled", false);
});

it("discloses the reviewed replacement access link before publishing a revoked subscription", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            valid: true,
            outputId: output.id,
            previewScope: "output-update",
            previewDigest: "a".repeat(64),
            publicationEffect: { version: 1, link: "replace" },
            artifacts: [],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  mount(
    <UpdateOutput
      output={{ ...output, status: "revoked" }}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByText(/在客户端换用新链接/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「日常」" }),
  ).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  const consequence = await screen.findByText(
    "发布后请在客户端换用新链接，其他订阅不受影响。",
  );
  expect(
    screen.getByRole("group", { name: "更新确认" }).contains(consequence),
  ).toBe(true);
  expect(
    screen
      .getByRole("group", { name: "更新确认" })
      .contains(
        screen.getByRole("button", { name: "重新发布并生成新链接「日常」" }),
      ),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "重新发布并生成新链接「日常」" }),
  ).toHaveProperty("disabled", false);
  expect(screen.queryByText("链接不变，其他订阅不受影响。")).toBeNull();
});
it("does not present equal summary fields as a complete content comparison", () => {
  const summary: RoutingSummary = {
    version: 1,
    kind: "advanced",
    advanced: {
      defaultAction: { kind: "direct" },
      ruleCount: 2,
      groupCount: 0,
      nodeCount: 3,
    },
  };
  render(<RoutingReview published={summary} candidate={summary} />);
  expect(screen.getByRole("heading", { name: "分流摘要" })).toBeTruthy();
  expect(screen.getByText("摘要字段相同，不代表配置未变化。")).toBeTruthy();
  expect(
    screen
      .getByText("未比较具体规则、策略组内容和节点设置。")
      .closest("details"),
  ).toBeNull();
});

it("offers saved draft targets without repeated selection teaching", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify([output]), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  const profile = {
    id: "profile",
    name: "工作",
    target: output.target,
  } as Profile;
  mount(<ProfilePublicationDialog profile={profile} onClose={() => {}} />);
  expect(screen.getByRole("dialog", { name: "选择客户端订阅" })).toBeTruthy();
  expect(screen.getByText("草稿已保存", { exact: true, selector: '[role="status"]' })).toBeTruthy();
  expect(
    await screen.findByRole("radio", { name: /更新「日常」/ }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "返回编辑" })).toBeTruthy();
  expect(screen.queryByText(/选择一个已有订阅来检查更新/)).toBeNull();
});

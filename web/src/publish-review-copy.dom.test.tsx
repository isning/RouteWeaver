// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateOutput } from "./Subscriptions";
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
it("makes rechecking secondary after a compatible review without repeating the preview heading", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        valid: true,
        previewDigest: "a".repeat(64),
        previewScope: "output-update",
        outputId: output.id,
        publicationEffect: { version: 1, link: "preserve" },
        artifacts: [],
      }),
    ),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  expect(screen.queryByText(/链接不变，其他订阅不受影响。/)).toBeNull();
  expect(screen.getByText("mihomo 1.19.32 · 完整配置")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "兼容检查通过。",
  );
  const decision = within(screen.getByRole("group", { name: "更新确认" }));
  expect(decision.getByText("链接不变，其他订阅不受影响。")).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "此订阅的更新预览" }),
  ).toBeNull();
  expect(
    decision.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", false);
  await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
  expect(await screen.findByRole("button", { name: "重新检查" })).toBeTruthy();
});

it("keeps an incompatible revoked-output review blocked without an unapproved link promise", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        valid: false,
        previewDigest: "a".repeat(64),
        outputId: output.id,
        previewScope: "output-update",
        publicationEffect: { version: 1, link: "replace" },
        diagnostics: ["Unsupported routing option"],
        artifacts: [],
      }),
    ),
  );
  mount(
    <UpdateOutput
      output={{ ...output, status: "revoked" }}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByText(/生成新的访问链接/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
  expect(screen.queryByText(/链接不变/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "兼容检查未通过，已发布内容保持不变。",
  );
  expect(screen.getByText("Unsupported routing option")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新检查" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "重新发布并生成新链接「Daily」" }),
  ).toHaveProperty("disabled", true);
});

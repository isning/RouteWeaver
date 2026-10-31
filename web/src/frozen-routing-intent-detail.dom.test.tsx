// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { FrozenRoutingIntent } from "./types";

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
  const computedStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computedStyle(element),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads frozen rules only from the selected owner status, never from a saved draft or access link", async () => {
  const paths: string[] = [];
  const frozen: FrozenRoutingIntent = {
    version: 1,
    kind: "portable",
    ruleCount: 1,
    omittedRuleCount: 0,
    rules: [
      {
        id: "chat",
        match: {
          state: "exact",
          expression: { op: "domain-suffix", value: "chatgpt.com" },
        },
        action: { kind: "endpoint", ref: "tokyo", label: "东京-已发布" },
      },
    ],
    defaultAction: { kind: "endpoint", ref: "hk", label: "香港-已发布" },
  };
  const output = {
    id: "one",
    name: "我的 MacBook",
    profileId: "profile",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    status: "published",
    routingSummary: {
      version: 1,
      kind: "advanced",
      advanced: {
        defaultAction: { kind: "endpoint", label: "香港-已发布" },
        ruleCount: 1,
        groupCount: 0,
        nodeCount: 3,
      },
    },
  };
  const profile = { ...emptyProfile(), id: "profile", name: "日常分流" };
  profile.ir.rules = [
    {
      id: "chat",
      match: { op: "domain-suffix", value: "chatgpt.com" },
      action: { kind: "endpoint", ref: "london" },
    },
  ];
  profile.ir.defaultAction = { kind: "endpoint", ref: "london" };
  profile.ir.endpoints = [
    {
      id: "london",
      name: "伦敦-当前草稿",
      origin: "imported",
      connection: { protocol: "socks", host: "192.0.2.10", port: 1080 },
    },
  ];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/one/status"))
        return json({
          ...output,
          routingIntent: frozen,
          draftComparison: { state: "changed" },
        });
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
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
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 我的 MacBook" }),
  );
  const detail = await screen.findByRole("region", { name: "已发布分流" });
  expect(await within(detail).findByText("域名后缀 chatgpt.com")).toBeTruthy();
  expect(within(detail).getByText("节点「东京-已发布」")).toBeTruthy();
  expect(within(detail).getByText("节点「香港-已发布」")).toBeTruthy();
  expect(within(detail).queryByText(/伦敦|未保存具体规则/)).toBeNull();
  expect(await screen.findByText("已保存的修改尚未发布")).toBeTruthy();
  expect(paths.filter((path) => path.endsWith("/status"))).toEqual([
    "/api/me/outputs/one/status",
  ]);
  expect(paths.some((path) => /\/reveal|\/access|\/feed\//.test(path))).toBe(
    false,
  );
});

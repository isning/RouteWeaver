// @vitest-environment jsdom
// Same GET fixture as browser; real App task/focus smoke, not layout evidence.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
import { setCSRF, setToken } from "./api";
import {
  historyLegacyFixtures,
  historyLegacyName as name,
} from "../tests/history-legacy-fixture";
// Load the real lazy module before interaction timing starts.
beforeAll(async () => {
  await import("./Admin");
});
let client: QueryClient;
let unexpected: string[];
beforeEach(() => {
  setCSRF("");
  setToken("");
  vi.stubEnv("NODE_ENV", "development");
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
  unexpected = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, "http://localhost").pathname;
      const key = path.startsWith("/api/") ? path.slice(4) : path;
      const method = init?.method || "GET";
      if (method !== "GET" || !(key in historyLegacyFixtures)) {
        unexpected.push(`${method} ${key}`);
        return new Response(
          JSON.stringify({ message: "Unexpected controlled request" }),
          { status: 503 },
        );
      }
      return new Response(JSON.stringify(historyLegacyFixtures[key]), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(route: string) {
  history.replaceState(null, "", `#${route}`);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <App />
      </UIProviders>
    </QueryClientProvider>,
  );
}
it("opens the historical record from the real App and returns focus after repeated keyboard close", async () => {
  mount("activity");
  const user = userEvent.setup();
  const opener = await screen.findByRole("button", { name: "查看" });
  for (let n = 0; n < 2; n++) {
    await user.click(opener);
    const detail = await screen.findByRole("dialog", {
      name: `${name} · 生成记录`,
    });
    expect(
      within(detail).getByText(
        "此处展示当时保存的配置记录。检查当前配置请重新校验；服务器应用情况请查看节点确认状态。",
      ),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  }
  expect(unexpected).toEqual([]);
});
it("opens the legacy route editor from the real App and preserves draft and exact Close focus on canceled discard", async () => {
  mount("legacy-routes");
  const user = userEvent.setup();
  const opener = await screen.findByRole("button", {
    name: new RegExp(`^${name}`),
  });
  await user.click(opener);
  const editor = await screen.findByRole("dialog", {
    name: `编辑链路配置 ${name}`,
  });
  const field = within(editor).getByRole("textbox", { name: "链路配置名称" });
  await user.clear(field);
  await user.type(field, "保留的跨区域链路草稿");
  const close = within(editor).getByRole("button", { name: "关闭" });
  for (let n = 0; n < 2; n++) {
    await user.click(close);
    const review = await screen.findByRole("alertdialog", {
      name: "放弃未保存的链路配置修改？",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(review).getByRole("button", { name: "继续编辑" }),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((field as HTMLInputElement).value).toBe("保留的跨区域链路草稿");
  }
  expect(unexpected).toEqual([]);
});

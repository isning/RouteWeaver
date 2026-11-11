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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { TemplatesPage } from "./Templates";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["processing-preset", "client-profile"])(
  "distinguishes same-named %s targets before explicit apply and preserves cancellation",
  async (kind) => {
    const template = {
      id: "template",
      name: "整理模板",
      kind,
      version: 1,
      spec: { steps: [] },
    };
    const targets = [
      { id: "target-first", name: "日常使用", ir: { resources: [] } },
      { id: "target-second", name: "日常使用", ir: { resources: [] } },
      { id: "target-unique", name: "独立草稿", ir: { resources: [] } },
    ];
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return json({});
        }
        if (
          url === "/api/templates" ||
          url === "/api/templates/template/versions"
        )
          return json([template]);
        if (
          url ===
          (kind === "processing-preset"
            ? "/api/me/collections"
            : "/api/me/profiles")
        )
          return json(targets);
        return json([]);
      }),
    );
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <TemplatesPage />
        </UIProviders>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "查看并使用" }));
    let dialog = await screen.findByRole("dialog", { name: "整理模板" });
    await user.click(
      within(dialog).getByRole("combobox", { name: "模板目标" }),
    );
    expect(
      await screen.findByRole("option", { name: "日常使用 target-first" }),
    ).toBeTruthy();
    const second = screen.getByRole("option", {
      name: "日常使用 target-second",
    });
    expect(screen.getByRole("option", { name: "独立草稿" }).textContent).toBe(
      "独立草稿",
    );
    await user.click(second);
    const selected = () =>
      within(dialog).getByRole("combobox", { name: "模板目标" });
    expect(selected().textContent).toBe("日常使用 target-second");
    expect(writes).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(selected().textContent).toBe("日常使用 target-second");
    expect(writes).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(await screen.findByRole("button", { name: "放弃选择" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "整理模板" })).toBeNull(),
    );
    expect(writes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "查看并使用" }));
    dialog = await screen.findByRole("dialog", { name: "整理模板" });
    await user.click(selected());
    await user.click(
      await screen.findByRole("option", { name: "日常使用 target-second" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "应用模板到草稿" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        {
          version: 1,
          mode: "copy",
          targetId: "target-second",
          bindings: { endpoints: {}, resources: {} },
        },
      ]),
    );
  },
);

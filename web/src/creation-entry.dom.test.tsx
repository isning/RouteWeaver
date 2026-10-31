// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  // rc-component test mode shares one overlay ID; real React IDs preserve
  // the same nested-dialog accessible names used by the browser.
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(["pending", "error", "profiles-error", "outputs-error"])(
  "allows an explicitly requested local draft while inventory is %s without a write or a false empty state",
  async (state) => {
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method && init.method !== "GET") writes.push(path);
        if (path.endsWith("/overview"))
          return json({ status: "active", routes: [] });
        if (path.endsWith("/profiles") || path.endsWith("/outputs")) {
          if (state === "pending") return new Promise<Response>(() => {});
          const failed =
            state === "error" ||
            (state === "profiles-error" && path.endsWith("/profiles")) ||
            (state === "outputs-error" && path.endsWith("/outputs"));
          return failed
            ? json({ error: "Inventory unavailable" }, 503)
            : json([]);
        }
        return json([]);
      }),
    );
    mount();
    if (state === "pending")
      await screen.findByText("正在加载配置与客户端订阅…");
    else
      await screen.findByText(
        state === "outputs-error"
          ? "暂时无法加载客户端订阅"
          : "暂时无法加载分流配置",
      );
    if (state === "error") {
      await screen.findByText("暂时无法加载客户端订阅");
      for (const alert of screen.getAllByRole("alert"))
        expect(alert.textContent).not.toContain("仍可");
    }
    expect(screen.queryByText("暂无订阅")).toBeNull();
    expect(screen.queryByLabelText("配置名称")).toBeNull();
    const create = screen.getByRole("button", {
      name: "新建分流配置",
    });
    expect(
      screen.getAllByRole("button", { name: "新建分流配置" }),
    ).toHaveLength(1);
    await userEvent.click(create);
    await screen.findByLabelText("配置名称", { exact: true });
    expect(writes).toEqual([]);
  },
);

it("keeps one focused creation button across pending, error, empty and nonempty inventory without replacing the node", async () => {
  let state: "pending" | "error" | "empty" | "nonempty" = "pending";
  const release: Array<() => void> = [];
  const saved = {
    ...emptyProfile(),
    id: "saved",
    name: "Existing configuration",
  };
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method && init.method !== "GET") writes.push(path);
      if (path.endsWith("/overview"))
        return json({ status: "active", routes: [] });
      if (path.endsWith("/profiles") || path.endsWith("/outputs")) {
        if (state === "pending")
          await new Promise<void>((resolve) => release.push(resolve));
        if (state === "error")
          return json({ error: "Inventory unavailable" }, 503);
        return json(
          state === "nonempty" && path.endsWith("/profiles") ? [saved] : [],
        );
      }
      return json([]);
    }),
  );
  mount();
  await screen.findByText("正在加载配置与客户端订阅…");
  const create = screen.getByRole("button", {
    name: "新建分流配置",
  });
  create.focus();
  state = "error";
  release.forEach((resolve) => resolve());
  await screen.findByText("暂时无法加载分流配置");
  const stable = () => {
    expect(screen.getAllByRole("button", { name: "新建分流配置" })).toEqual([
      create,
    ]);
    expect(document.activeElement).toBe(create);
  };
  stable();
  expect(screen.queryByText("暂无订阅")).toBeNull();
  expect(screen.getByRole("button", { name: "重新核对订阅" })).toBeTruthy();
  state = "empty";
  fireEvent.click(screen.getByRole("button", { name: "重试配置" }));
  fireEvent.click(screen.getByRole("button", { name: "重新核对订阅" }));
  await screen.findByText("暂无订阅");
  stable();
  expect(screen.queryByText("暂时无法加载分流配置")).toBeNull();
  state = "nonempty";
  await client.invalidateQueries({ queryKey: ["profiles"] });
  await screen.findByRole("article", {
    name: "分流配置 Existing configuration",
  });
  stable();
  expect(screen.queryByLabelText("配置名称")).toBeNull();
  expect(writes).toEqual([]);
});

it("does not replace a requested inaccessible scope while a new local draft is opened and discarded", async () => {
  history.replaceState(null, "", "#subscriptions?profile=unavailable");
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method && init.method !== "GET") writes.push(String(url));
      return json(
        String(url).endsWith("/overview")
          ? { status: "active", routes: [] }
          : [],
      );
    }),
  );
  mount();
  await screen.findByText("当前范围内没有可访问的配置或订阅");
  await userEvent.click(screen.getByRole("button", { name: "新建分流配置" }));
  const name = await screen.findByLabelText("配置名称", { exact: true });
  await userEvent.clear(name);
  await userEvent.type(name, "Unsaved scoped draft");
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  await userEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(
    (screen.getByLabelText("配置名称", { exact: true }) as HTMLInputElement)
      .value,
  ).toBe("Unsaved scoped draft");
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
  await screen.findByText("当前范围内没有可访问的配置或订阅");
  expect(location.hash).toBe("#subscriptions?profile=unavailable");
  expect(writes).toEqual([]);
});

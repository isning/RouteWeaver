// @vitest-environment jsdom
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
import { PublishOutput, SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { OutputCreation } from "./types";

type Attempt = OutputCreation & { previewDigest: string };
type ReadState = "ready" | "pending" | "paused" | "error" | "missing";
const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixture(
  options: {
    page?: boolean;
    create?: (body: Attempt, number: number) => Promise<Response>;
    read?: (number: number) => Promise<Response>;
  } = {},
) {
  const creates: Attempt[] = [],
    previews: OutputCreation[] = [],
    access: string[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/overview")
        return json({ status: "active", routes: [] });
      if (path === "/api/me/profiles") return json([profile]);
      if (path === "/api/me/outputs/preview") {
        previews.push(body);
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `review-${body.id}`,
          artifacts: [{ path: "config.json", content: "reviewed" }],
        });
      }
      if (path === "/api/me/outputs" && method === "POST") {
        creates.push(body);
        return options.create
          ? options.create(body, creates.length)
          : json({ message: "Unknown creation" }, 503);
      }
      if (path === "/api/me/outputs") {
        reads++;
        return options.read ? options.read(reads) : json([]);
      }
      if (path.endsWith("/access")) {
        access.push(path);
        return json({ feedPath: "/feed/retry-test" });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const close = vi.fn();
  const tree = (state: ReadState) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        {options.page ? (
          <SubscriptionsPage />
        ) : (
          <PublishOutput
            profile={profile}
            sessionId="opening-A"
            profileRead={{ state, retry: () => {} }}
            onClose={close}
          />
        )}
      </UIProviders>
    </QueryClientProvider>
  );
  const mounted = render(tree("ready"));
  return {
    creates,
    previews,
    access,
    close,
    reads: () => reads,
    // Public component input transition; no private React/Form state mutation.
    readState: (state: ReadState) => mounted.rerender(tree(state)),
  };
}
async function task() {
  const dialog = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  return { dialog, ui: within(dialog) };
}
async function review(name = "Daily") {
  const { ui } = await task();
  const input = await ui.findByRole("textbox", { name: "订阅名称" });
  await waitFor(() => expect(input).toHaveProperty("value", "Daily"));
  if (name !== "Daily") {
    await userEvent.clear(input);
    await userEvent.type(input, name);
  }
  await userEvent.click(ui.getByRole("button", { name: "检查发布内容" }));
  await ui.findByText("兼容检查通过。");
  return ui;
}
async function publish(name = "Daily") {
  const ui = await review(name);
  await userEvent.click(
    ui.getByRole("button", { name: `创建并发布「${name}」` }),
  );
  return ui;
}
async function settled(ui: ReturnType<typeof within>) {
  await ui.findByRole("status", { name: "上次发布待确认" });
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "核对上次发布结果" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
}
function singleFooterRetry(ui: ReturnType<typeof within>) {
  expect(ui.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(ui.getAllByRole("button", { name: "重试上次发布" })).toHaveLength(1);
  const retry = ui.getByRole("button", { name: "重试上次发布" });
  expect(retry.closest("[data-slot=dialog-footer]")).not.toBeNull();
  expect(
    ui
      .getByRole("button", { name: "核对上次发布结果" })
      .closest("[data-slot=dialog-footer]"),
  ).toBeNull();
  return retry;
}

it("offers one explicit frozen retry in the footer and keeps GET recovery in the pending section", async () => {
  const f = fixture();
  const ui = await publish();
  await settled(ui);
  const retry = singleFooterRetry(ui);
  expect(retry).toHaveProperty("disabled", false);
  await userEvent.click(retry);
  await settled(ui);
  expect(f.creates).toHaveLength(2);
  expect(f.creates[1]).toEqual(f.creates[0]);
  expect(f.creates[0]).toEqual({
    ...f.previews[0],
    previewDigest: `review-${f.previews[0].id}`,
  });
  expect(f.previews).toHaveLength(1);
});

it("retries the frozen body without a current preview after replay409 and an unavailable receipt lookup", async () => {
  const f = fixture({
    create: async (_body, n) =>
      json(
        { message: n === 2 ? "Replay conflict" : "Unknown creation" },
        n === 2 ? 409 : 503,
      ),
    read: async (n) => {
      if (n === 2) throw new TypeError("Lookup unavailable");
      return json([]);
    },
  });
  const ui = await publish();
  await settled(ui);
  await userEvent.click(singleFooterRetry(ui));
  await ui.findByText("Replay conflict");
  await settled(ui);
  expect(ui.queryByText("兼容检查通过。")).toBeNull();
  expect(ui.queryByText("发布前的兼容检查已通过。")).toBeNull();
  expect(ui.queryByRole("heading", { name: "发布前的检查结果" })).toBeNull();
  expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(ui.queryByRole("button", { name: "检查发布内容" })).toBeNull();
  const retry = singleFooterRetry(ui);
  expect(retry).toHaveProperty("disabled", false);
  await userEvent.click(retry);
  await settled(ui);
  expect(f.creates).toHaveLength(3);
  expect(f.creates[1]).toEqual(f.creates[0]);
  expect(f.creates[2]).toEqual(f.creates[0]);
  expect(f.previews).toHaveLength(1);
  expect(f.close).not.toHaveBeenCalled();
});

it("keeps ordinary invalid fresh-form validation and the delivery-neutral fresh-create consequence", async () => {
  const f = fixture();
  const { ui } = await task();
  const input = ui.getByRole("textbox", { name: "订阅名称" });
  await waitFor(() => expect(input).toHaveProperty("value", "Daily"));
  await userEvent.clear(input);
  await userEvent.click(ui.getByRole("button", { name: "检查发布内容" }));
  await within(input.closest("[data-slot=field]") as HTMLElement).findByText(
    "请输入订阅名称",
  );
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(ui.getByText("创建独立的客户端订阅，其他订阅保留原版本。")).toBeTruthy();
  expect(ui.queryByRole("button", { name: "重试上次发布" })).toBeNull();
  expect(f.previews).toEqual([]);
  expect(f.creates).toEqual([]);
});

it.each(["pending", "paused", "error", "missing"] as const)(
  "keeps the single frozen retry disabled during profile %s while GET recovery remains available",
  async (state) => {
    const f = fixture();
    const ui = await publish();
    await settled(ui);
    f.readState(state);
    const retry = singleFooterRetry(ui);
    expect(retry).toHaveProperty("disabled", true);
    await userEvent.click(retry);
    expect(f.creates).toHaveLength(1);
    const reads = f.reads();
    await userEvent.click(ui.getByRole("button", { name: "核对上次发布结果" }));
    await ui.findByText("尚未确认上次发布结果，请稍后继续核对。");
    await settled(ui);
    expect(f.reads()).toBe(reads + 1);
    expect(f.creates).toHaveLength(1);
    f.readState("ready");
    expect(singleFooterRetry(ui)).toHaveProperty("disabled", false);
    await userEvent.click(singleFooterRetry(ui));
    await settled(ui);
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]).toEqual(f.creates[0]);
    expect(f.previews).toHaveLength(1);
  },
);

it.each(["success", "conflict"] as const)(
  "does not let a departed frozen retry's late %s settle a newer public opening",
  async (outcome) => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      page: true,
      create: async (body, n) => {
        if (n === 1) return json({ message: "Unknown creation" }, 503);
        if (n === 2) return held;
        return json({
          ...body,
          status: "published",
          creationReviewDigest: body.previewDigest,
        });
      },
    });
    try {
      await userEvent.click(
        await screen.findByRole("button", { name: "为 Daily 新增客户端订阅" }),
      );
      const old = await publish("Old phone");
      await settled(old);
      await userEvent.click(singleFooterRetry(old));
      await waitFor(() => expect(f.creates).toHaveLength(2));
      expect(f.creates[1]).toEqual(f.creates[0]);
      expect(singleFooterRetry(old)).toHaveProperty("disabled", true);
      act(() => {
        history.replaceState(null, "", "#subscriptions?profile=saved-profile");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "新增客户端订阅" }),
        ).toBeNull(),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "为 Daily 新增客户端订阅" }),
      );
      const newer = await review("New tablet");
      expect(f.previews).toHaveLength(2);
      expect(f.previews[1].id).not.toBe(f.previews[0].id);
      await act(async () => {
        release(
          outcome === "success"
            ? json({
                ...f.creates[0],
                status: "published",
                creationReviewDigest: f.creates[0].previewDigest,
              })
            : json({ message: "Late old conflict" }, 409),
        );
        await held;
      });
      expect(newer.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
        "value",
        "New tablet",
      );
      expect(newer.queryByRole("button", { name: "重试上次发布" })).toBeNull();
      expect(newer.queryByText("Late old conflict")).toBeNull();
      expect(
        newer.getByRole("button", { name: "创建并发布「New tablet」" }),
      ).toHaveProperty("disabled", false);
      expect(f.access).toEqual([]);
      expect(f.creates).toHaveLength(2);
      await userEvent.click(
        newer.getByRole("button", { name: "创建并发布「New tablet」" }),
      );
      await screen.findByRole("dialog", { name: "获取「New tablet」" });
      await waitFor(() =>
        expect(f.access).toEqual([
          `/api/me/outputs/${f.previews[1].id}/access`,
        ]),
      );
      expect(f.creates).toHaveLength(3);
      expect(f.creates[2]).toEqual({
        ...f.previews[1],
        previewDigest: `review-${f.previews[1].id}`,
      });
    } finally {
      release(json({ message: "Released fixture" }, 503));
    }
  },
);

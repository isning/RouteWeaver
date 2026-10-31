// @vitest-environment jsdom
// Public-page late-result ownership regressions; staged pending approval.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { OutputCreation } from "./types";

const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
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
  try {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["post-success", "post-failure", "post-conflict", "receipt"] as const)(
  "keeps the newer creation task when the departed task's %s settles",
  async (outcome) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const creates: (OutputCreation & { previewDigest: string })[] = [];
    const previews: OutputCreation[] = [];
    const accessReads: string[] = [];
    let holdReceipt = false;
    let receiptStarted = false;
    let finish!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      finish = resolve;
    });
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
          if (creates.length === 1) {
            if (outcome === "receipt") throw new TypeError("response lost");
            return held;
          }
          return json({
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          });
        }
        if (path === "/api/me/outputs") {
          if (holdReceipt) {
            receiptStarted = true;
            return held;
          }
          return json([]);
        }
        if (path.endsWith("/access") && method === "GET") {
          accessReads.push(path);
          return json({ feedPath: "/feed/newer-task" });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <SubscriptionsPage />
        </UIProviders>
      </QueryClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "为 Daily 新增客户端订阅" }),
    );
    fireEvent.change(await screen.findByLabelText("订阅名称"), {
      target: { value: "Departed phone" },
    });
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("兼容检查通过。");
    await userEvent.click(
      screen.getByRole("button", { name: "创建并发布「Departed phone」" }),
    );
    await waitFor(() => expect(creates).toHaveLength(1));
    if (outcome === "receipt") {
      const recover = await screen.findByRole("button", {
        name: "核对上次发布结果",
      });
      await waitFor(() => expect(recover).toHaveProperty("disabled", false));
      holdReceipt = true;
      await userEvent.click(recover);
      await waitFor(() => expect(receiptStarted).toBe(true));
    }
    // Real standalone page navigation boundary, not a private task setter.
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
    fireEvent.change(await screen.findByLabelText("订阅名称"), {
      target: { value: "Newer tablet" },
    });
    for (const [label, option] of [
      ["目标客户端", "sing-box 1.14.3"],
      ["输出内容", "纯节点输出"],
    ]) {
      await userEvent.click(screen.getByRole("combobox", { name: label }));
      await userEvent.click(
        await screen.findByRole("option", { name: option }),
      );
    }
    await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
    await screen.findByText("兼容检查通过。");
    expect(previews).toHaveLength(2);
    expect(previews[1].id).not.toBe(previews[0].id);
    const oldReceipt = {
      ...creates[0],
      status: "published",
      creationReviewDigest: creates[0].previewDigest,
    };
    // Settling an already-dispatched request is not cancellation of server work.
    await act(async () => {
      finish(
        outcome === "post-failure"
          ? json({ message: "Unavailable" }, 503)
          : outcome === "post-conflict"
            ? json({ message: "Review changed" }, 409)
            : outcome === "receipt"
              ? json([oldReceipt])
              : json(oldReceipt),
      );
      await held;
    });
    const task = screen.getByRole("dialog", { name: "新增客户端订阅" });
    expect(
      within(task).getByRole("textbox", { name: "订阅名称" }),
    ).toHaveProperty("value", "Newer tablet");
    expect(
      within(task).getByRole("combobox", { name: "目标客户端" })?.textContent,
    ).toContain("sing-box 1.14.3");
    expect(
      within(task).getByRole("combobox", { name: "输出内容" })?.textContent,
    ).toContain("纯节点输出");
    expect(within(task).getByText("兼容检查通过。")).toBeTruthy();
    expect(within(task).queryByText("上次发布待确认")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "获取「Departed phone」" }),
    ).toBeNull();
    expect(accessReads).toEqual([]);
    expect(creates).toHaveLength(1);
    await userEvent.click(
      within(task).getByRole("button", { name: "创建并发布「Newer tablet」" }),
    );
    await screen.findByRole("dialog", { name: "获取「Newer tablet」" });
    await waitFor(() =>
      expect(accessReads).toEqual([`/api/me/outputs/${previews[1].id}/access`]),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual({
      ...previews[1],
      previewDigest: `review-${previews[1].id}`,
    });
    expect(previews).toHaveLength(2);
  },
);

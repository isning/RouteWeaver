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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishOutput } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { OutputCreation } from "./types";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
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

it("explains an uncertain subscription publication once and identifies recovery as the same submission", async () => {
  const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
  const close = vi.fn();
  const previews: OutputCreation[] = [];
  const creates: (OutputCreation & { previewDigest: string })[] = [];
  let receiptReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview" && method === "POST") {
        previews.push(body);
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "phone-review",
          artifacts: [{ path: "config.json", content: "reviewed" }],
        });
      }
      if (path === "/api/me/outputs" && method === "POST") {
        creates.push(body);
        return json(
          { message: "Controlled creation response unavailable" },
          503,
        );
      }
      if (path === "/api/me/outputs" && method === "GET") {
        receiptReads++;
        return json([]);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishOutput profile={profile} onClose={close} />
      </UIProviders>
    </QueryClientProvider>,
  );
  const task = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  const ui = within(task);
  await waitFor(() =>
    expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
      "value",
      "Daily",
    ),
  );
  await userEvent.clear(ui.getByRole("textbox", { name: "订阅名称" }));
  await userEvent.type(ui.getByRole("textbox", { name: "订阅名称" }), "Phone");
  expect(ui.getByText("创建新的客户端订阅，其他订阅不变。")).toBeTruthy();
  await userEvent.click(ui.getByRole("button", { name: "检查发布内容" }));
  await ui.findByText("兼容检查通过。");
  await userEvent.click(
    ui.getByRole("button", { name: "创建并发布「Phone」" }),
  );
  await ui.findByRole("button", { name: "核对上次发布结果" });
  // Wait for the completed mutation's public control state, not a request promise.
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "核对上次发布结果" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(previews).toHaveLength(1);
  expect(creates).toEqual([{ ...previews[0], previewDigest: "phone-review" }]);
  expect(receiptReads).toBe(1);
  expect(close).not.toHaveBeenCalled();
  expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "value",
    "Phone",
  );
  expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(ui.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(ui.getAllByRole("button", { name: "重试上次发布" })).toHaveLength(1);
  expect(ui.getByRole("button", { name: "重试上次发布" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(ui.getByText("上次发布待确认")).toBeTruthy();

  // One presentation contract, recorded together so RED shows all hierarchy defects.
  expect({
    pendingAnnouncements: ui.queryAllByRole("status", {
      name: "上次发布待确认",
    }).length,
    genericFailureVisible: ui.queryByText("操作未完成") !== null,
    rawTransportMessageVisible:
      ui.queryByText("Controlled creation response unavailable") !== null,
    sameSubmissionConsequenceVisible:
      ui.queryByText("核对或重试上次发布，不会另建订阅。") !== null,
    freshCreationConsequenceVisible:
      ui.queryByText(
        /新建独立链接，其他订阅不变。|创建新的客户端订阅，其他订阅不变。/,
      ) !== null,
  }).toEqual({
    pendingAnnouncements: 1,
    genericFailureVisible: false,
    rawTransportMessageVisible: false,
    sameSubmissionConsequenceVisible: true,
    freshCreationConsequenceVisible: false,
  });
});

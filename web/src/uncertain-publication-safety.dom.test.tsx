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
import { installSessionTransport } from "./api";
import { SessionLifecycle } from "./SessionLifecycle";
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

type Attempt = OutputCreation & { previewDigest: string };
async function mountScenario(options: {
  create: (body: Attempt, number: number) => Promise<Response>;
  read?: (number: number) => Promise<Response>;
  inspect?: () => Promise<Response>;
  repair?: boolean;
}) {
  const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
  if (options.repair)
    profile.ir.defaultAction = { kind: "endpoint", ref: "removed" };
  const close = vi.fn(),
    repair = vi.fn();
  const creates: Attempt[] = [];
  const previews: OutputCreation[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview" && method === "POST") {
        previews.push(body);
        if (options.inspect) return options.inspect();
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "review",
          artifacts: [{ path: "config.json", content: "reviewed" }],
        });
      }
      if (path === "/api/me/outputs" && method === "POST") {
        creates.push(body);
        return options.create(body, creates.length);
      }
      if (path === "/api/me/outputs" && method === "GET") {
        reads++;
        return options.read ? options.read(reads) : json([]);
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
        <PublishOutput profile={profile} onClose={close} onRepair={repair} />
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
  return { ui, creates, previews, close, repair, reads: () => reads };
}
async function publish(ui: ReturnType<typeof within>) {
  await userEvent.click(ui.getByRole("button", { name: "检查发布内容" }));
  await ui.findByText("兼容检查通过。");
  await userEvent.click(
    ui.getByRole("button", { name: "创建并发布「Daily」" }),
  );
}
async function settledPending(ui: ReturnType<typeof within>) {
  await ui.findByRole("status", { name: "上次发布待确认" });
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "核对上次发布结果" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
}

it.each([500, 599])(
  "replaces pending transport status %s with one recovery status without changing the frozen request",
  async (status) => {
    const f = await mountScenario({
      create: async () => {
        return json({ message: "Raw transport failure" }, status);
      },
    });
    await publish(f.ui);
    await settledPending(f.ui);
    expect(
      f.ui.queryAllByRole("status", { name: "上次发布待确认" }),
    ).toHaveLength(1);
    expect(f.ui.queryByRole("alert")).toBeNull();
    expect(f.ui.queryByText("Raw transport failure")).toBeNull();
    expect(f.ui.getByText("核对或重试均沿用上次发布请求。")).toBeTruthy();
    expect(f.creates).toEqual([{ ...f.previews[0], previewDigest: "review" }]);
    expect(f.close).not.toHaveBeenCalled();
    // The single footer retry stays a same-attempt write, never a fresh review.
    await userEvent.click(f.ui.getByRole("button", { name: "重试上次发布" }));
    await settledPending(f.ui);
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]).toEqual(f.creates[0]);
    expect(f.previews).toHaveLength(1);
  },
);

it("retains status0 connectivity and actual offline before-send explanations while preserving the same attempt", async () => {
  const f = await mountScenario({
    create: async () => {
      throw new TypeError("Lost response");
    },
  });
  await publish(f.ui);
  await settledPending(f.ui);
  expect(f.ui.getByRole("alert").textContent).toContain(
    "无法连接服务。请检查网络后重试，当前输入已保留。",
  );
  expect(f.ui.getByRole("status", { name: "上次发布待确认" })).toBeTruthy();
  expect(f.ui.getByText("核对或重试均沿用上次发布请求。")).toBeTruthy();

  // Actual public SessionLifecycle transport, not a fabricated Error or private state setter.
  const lifecycle = new SessionLifecycle();
  lifecycle.pause();
  const remove = installSessionTransport(lifecycle);
  try {
    await userEvent.click(
      f.ui.getByRole("button", { name: "核对上次发布结果" }),
    );
    await f.ui.findByText(
      "暂时无法确认登录状态，本次操作未发送。恢复连接后请重试。",
    );
    await settledPending(f.ui);
    // beforeRequest rejected before fetch; the prior GET/POST ledger is unchanged.
    expect(f.reads()).toBe(1);
    expect(f.creates).toHaveLength(1);
    expect(f.ui.getAllByRole("alert")).toHaveLength(2);
    await userEvent.click(f.ui.getByRole("button", { name: "重试上次发布" }));
    // Existing publication catch replaces the failed automatic lookup with its own0.
    // Preserve that existing explanation too; do not claim original pre-send text survives every catch.
    await f.ui.findByText(
      "无法确认订阅是否已发布。请重试以核对同一份订阅，当前选择已保留。",
    );
    await settledPending(f.ui);
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(1);
    expect(f.ui.getAllByRole("alert")).toHaveLength(2);
  } finally {
    remove();
    lifecycle.dispose();
  }
  await userEvent.click(f.ui.getByRole("button", { name: "重试上次发布" }));
  await settledPending(f.ui);
  expect(f.creates).toHaveLength(2);
  expect(f.creates[1]).toEqual(f.creates[0]);
  expect(f.previews).toHaveLength(1);
  expect(f.close).not.toHaveBeenCalled();
});

it("keeps the pending announcement distinct from an automatic lookup still in progress", async () => {
  let release!: (value: Response) => void;
  const lookup = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const f = await mountScenario({
    create: async () => json({ message: "Creation unavailable" }, 503),
    read: async () => lookup,
  });
  await publish(f.ui);
  await f.ui.findByRole("status", { name: "正在处理本次发布" });
  expect(f.ui.queryByRole("status", { name: "上次发布待确认" })).toBeNull();
  expect(f.ui.getByRole("button", { name: "核对上次发布结果" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(
    f.ui
      .getByRole("button", { name: "重试上次发布" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  expect(f.creates).toHaveLength(1);
  release(json([]));
  await settledPending(f.ui);
  expect(f.ui.queryByRole("alert")).toBeNull();
  expect(
    f.ui
      .getByRole("button", { name: "重试上次发布" })
      .getAttribute("aria-busy"),
  ).not.toBe("true");
});

it("keeps a rejected replay and failed manual receipt lookup visible beside the older unknown result", async () => {
  const f = await mountScenario({
    create: async (_body, n) =>
      json(
        {
          message:
            n === 1
              ? "Creation unavailable"
              : "Replay conflict remains actionable",
        },
        n === 1 ? 503 : 409,
      ),
    read: async (n) =>
      n === 1 ? json([]) : json({ message: "Receipt lookup unavailable" }, 503),
  });
  await publish(f.ui);
  await settledPending(f.ui);
  await userEvent.click(f.ui.getByRole("button", { name: "重试上次发布" }));
  await f.ui.findByText("Replay conflict remains actionable");
  await settledPending(f.ui);
  expect(f.ui.getByRole("alert").textContent).toContain(
    "Replay conflict remains actionable",
  );
  expect(f.ui.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  expect(f.ui.getAllByRole("button", { name: "重试上次发布" })).toHaveLength(1);
  expect(f.ui.getByRole("button", { name: "重试上次发布" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(f.creates[1]).toEqual(f.creates[0]);
  await userEvent.click(f.ui.getByRole("button", { name: "核对上次发布结果" }));
  await f.ui.findByText("Receipt lookup unavailable");
  await settledPending(f.ui);
  expect(f.ui.getAllByRole("alert")).toHaveLength(2);
  expect(f.ui.getByText("Replay conflict remains actionable")).toBeTruthy();
  expect(f.creates).toHaveLength(2);
  expect(f.reads()).toBe(3);
  expect(f.close).not.toHaveBeenCalled();
});

it.each([400, 422])(
  "preserves declared status %s repair details and the ordinary creation consequence",
  async (status) => {
    const validation = {
      code: "missing_action_reference",
      reference: { kind: "endpoint", id: "removed" },
      location: { kind: "default" },
    };
    const f = await mountScenario({
      repair: true,
      create: async () =>
        json({ message: "Original validation detail", validation }, status),
    });
    await publish(f.ui);
    const repair = await f.ui.findByRole("button", {
      name: "调整默认流量去向",
    });
    expect(f.ui.getByRole("alert").textContent).toContain(
      "默认流量去向已不可用",
    );
    expect(f.ui.queryByRole("status", { name: "上次发布待确认" })).toBeNull();
    expect(f.ui.getByText("新建独立链接，其他订阅保留原版本。")).toBeTruthy();
    await userEvent.click(f.ui.getByText("技术信息"));
    expect(f.ui.getByText("Original validation detail")).toBeTruthy();
    await userEvent.click(repair);
    expect(f.repair).toHaveBeenCalledWith(validation);
    expect(f.reads()).toBe(0);
    expect(f.close).not.toHaveBeenCalled();
  },
);

it("does not hide a review503 without a pending creation or change the ordinary footer", async () => {
  const f = await mountScenario({
    inspect: async () => json({ message: "Review service unavailable" }, 503),
    create: async () => {
      throw new Error("Unexpected creation");
    },
  });
  await userEvent.click(f.ui.getByRole("button", { name: "检查发布内容" }));
  await f.ui.findByText("Review service unavailable");
  expect(f.ui.getByRole("alert").textContent).toContain(
    "Review service unavailable",
  );
  expect(f.ui.queryByRole("status", { name: "上次发布待确认" })).toBeNull();
  expect(f.ui.getByText("创建新的客户端订阅，其他订阅保留原版本。")).toBeTruthy();
  expect(f.creates).toHaveLength(0);
});

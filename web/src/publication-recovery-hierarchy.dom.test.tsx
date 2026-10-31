// @vitest-environment jsdom
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
import { PublishOutput } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { OutputCreation, Profile } from "./types";

type Attempt = OutputCreation & { previewDigest: string };
type ReadState = "ready" | "pending" | "paused" | "error" | "missing";
const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
  // Browser surface seam: jsdom has no foreground browser tab. Real geometry,
  // first-frame visibility and actual browser focus remain separate acceptance.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(
  options: {
    create?: (body: Attempt, number: number) => Promise<Response>;
    read?: (number: number) => Promise<Response>;
  } = {},
) {
  const creates: Attempt[] = [],
    previews: OutputCreation[] = [];
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
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
          : json({ message: "Uncertain publication" }, 503);
      }
      if (path === "/api/me/outputs") {
        reads++;
        return options.read ? options.read(reads) : json([]);
      }
      if (path.endsWith("/access"))
        return json({ feedPath: "/feed/recovery-contract" });
      throw new Error(`Unexpected request ${method} ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const close = vi.fn();
  let props: {
    profile: Profile;
    sessionId: string;
    state: ReadState;
    suspended: boolean;
    mounted: boolean;
  } = {
    profile,
    sessionId: "opening-A",
    state: "ready",
    suspended: false,
    mounted: true,
  };
  const tree = () => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <button type="button">Other task</button>
        {props.mounted && (
          <PublishOutput
            profile={props.profile}
            sessionId={props.sessionId}
            profileRead={{ state: props.state, retry: () => {} }}
            suspended={props.suspended}
            onClose={close}
          />
        )}
      </UIProviders>
    </QueryClientProvider>
  );
  const mounted = render(tree());
  return {
    creates,
    previews,
    reads: () => reads,
    close,
    update: (next: Partial<typeof props>) => {
      props = { ...props, ...next };
      mounted.rerender(tree());
    },
  };
}
async function reviewed() {
  const dialog = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  const ui = within(dialog);
  await waitFor(() =>
    expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
      "value",
      "Daily",
    ),
  );
  await userEvent.click(ui.getByRole("button", { name: "检查发布内容" }));
  await ui.findByText("兼容检查通过。");
  return { dialog, ui };
}
async function publish() {
  const result = await reviewed();
  await userEvent.click(
    result.ui.getByRole("button", { name: "创建并发布「Daily」" }),
  );
  return result;
}
function expectRecoveryDescription(
  ui: ReturnType<typeof within>,
  title: string,
  message: string,
) {
  const summary = ui.getByRole("region", {
    name: "发布结果与恢复",
    description: message,
  });
  expect(ui.getAllByRole("region", { name: "发布结果与恢复" })).toHaveLength(1);
  const status = within(summary).getByRole("status", { name: title });
  const target = within(status).getByText(message, { exact: true });
  const ids = summary.getAttribute("aria-describedby")?.trim().split(/\s+/);
  expect(ids).toHaveLength(1);
  expect(ids?.[0]).toBe(target.id);
  expect(target.id).not.toBe("");
  expect(document.getElementById(target.id)).toBe(target);
  expect(
    Array.from(document.querySelectorAll("[id]")).filter(
      (node) => node.id === target.id,
    ),
  ).toHaveLength(1);
  expect(target.tagName).toBe("SPAN");
  expect(target.parentElement).toBe(status);
  expect(target.textContent).toBe(message);
  for (const attribute of [
    "aria-label",
    "aria-labelledby",
    "role",
    "tabindex",
    "hidden",
    "aria-hidden",
  ])
    expect(target.hasAttribute(attribute)).toBe(false);
  expect(window.getComputedStyle(target).display).not.toBe("none");
  expect(window.getComputedStyle(target).visibility).toBe("visible");
  expect(status.textContent).toBe(message);
  expect(status.getAttribute("role")).toBe("status");
  expect(status.hasAttribute("tabindex")).toBe(false);
  expect(status).not.toBe(document.activeElement);
  return summary;
}
async function settled(ui: ReturnType<typeof within>) {
  await ui.findByRole("status", { name: "上次发布待确认" });
  await waitFor(() =>
    expect(ui.getByRole("button", { name: "核对上次发布结果" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  return expectRecoveryDescription(
    ui,
    "上次发布待确认",
    "尚未确认「Daily」是否已发布。核对或重试只使用上次提交的内容。",
  );
}

it("prioritizes recovery and focuses its named summary after a fast unknown result without focusing passive status", async () => {
  const f = fixture();
  const { ui } = await publish();
  const summary = await settled(ui);
  await waitFor(() => expect(document.activeElement).toBe(summary));
  const status = within(summary).getByRole("status", {
    name: "上次发布待确认",
  });
  expect(summary.getAttribute("tabindex")).toBe("-1");
  expect(status.hasAttribute("tabindex")).toBe(false);
  expect(status).not.toBe(document.activeElement);
  expect(
    summary.compareDocumentPosition(
      ui.getByRole("textbox", { name: "订阅名称" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(ui.getByRole("heading", { name: "本次发布的选项" })).toBeTruthy();
  expect(ui.getByRole("heading", { name: "发布前的检查结果" })).toBeTruthy();
  expect(
    ui.getByText("发布前的兼容检查已通过。").getAttribute("role"),
  ).toBeNull();
  expect(ui.queryByText("兼容检查通过。")).toBeNull();
  expect(ui.queryByRole("button", { name: /^创建并发布「/ })).toBeNull();
  const retry = ui.getAllByRole("button", { name: "重试上次发布" });
  expect(retry).toHaveLength(1);
  expect(retry[0].closest("[data-slot=dialog-footer]")).not.toBeNull();
  expect(
    within(summary)
      .getByRole("button", { name: "核对上次发布结果" })
      .closest("[data-slot=dialog-footer]"),
  ).toBeNull();
  expect(f.creates).toEqual([
    { ...f.previews[0], previewDigest: `review-${f.previews[0].id}` },
  ]);
  expect(f.previews).toHaveLength(1);
  expect(f.reads()).toBe(1);
  expect(f.close).not.toHaveBeenCalled();
});

it("keeps first POST fresh and labels the initial automatic check as processing rather than a settled retry", async () => {
  const creation = deferred(),
    lookup = deferred();
  const f = fixture({
    create: () => creation.promise,
    read: () => lookup.promise,
  });
  try {
    const { ui } = await publish();
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(0);
    expect(ui.queryByRole("region", { name: "发布结果与恢复" })).toBeNull();
    expect(ui.getByText("兼容检查通过。")).toBeTruthy();
    expect(
      ui
        .getByRole("button", { name: "创建并发布「Daily」" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    await act(async () => {
      creation.resolve(json({ message: "Unknown" }, 503));
    });
    const processing = await ui.findByRole("status", {
      name: "正在处理本次发布",
    });
    expect(processing.textContent).toBe(
      "正在处理「Daily」的发布，结果尚未确认。",
    );
    expectRecoveryDescription(
      ui,
      "正在处理本次发布",
      "正在处理「Daily」的发布，结果尚未确认。",
    );
    expect(ui.queryByRole("status", { name: "上次发布待确认" })).toBeNull();
    expect(
      ui
        .getByRole("button", { name: "重试上次发布" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    const check = ui.getByRole("button", { name: "核对上次发布结果" });
    expect(check).toHaveProperty("disabled", true);
    expect(check.getAttribute("aria-busy")).not.toBe("true");
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(1);
    await act(async () => {
      lookup.resolve(json([]));
    });
    const summary = await settled(ui);
    await waitFor(() => expect(document.activeElement).toBe(summary));
    expect(ui.queryByRole("status", { name: "正在处理本次发布" })).toBeNull();
    expect(f.creates).toHaveLength(1);
  } finally {
    creation.resolve(json({ message: "Released" }, 503));
    lookup.resolve(json([]));
  }
});

it("preserves operator focus and distinct GET and retry feedback after the first handoff", async () => {
  const manual = deferred(),
    retryResponse = deferred();
  const f = fixture({
    create: async (_body, n) =>
      n === 2 ? retryResponse.promise : json({ message: "Unknown" }, 503),
    read: async (n) => (n === 2 ? manual.promise : json([])),
  });
  try {
    const { ui } = await publish();
    const summary = await settled(ui);
    await waitFor(() => expect(document.activeElement).toBe(summary));
    const check = ui.getByRole("button", { name: "核对上次发布结果" });
    await userEvent.click(check);
    const checking = await ui.findByRole("status", {
      name: "正在核对发布结果",
    });
    expect(checking.textContent).toBe(
      "正在核对「Daily」的发布结果，不会重新提交。",
    );
    expectRecoveryDescription(
      ui,
      "正在核对发布结果",
      "正在核对「Daily」的发布结果，不会重新提交。",
    );
    expect(ui.getByRole("button", { name: "核对上次发布结果" })).toBe(check);
    expect(check.getAttribute("aria-busy")).toBe("true");
    expect(check).toHaveProperty("disabled", true);
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(2);
    await act(async () => {
      manual.resolve(json({ message: "Manual receipt unavailable" }, 503));
    });
    await settled(ui);
    expect(within(summary).getByRole("alert").textContent).toContain(
      "Manual receipt unavailable",
    );
    expect(document.activeElement).toBe(check);
    f.update({ state: "missing" });
    expect(
      within(summary).getByText("此分流配置已不在当前可访问范围。"),
    ).toBeTruthy();
    expect(document.activeElement).toBe(check);
    f.update({ state: "ready" });
    const retry = ui.getByRole("button", { name: "重试上次发布" });
    await userEvent.click(retry);
    await ui.findByRole("status", { name: "正在处理本次发布" });
    expectRecoveryDescription(
      ui,
      "正在处理本次发布",
      "正在处理「Daily」的发布，结果尚未确认。",
    );
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]).toEqual(f.creates[0]);
    await act(async () => {
      retryResponse.resolve(json({ message: "Still unknown" }, 503));
    });
    await settled(ui);
    expect(document.activeElement).toBe(retry);
    expect(
      within(summary).getByText("Manual receipt unavailable"),
    ).toBeTruthy();
    expect(ui.queryByText("Still unknown")).toBeNull();
    expect(f.creates).toHaveLength(2);
    expect(f.reads()).toBe(3);
    expect(f.previews).toHaveLength(1);
    // Another explicit GET is new feedback, not another autofocus handoff.
    await userEvent.click(check);
    await ui.findByText("尚未确认上次发布结果，请稍后继续核对。");
    await settled(ui);
    expect(document.activeElement).toBe(check);
    expect(f.creates).toHaveLength(2);
    expect(f.reads()).toBe(4);
  } finally {
    manual.resolve(json([]));
    retryResponse.resolve(json({ message: "Released" }, 503));
  }
});

it("keeps no-preview409 recovery and both real errors without changing frozen retry payload", async () => {
  const f = fixture({
    create: async (_body, n) =>
      json(
        { message: n === 2 ? "Replay conflict" : "Unknown" },
        n === 2 ? 409 : 503,
      ),
    read: async (n) =>
      n > 1 ? json({ message: "Receipt service unavailable" }, 503) : json([]),
  });
  const { ui } = await publish();
  await settled(ui);
  await userEvent.click(ui.getByRole("button", { name: "重试上次发布" }));
  await ui.findByText("Replay conflict");
  const summary = await settled(ui);
  expect(ui.queryByRole("heading", { name: "发布前的检查结果" })).toBeNull();
  expect(ui.queryByText("发布前的兼容检查已通过。")).toBeNull();
  expect(ui.getByRole("textbox", { name: "订阅名称" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(ui.queryByRole("button", { name: "检查发布内容" })).toBeNull();
  expect(ui.getAllByRole("button", { name: "重试上次发布" })).toHaveLength(1);
  await userEvent.click(ui.getByRole("button", { name: "核对上次发布结果" }));
  await ui.findByText("Receipt service unavailable");
  await settled(ui);
  expect(within(summary).getAllByRole("alert")).toHaveLength(2);
  expect(within(summary).getByText("Replay conflict")).toBeTruthy();
  for (const alert of within(summary).getAllByRole("alert"))
    expect(alert.hasAttribute("tabindex")).toBe(false);
  await userEvent.click(ui.getByRole("button", { name: "重试上次发布" }));
  await settled(ui);
  expect(f.creates).toHaveLength(3);
  expect(f.creates[1]).toEqual(f.creates[0]);
  expect(f.creates[2]).toEqual(f.creates[0]);
  expect(f.previews).toHaveLength(1);
  expect(f.close).not.toHaveBeenCalled();
});

it.each([
  ["pending", "正在核对分流配置…"],
  ["paused", "当前离线，恢复网络后继续核对。"],
  ["error", "暂时无法读取分流配置，当前选择已保留。"],
  ["missing", "此分流配置已不在当前可访问范围。"],
] as const)(
  "keeps the %s write reason in recovery while allowing GET only",
  async (state, reason) => {
    const f = fixture();
    const { ui } = await publish();
    const summary = await settled(ui);
    f.update({ state });
    expect(within(summary).getByText(reason)).toBeTruthy();
    expect(ui.getByRole("button", { name: "重试上次发布" })).toHaveProperty(
      "disabled",
      true,
    );
    const check = within(summary).getByRole("button", {
      name: "核对上次发布结果",
    });
    expect(check).toHaveProperty("disabled", false);
    await userEvent.click(check);
    await ui.findByText("尚未确认上次发布结果，请稍后继续核对。");
    await settled(ui);
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(2);
    expect(f.previews).toHaveLength(1);
    expect(ui.getByText("发布前的兼容检查已通过。")).toBeTruthy();
  },
);

it("does not steal newer focus from technical details when the automatic lookup settles", async () => {
  const lookup = deferred();
  const f = fixture({ read: () => lookup.promise });
  try {
    const { ui } = await publish();
    await ui.findByRole("status", { name: "正在处理本次发布" });
    const details = ui
      .getByText("技术配置（可选查看）")
      .closest<HTMLElement>('button')!;
    await userEvent.click(details);
    expect(document.activeElement).toBe(details);
    await act(async () => {
      lookup.resolve(json([]));
    });
    await settled(ui);
    expect(document.activeElement).toBe(details);
    f.update({ state: "missing" });
    expect(document.activeElement).toBe(details);
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(1);
  } finally {
    lookup.resolve(json([]));
  }
});

it("respects newer reading intent while the user scrolls during automatic recovery", async () => {
  const lookup = deferred();
  const f = fixture({ read: () => lookup.promise });
  try {
    const { ui } = await publish();
    await ui.findByRole("status", { name: "正在处理本次发布" });
    fireEvent.wheel(ui.getByText("发布前的兼容检查已通过。"), { deltaY: 80 });
    await act(async () => {
      lookup.resolve(json([]));
    });
    const summary = await settled(ui);
    expect(document.activeElement).not.toBe(summary);
    f.update({ state: "missing" });
    expect(document.activeElement).not.toBe(summary);
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(1);
  } finally {
    lookup.resolve(json([]));
  }
});

it.each(["session", "profile"] as const)(
  "does not let an old failure focus a newer %s intent",
  async (kind) => {
    const lookup = deferred();
    const f = fixture({ read: () => lookup.promise });
    try {
      const { ui } = await publish();
      await ui.findByRole("status", { name: "正在处理本次发布" });
      f.update(
        kind === "session"
          ? { sessionId: "opening-B" }
          : {
              profile: {
                ...profile,
                id: "other-profile",
                name: "Other profile",
              },
            },
      );
      const name = ui.getByRole("textbox", { name: "订阅名称" });
      await waitFor(() => expect(name).toHaveProperty("disabled", false));
      await userEvent.click(name);
      await act(async () => {
        lookup.resolve(json([]));
      });
      await waitFor(() =>
        expect(ui.queryByRole("region", { name: "发布结果与恢复" })).toBeNull(),
      );
      expect(document.activeElement).toBe(name);
      expect(name).toHaveProperty(
        "value",
        kind === "session" ? "Daily" : "Other profile",
      );
      expect(f.creates).toHaveLength(1);
      expect(f.close).not.toHaveBeenCalled();
    } finally {
      lookup.resolve(json([]));
    }
  },
);

it("does not focus or scroll a departed modal after an unmounted attempt fails", async () => {
  const lookup = deferred();
  const f = fixture({ read: () => lookup.promise });
  try {
    const { ui } = await publish();
    await ui.findByRole("status", { name: "正在处理本次发布" });
    f.update({ mounted: false });
    const next = screen.getByRole("button", { name: "Other task" });
    await userEvent.click(next);
    await act(async () => {
      lookup.resolve(json([]));
    });
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
    expect(document.activeElement).toBe(next);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.creates).toHaveLength(1);
  } finally {
    lookup.resolve(json([]));
  }
});

it("does not resurrect a presentation handoff after suspension and resume", async () => {
  const lookup = deferred();
  const f = fixture({ read: () => lookup.promise });
  try {
    const { ui } = await publish();
    await ui.findByRole("status", { name: "正在处理本次发布" });
    f.update({ suspended: true });
    const next = screen.getByRole("button", { name: "Other task" });
    await userEvent.click(next);
    await act(async () => {
      lookup.resolve(json([]));
    });
    expect(document.activeElement).toBe(next);
    f.update({ suspended: false });
    const dialog = await screen.findByRole("dialog", {
      name: "新增客户端订阅",
    });
    const summary = within(dialog).getByRole("region", {
      name: "发布结果与恢复",
    });
    expect(document.activeElement).not.toBe(summary);
    expect(within(dialog).queryByText("发布前的兼容检查已通过。")).toBeNull();
    expect(f.creates).toHaveLength(1);
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    lookup.resolve(json([]));
  }
});

it.each(["hidden", "unfocused"] as const)(
  "consumes the first handoff without focus stealing in a %s document",
  async (context) => {
    const lookup = deferred();
    const f = fixture({ read: () => lookup.promise });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    try {
      const { ui } = await publish();
      await ui.findByRole("status", { name: "正在处理本次发布" });
      if (context === "hidden") visibility.mockReturnValue("hidden");
      else vi.mocked(document.hasFocus).mockReturnValue(false);
      await act(async () => {
        lookup.resolve(json([]));
      });
      const summary = await settled(ui);
      expect(document.activeElement).not.toBe(summary);
      visibility.mockReturnValue("visible");
      vi.mocked(document.hasFocus).mockReturnValue(true);
      f.update({ state: "missing" });
      expect(document.activeElement).not.toBe(summary);
      expect(f.creates).toHaveLength(1);
      expect(f.reads()).toBe(1);
    } finally {
      lookup.resolve(json([]));
    }
  },
);

it.each([400, 422])(
  "keeps a first definitive %s rejection in the fresh flow without recovery or GET",
  async (status) => {
    const f = fixture({
      create: async () =>
        json({ message: "Rejected publication detail" }, status),
    });
    const { ui } = await publish();
    await ui.findByText("Rejected publication detail");
    expect(ui.queryByRole("region", { name: "发布结果与恢复" })).toBeNull();
    expect(ui.queryByRole("button", { name: "重试上次发布" })).toBeNull();
    expect(ui.getByText("新建独立链接，其他订阅不变。")).toBeTruthy();
    expect(ui.getByText("兼容检查通过。")).toBeTruthy();
    expect(f.creates).toHaveLength(1);
    expect(f.reads()).toBe(0);
  },
);

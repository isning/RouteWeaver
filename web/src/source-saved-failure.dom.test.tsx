// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceEditorDialog } from "./SourceEditorDialog";
import { hasUnsavedChanges } from "./navigation";
import type { Source } from "./types";

const parseFailure =
  "source parse failed; check the supported input format and resolve ambiguous changed entries";
const action = "订阅内容未能导入。请检查格式和连接设置后重试。";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const accepted: Source = {
  id: "existing-source",
  name: "Existing source",
  kind: "text",
  enabled: true,
  revision: "accepted-r1",
  content: "socks5://synthetic.example:1080#Earlier",
  snapshot: { endpoints: [] },
};
function mount(source?: Source) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SourceEditorDialog
          open
          source={source}
          onClose={onClose}
          onSaved={onSaved}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("shows one actionable Chinese saved-parse state without hiding the retained snapshot or diagnostic location", async () => {
  let retained: Source | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/reveal")) return json(accepted);
      if (!init?.method && String(url).endsWith(`/sources/${accepted.id}`))
        return json({ ...accepted, content: undefined });
      const submitted = JSON.parse(String(init?.body));
      retained = {
        ...submitted,
        content: undefined,
        revision: "saved-failure-r2",
        refreshStatus: "failed",
        lastError: parseFailure,
        lastErrorCode: "source_parse_failed",
        snapshot: accepted.snapshot,
        diagnostics: [
          { code: "fixture-location", line: 4, message: "请检查此处的记录" },
        ],
      };
      return json({ detail: parseFailure, source: retained }, 422);
    }),
  );
  const { onClose, onSaved } = mount(accepted);
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  fireEvent.change(await dialog.findByLabelText("节点链接或配置内容"), {
    target: { value: "invalid synthetic input" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "保存修改" }));
  await dialog.findByText("输入已保存，导入未完成");
  expect(dialog.queryByText("操作未完成")).toBeNull();
  expect(dialog.queryByText(parseFailure)).toBeNull();
  expect(
    dialog.getByText(`之前可用节点仍保留。${action}关闭不会撤销已保存的输入。`),
  ).toBeTruthy();
  expect(dialog.getByText("第 4 行：请检查此处的记录")).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(false);
  expect(onSaved).not.toHaveBeenCalled();
  expect(
    (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value,
  ).toBe("invalid synthetic input");
  await userEvent.click(dialog.getByRole("button", { name: /^取\s*消$/ }));
  expect(onClose).toHaveBeenCalledWith(retained);
});

it.each([
  {
    name: "422 with unknown source status",
    status: 422,
    source: "matching",
    refreshStatus: "future-status",
    lastErrorCode: "source_url_not_allowed",
    saved: false,
  },
  {
    name: "422 with known nonfailed source status",
    status: 422,
    source: "matching",
    refreshStatus: "accepted",
    lastErrorCode: "source_url_not_allowed",
    saved: false,
  },
  {
    name: "422 without a saved Source",
    status: 422,
    source: "missing",
    saved: false,
  },
  {
    name: "422 with another Source identity",
    status: 422,
    source: "foreign",
    saved: false,
  },
  {
    name: "422 without a revision",
    status: 422,
    source: "no-revision",
    saved: false,
  },
  {
    name: "another retained 422 reason",
    status: 422,
    source: "matching",
    detail: "A different import failure",
    saved: true,
  },
  {
    name: "422 with mismatched parse metadata",
    status: 422,
    source: "matching",
    lastError: "A different import failure",
    saved: true,
  },
  {
    name: "503 with an uncertain outcome",
    status: 503,
    source: "matching",
    saved: false,
  },
  {
    name: "409 revision conflict",
    status: 409,
    source: "matching",
    detail: "Source revision changed",
    saved: false,
  },
])(
  "keeps $name visible without claiming a trusted parse result",
  async (testCase) => {
    const detail = testCase.detail || parseFailure;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const submitted = JSON.parse(String(init?.body));
        const returned =
          testCase.source === "missing"
            ? undefined
            : {
                ...submitted,
                content: undefined,
                id:
                  testCase.source === "foreign"
                    ? "different-source"
                    : submitted.id,
                revision:
                  testCase.source === "no-revision" ? undefined : "reported-r2",
                refreshStatus: testCase.refreshStatus || "failed",
                lastErrorCode: testCase.lastErrorCode,
                lastError: testCase.lastError || detail,
              };
        return json({ detail, source: returned }, testCase.status);
      }),
    );
    const { onSaved } = mount();
    const dialog = within(
      await screen.findByRole("dialog", { name: "添加订阅来源" }),
    );
    fireEvent.change(dialog.getByLabelText("来源名称"), {
      target: { value: "Retained local input" },
    });
    fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
      target: { value: "invalid synthetic input" },
    });
    await userEvent.click(dialog.getByRole("button", { name: "导入来源" }));
    if (testCase.saved) {
      await dialog.findByText(/导入未完成。请检查来源设置和内容后重试。/);
      expect(dialog.queryByText(detail)).toBeNull();
      expect(dialog.queryByText("操作未完成")).toBeNull();
    } else {
      await dialog.findByText(detail);
      expect(dialog.getByText("操作未完成")).toBeTruthy();
    }
    expect(dialog.queryByText(new RegExp(action))).toBeNull();
    expect(!!dialog.queryByText("输入已保存，导入未完成")).toBe(testCase.saved);
    expect(hasUnsavedChanges()).toBe(!testCase.saved);
    if (testCase.status === 503)
      expect(dialog.getByText("尚未确认输入是否保存")).toBeTruthy();
    expect(
      (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("invalid synthetic input");
    expect(onSaved).not.toHaveBeenCalled();
  },
);

it("keeps a later FileError visible alongside the trusted saved parse state", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const submitted = JSON.parse(String(init?.body));
      return json(
        {
          detail: parseFailure,
          source: {
            ...submitted,
            content: undefined,
            revision: "saved-failure-r2",
            refreshStatus: "failed",
            lastError: parseFailure,
            lastErrorCode: "source_parse_failed",
          },
        },
        422,
      );
    }),
  );
  mount();
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "Saved input" },
  });
  fireEvent.change(dialog.getByLabelText("节点链接或配置内容"), {
    target: { value: "invalid synthetic input" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "导入来源" }));
  await dialog.findByText("输入已保存，导入未完成");
  expect(dialog.queryByText("操作未完成")).toBeNull();
  const oversized = new File(["fixture"], "oversized.json", {
    type: "application/json",
  });
  Object.defineProperty(oversized, "size", { value: 1024 * 1024 + 1 });
  fireEvent.change(dialog.getByLabelText("读取配置文件"), {
    target: { files: [oversized] },
  });
  await dialog.findByText("配置文件最大 1 MB。更大的订阅请使用 URL 导入。");
  expect(dialog.getByText("操作未完成")).toBeTruthy();
  expect(dialog.getByText("上次提交已保存，导入未完成")).toBeTruthy();
  expect(dialog.queryByText(parseFailure)).toBeNull();
  expect(
    (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement).value,
  ).toBe("invalid synthetic input");
});

it("localizes a typed retained URL denial without displaying untrusted detail", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const submitted = JSON.parse(String(init?.body));
      return json(
        {
          detail: "raw-url-detail https://secret.invalid/?token=do-not-display",
          source: {
            ...submitted,
            url: undefined,
            revision: "url-failed-r1",
            refreshStatus: "failed",
            lastError:
              "raw-url-detail https://secret.invalid/?token=do-not-display",
            lastErrorCode: "source_url_not_allowed",
          },
        },
        422,
      );
    }),
  );
  const { onSaved } = mount();
  const dialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(dialog.getByLabelText("来源名称"), {
    target: { value: "URL fixture" },
  });
  await userEvent.click(dialog.getByRole("radio", { name: "订阅 URL" }));
  fireEvent.change(dialog.getByLabelText("订阅地址"), {
    target: { value: "https://localhost/synthetic" },
  });
  await userEvent.click(dialog.getByRole("button", { name: "导入来源" }));
  await dialog.findByText(
    /无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。/,
  );
  expect(dialog.queryByText(/do-not-display/)).toBeNull();
  expect(dialog.queryByText("操作未完成")).toBeNull();
  expect(dialog.getByText("输入已保存，导入未完成")).toBeTruthy();
  expect(dialog.getByLabelText("订阅地址").getAttribute("type")).toBe(
    "password",
  );
  expect(onSaved).not.toHaveBeenCalled();
});

it.each(["accepted", "unchanged", "paused", "review-required"])(
  "does not show stale failed-input copy after revealing %s",
  async (refreshStatus) => {
    const stale = {
      ...accepted,
      refreshStatus: "failed",
      lastError: "old error",
      lastErrorCode: "source_url_not_allowed",
    };
    const summary = {
      ...stale,
      revision: "current-r2",
      refreshStatus,
      content: undefined,
    };
    const privateFull = {
      ...summary,
      content: "current revealed content",
      url: "https://private.invalid/never-return",
      snapshot: {
        endpoints: [
          {
            id: "private",
            name: "Private",
            connection: {
              protocol: "socks",
              host: "fixture.invalid",
              port: 1080,
              password: "never-return",
            },
          },
        ],
      },
    };
    const reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        reads.push(String(url));
        return json(String(url).endsWith("/reveal") ? privateFull : summary);
      }),
    );
    const { onClose, onSaved } = mount(stale);
    const dialog = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await waitFor(() =>
      expect(
        (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
          .value,
      ).toBe("current revealed content"),
    );
    expect(dialog.queryByText("输入已保存，导入未完成")).toBeNull();
    expect(dialog.queryByText(/无法使用此订阅地址/)).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: /^取\s*消$/ }));
    expect(onClose).toHaveBeenCalledWith(summary);
    expect(JSON.stringify(onClose.mock.calls)).not.toContain("never-return");
    expect(onSaved).not.toHaveBeenCalled();
    expect(reads).toEqual([
      `/api/me/sources/${stale.id}/reveal`,
      `/api/me/sources/${stale.id}`,
    ]);
  },
);

it.each([
  "revision-mismatch",
  "one-missing-revision",
  "foreign-id",
  "public-read-failure",
])(
  "keeps paired source read %s recoverable without writes",
  async (problem) => {
    let retry = false;
    const reads: string[] = [];
    const summary = { ...accepted, content: undefined, revision: "current-r2" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(init?.method).toBeUndefined();
        reads.push(String(url));
        if (String(url).endsWith("/reveal"))
          return json({ ...summary, content: "private current content" });
        if (!retry && problem === "public-read-failure")
          return json({ detail: "Public summary unavailable" }, 503);
        return json(
          !retry
            ? {
                ...summary,
                id: problem === "foreign-id" ? "foreign" : summary.id,
                revision:
                  problem === "revision-mismatch"
                    ? "other-r1"
                    : problem === "one-missing-revision"
                      ? undefined
                      : summary.revision,
              }
            : summary,
        );
      }),
    );
    const { onSaved } = mount(accepted);
    const dialog = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await dialog.findByText(
      problem === "public-read-failure"
        ? "Public summary unavailable"
        : "来源在读取时发生变化，请重试。",
    );
    expect(dialog.queryByLabelText("节点链接或配置内容")).toBeNull();
    expect(dialog.queryByRole("button", { name: "保存修改" })).toBeNull();
    retry = true;
    await userEvent.click(dialog.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(
        (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
          .value,
      ).toBe("private current content"),
    );
    expect(reads).toHaveLength(4);
    expect(onSaved).not.toHaveBeenCalled();
  },
);

it("allows paired legacy records with both revisions missing without inventing a fence", async () => {
  const summary = { ...accepted, revision: undefined, content: undefined };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) =>
      json(
        String(url).endsWith("/reveal")
          ? { ...summary, content: "legacy content" }
          : summary,
      ),
    ),
  );
  const { onClose } = mount(summary);
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  await waitFor(() =>
    expect(
      (dialog.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("legacy content"),
  );
  await userEvent.click(dialog.getByRole("button", { name: /^取\s*消$/ }));
  expect(onClose).toHaveBeenCalledWith(summary);
  expect(onClose.mock.calls[0][0].revision).toBeUndefined();
});

it("shows neutral unknown metadata on reopen without claiming a failed import", async () => {
  const summary = {
    ...accepted,
    content: undefined,
    refreshStatus: "future-status",
    lastError: "private-detail",
    lastErrorCode: "constructor",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) =>
      json(
        String(url).endsWith("/reveal")
          ? { ...summary, content: "private editable input" }
          : summary,
      ),
    ),
  );
  mount(summary);
  const dialog = within(
    await screen.findByRole("dialog", { name: "编辑来源" }),
  );
  await dialog.findByText("来源状态待确认");
  expect(
    dialog.getByText("暂时无法确认来源状态。请重新打开来源后再试。"),
  ).toBeTruthy();
  expect(dialog.queryByText("输入已保存，导入未完成")).toBeNull();
  expect(dialog.queryByText("private-detail")).toBeNull();
});

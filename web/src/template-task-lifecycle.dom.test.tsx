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
import { TemplatesPage } from "./Templates";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const templates = [
  {
    id: "alpha",
    name: "Template Alpha",
    kind: "processing-preset",
    version: 2,
    spec: { steps: [] },
  },
  {
    id: "beta",
    name: "Template Beta",
    kind: "processing-preset",
    version: 2,
    spec: { steps: [] },
  },
];
const collection = {
  id: "collection",
  name: "My collection",
  sources: [],
  pipeline: [],
};
function mount(
  write?: (url: string, body: any) => Promise<Response>,
  admin = false,
  workspace = false,
) {
  let templateReads = 0;
  const writes: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ url, body });
        if (write) return write(url, body);
        return json({});
      }
      if (url === "/api/auth/me")
        return json({
          user: { id: "member", name: "Member", role: "user" },
          csrfToken: "member-csrf",
        });
      if (url === "/api/templates") {
        templateReads++;
        return json(templates);
      }
      if (url.match(/\/templates\/[^/]+\/versions$/))
        return json([
          templates.find((t) => url.includes(t.id)),
          { ...templates.find((t) => url.includes(t.id)), version: 1 },
        ]);
      if (url === "/api/me/collections") return json([collection, { ...collection, id: "second-collection", name: "Other collection" }]);
      if (url === "/api/me/template-bindings")
        return json([
          {
            id: "binding",
            templateId: "alpha",
            targetKind: "collections",
            targetId: collection.id,
            mode: "pinned",
            appliedVersion: 1,
            bindings: {},
          },
        ]);
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {workspace ? <Workspace /> : <TemplatesPage admin={admin} />}
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    client,
    get templateReads() {
      return templateReads;
    },
  };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#templates");
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
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function openTemplate(name = "Template Alpha") {
  const article = (await screen.findByText(name)).closest("article")!;
  await userEvent.click(
    within(article).getByRole("button", { name: "查看并使用" }),
  );
  return screen.findByRole("dialog", { name });
}
async function chooseTarget(dialog: HTMLElement) {
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: "模板目标" }),
  );
  await userEvent.click(await screen.findByText("My collection"));
}

it("keeps template choices on Cancel or Escape until discard, then reopens clean", async () => {
  const { writes } = mount();
  let dialog = await openTemplate();
  await chooseTarget(dialog);
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "放弃未应用的模板选择？",
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未应用的模板选择？" }),
    ).toBeNull(),
  );
  expect(
    within(dialog)
      .getByRole("combobox", { name: "模板目标" })
      .textContent?.includes("My collection"),
  ).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  const discard = await screen.findByRole("alertdialog", {
    name: "放弃未应用的模板选择？",
  });
  await userEvent.click(
    within(discard).getByRole("button", { name: "放弃选择" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Template Alpha" })).toBeNull(),
  );
  dialog = await openTemplate();
  expect(
    within(dialog).getByRole("combobox", { name: "模板目标" }).textContent,
  ).not.toContain("My collection");
  expect(writes).toEqual([]);
});

it("blocks pending template dismissal, retains choices on failure and opens the next task after success", async () => {
  let release!: (response: Response) => void;
  let pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { writes } = mount(() => pending);
  let dialog = await openTemplate();
  await chooseTarget(dialog);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "查看模板结构" }),
  );
  const preview = within(dialog).getByLabelText("配置预览");
  const previewText = preview.textContent;
  expect(preview.tabIndex).toBe(0);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "应用模板到草稿" }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  const busy = within(dialog).getByRole("button", {
    name: "应用模板到草稿",
  });
  const frozenTarget = within(dialog).getByRole("combobox", {
    name: "模板目标",
  }) as HTMLInputElement;
  expect(frozenTarget.disabled).toBe(true);
  expect(frozenTarget.closest("[inert]")).toBeNull();
  expect(preview.tabIndex).toBe(-1);
  expect(preview.closest("[inert]")).toBeNull();
  expect(preview.textContent).toBe(previewText);
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(busy);
  await userEvent.keyboard("{Enter} ");
  await userEvent.click(busy);
  expect(writes).toHaveLength(1);
  expect(
    (
      within(dialog).getByRole("button", {
        name: /^取\s*消$/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  expect(screen.getByRole("dialog", { name: "Template Alpha" })).toBeTruthy();
  await act(async () => {
    release(json({ error: "Temporary failure" }, 503));
    await pending;
  });
  await screen.findByText("Temporary failure");
  expect(preview.tabIndex).toBe(0);
  expect(preview.textContent).toBe(previewText);
  expect(
    within(dialog)
      .getByRole("combobox", { name: "模板目标" })
      .textContent?.includes("My collection"),
  ).toBeTruthy();
  pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "应用模板到草稿" }),
  );
  await waitFor(() => expect(writes).toHaveLength(2));
  await act(async () => {
    release(json({}));
    await pending;
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Template Alpha" })).toBeNull(),
  );
  dialog = await openTemplate("Template Beta");
  await chooseTarget(dialog);
  expect(
    within(dialog)
      .getByRole("combobox", { name: "模板目标" })
      .textContent?.includes("My collection"),
  ).toBeTruthy();
  expect(writes[0].body).toEqual({
    version: 2,
    mode: "copy",
    targetId: "collection",
    bindings: { endpoints: {}, resources: {} },
  });
});

it("keeps an update review open until the pending draft application settles", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const preview = {
    compatible: true,
    hasUpdate: true,
    currentVersion: 1,
    candidateVersion: 2,
    previewDigest: "exact-review",
    diagnostics: [],
    changes: ["steps"],
    preservedLocalEdits: [],
    artifacts: [],
  };
  const { writes } = mount((url) =>
    url.endsWith("/preview") ? Promise.resolve(json(preview)) : pending,
  );
  await userEvent.click(await screen.findByRole("tab", { name: "我的引用" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "查看固定版本 My collection" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "模板更新 My collection",
  });
  await userEvent.click(
    await within(dialog).findByRole("button", { name: "应用到草稿" }),
  );
  await waitFor(() =>
    expect(writes.some((w) => w.url.endsWith("/apply"))).toBe(true),
  );
  expect(
    (
      within(dialog).getByRole("button", {
        name: /^关\s*闭$/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  expect(
    screen.getByRole("dialog", { name: "模板更新 My collection" }),
  ).toBeTruthy();
  await act(async () => {
    release(json({}));
    await pending;
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "模板更新 My collection" }),
    ).toBeNull(),
  );
  expect(writes.find((w) => w.url.endsWith("/apply"))?.body).toEqual({
    previewDigest: "exact-review",
    version: 1,
    bindings: { endpoints: {}, resources: {} },
  });
});

it("retains an unpublished template draft on canceled discard, and discards only on confirmation", async () => {
  const { writes } = mount(undefined, true);
  await userEvent.click(
    await screen.findByRole("button", { name: "发布模板" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), {
    target: { value: "My reusable template" },
  });
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  let confirm = await screen.findByRole("alertdialog", {
    name: "放弃未发布的模板修改？",
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "放弃未发布的模板修改？" }),
    ).toBeNull(),
  );
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "模板名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("My reusable template");
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^取\s*消$/ }),
  );
  confirm = await screen.findByRole("alertdialog", {
    name: "放弃未发布的模板修改？",
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "发布共享模板" })).toBeNull(),
  );
  expect(writes).toEqual([]);
});

it("locks a reviewed shared-template publication and retains the draft on failure", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { writes } = mount(
    (url) =>
      url.endsWith("/sanitize")
        ? Promise.resolve(json({ spec: { steps: [] } }))
        : pending,
    true,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "发布模板" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), {
    target: { value: "Reusable plan" },
  });
  await userEvent.click(
    within(dialog).getByRole("combobox", { name: /从自己的已保存配置提取/ }),
  );
  await userEvent.click(await screen.findByText("My collection"));
  await userEvent.click(
    within(dialog).getByRole("button", { name: "提取可共享结构" }),
  );
  await userEvent.click(
    await within(dialog).findByRole("checkbox", {
      name: "我已检查内容，确认可以供工作空间用户使用",
    }),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "发布 v1" }),
  );
  await waitFor(() =>
    expect(writes.some((write) => write.url === "/api/admin/templates")).toBe(
      true,
    ),
  );
  const busy = within(dialog).getByRole("button", {
    name: "发布 v1",
  });
  const frozenName = within(dialog).getByRole("textbox", {
    name: "模板名称",
  }) as HTMLInputElement;
  expect(frozenName.disabled).toBe(true);
  expect(frozenName.closest("[inert]")).toBeNull();
  expect(busy.getAttribute("aria-busy")).toBe("true");
  expect(busy.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(busy);
  await userEvent.keyboard("{Enter} ");
  await userEvent.click(busy);
  expect(
    writes.filter((write) => write.url === "/api/admin/templates"),
  ).toHaveLength(1);
  expect(
    (
      within(dialog).getByRole("button", {
        name: /^取\s*消$/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    writes.find((write) => write.url === "/api/admin/templates/sanitize")?.body,
  ).toEqual({ kind: "processing-preset", targetId: "collection" });
  expect(
    writes.find((write) => write.url === "/api/admin/templates")?.body,
  ).toEqual({
    id: expect.stringMatching(/^template_/),
    name: "Reusable plan",
    kind: "processing-preset",
    expectedVersion: 0,
    spec: { steps: [] },
  });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  expect(screen.getByRole("dialog", { name: "发布共享模板" })).toBeTruthy();
  await act(async () => {
    release(json({ error: "Publication unavailable" }, 503));
    await pending;
  });
  await within(dialog).findByText("Publication unavailable");
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "模板名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Reusable plan");
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "共享结构",
      }) as HTMLTextAreaElement
    ).value,
  ).toContain('"steps": []');
});

it("keeps template B intact when A completes after an explicitly confirmed workspace departure", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const state = mount(() => pending, false, true);
  const first = await openTemplate();
  await chooseTarget(first);
  await userEvent.click(
    within(first).getByRole("button", { name: "应用模板到草稿" }),
  );
  await waitFor(() => expect(state.writes).toHaveLength(1));
  // A modal correctly makes its background sidebar inert. Exercise the
  // real browser-navigation guard, which remains available during a request.
  await act(async () => {
    location.hash = "#sources";
  });
  const review = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(review).getByRole("button", { name: "放弃修改并离开" }),
  );
  await screen.findByRole("heading", { name: "订阅来源" });
  await act(async () => {
    location.hash = "#templates";
  });
  const second = await openTemplate("Template Beta");
  await chooseTarget(second);
  const reads = state.templateReads;
  await act(async () => {
    release(json({}));
    await pending;
  });
  await waitFor(() => expect(state.templateReads).toBeGreaterThan(reads));
  expect(screen.getByRole("dialog", { name: "Template Beta" })).toBeTruthy();
  expect(
    within(second).getByRole("combobox", { name: "模板目标" }).textContent,
  ).toContain("My collection");
  expect(screen.queryByText("模板已用于草稿，已发布订阅保留原版本")).toBeNull();
  expect(state.writes).toHaveLength(1);
});

it.each(["select", "publish"] as const)("restores template %s Close focus after twice canceling dirty dismissal", async (task) => {
  const { writes } = mount(undefined, task === "publish");
  let dialog: HTMLElement;
  if (task === "select") {
    dialog = await openTemplate();
    await chooseTarget(dialog);
  } else {
    await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
    dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), { target: { value: "Retained template" } });
  }
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    if (task === "select") expect(within(dialog).getByRole("combobox", { name: "模板目标" }).textContent).toContain("My collection");
    else expect((within(dialog).getByRole("textbox", { name: "模板名称" }) as HTMLInputElement).value).toBe("Retained template");
  }
  expect(writes).toEqual([]);
});

it("keeps template update Close focus after twice canceling an unapplied version selection", async () => {
  const { writes } = mount(async () => json({ compatible: true, hasUpdate: true, currentVersion: 1, candidateVersion: 2, previewDigest: "review", diagnostics: [], changes: [], preservedLocalEdits: [], artifacts: [] }));
  await userEvent.click(await screen.findByRole("tab", { name: "我的引用" }));
  await userEvent.click(await screen.findByRole("button", { name: "查看固定版本 My collection" }));
  const dialog = await screen.findByRole("dialog", { name: "模板更新 My collection" });
  const version = await within(dialog).findByLabelText("检查的模板版本");
  await userEvent.click(version);
  await userEvent.click(await screen.findByText("v2", { selector: "[cmdk-item] span" }));
  const close = within(dialog).getAllByRole("button", { name: "关闭" })[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(version.textContent).toContain("v2");
  }
  expect(writes.filter((write) => write.url.endsWith("/apply"))).toEqual([]);
});

async function openExtractionDraft() {
  await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), { target: { value: "Synthetic reusable plan" } });
  await userEvent.click(within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }));
  await userEvent.click(await screen.findByText("My collection"));
  return dialog;
}

// Synthetic HTTP boundaries, real template dialog and user controls.
it("requires review again after re-extraction and excludes publication while extraction is pending", async () => {
  let extractions = 0;
  let finish!: (response: Response) => void;
  const { writes } = mount(async url => {
    if (!url.endsWith("/sanitize")) return json({});
    if (++extractions === 1) return json({ spec: { steps: [] } });
    return new Promise<Response>(resolve => { finish = resolve; });
  }, true);
  const dialog = await openExtractionDraft();
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  const review = await within(dialog).findByRole("checkbox");
  await userEvent.click(review);
  const publish = within(dialog).getByRole("button", { name: "发布 v1" });
  const extract = within(dialog).getByRole("button", { name: "提取可共享结构" });
  act(() => { fireEvent.click(extract); fireEvent.click(publish); fireEvent.click(extract); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(extractions).toBe(2);
  expect(writes.filter(w => w.url === "/api/admin/templates")).toHaveLength(0);
  expect((publish as HTMLButtonElement).disabled).toBe(true);
  expect((review as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish(json({ spec: { steps: [] } })); });
  await waitFor(() => expect((review as HTMLButtonElement).disabled).toBe(false));
  expect(review.getAttribute("aria-checked")).toBe("false");
  expect((publish as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(review);
  await userEvent.click(publish);
  await waitFor(() => expect(writes.filter(w => w.url === "/api/admin/templates")).toHaveLength(1));
});

it.each([
  ["settled", "type"], ["pending", "type"],
  ["settled", "source"], ["pending", "source"],
  ["settled", "position"], ["pending", "position"],
] as const)("retires %s extraction errors when the template %s changes", async (timing, change) => {
  let finish!: (response: Response) => void;
  mount(async () => timing === "settled" ? json({ detail: "Old extraction failure" }, 422)
    : new Promise<Response>(resolve => { finish = resolve; }), true);
  const dialog = await openExtractionDraft();
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  if (timing === "settled") await within(dialog).findByText("Old extraction failure");
  else await waitFor(() => expect(finish).toBeTypeOf("function"));
  const label = change === "type" ? "模板类型" : change === "source" ? "从自己的已保存配置提取" : "发布位置";
  const option = change === "type" ? "客户端配置模板" : change === "source" ? "Other collection" : /Template Alpha/;
  await userEvent.click(within(dialog).getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
  if (timing === "pending") await act(async () => { finish(json({ detail: "Old extraction failure" }, 422)); });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "提取可共享结构" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(within(dialog).queryByText("Old extraction failure")).toBeNull();
  expect(within(dialog).queryByRole("textbox", { name: "共享结构" })).toBeNull();
});

it("blocks extraction after publication has started in the same turn", async () => {
  let finish!: (response: Response) => void;
  const { writes } = mount(async url => url.endsWith("/sanitize") ? json({ spec: { steps: [] } })
    : new Promise<Response>(resolve => { finish = resolve; }), true);
  const dialog = await openExtractionDraft();
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await userEvent.click(await within(dialog).findByRole("checkbox"));
  const extract = within(dialog).getByRole("button", { name: "提取可共享结构" });
  act(() => {
    fireEvent.click(within(dialog).getByRole("button", { name: "发布 v1" }));
    fireEvent.click(extract);
  });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(writes.filter(w => w.url.endsWith("/sanitize"))).toHaveLength(1);
  await act(async () => { finish(json({ detail: "Synthetic publication rejection" }, 422)); });
  await within(dialog).findByText("Synthetic publication rejection");
  expect((within(dialog).getByRole("textbox", { name: "共享结构" }) as HTMLTextAreaElement).value).toContain('"steps": []');
});

it("preserves an unavailable publication target and draft instead of silently creating a new template", async () => {
  const { client, writes } = mount(async url => url.endsWith("/sanitize")
    ? json({ spec: { steps: [] } }) : json({}), true);
  await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  await userEvent.click(within(dialog).getByRole("combobox", { name: "发布位置" }));
  await userEvent.click(await screen.findByRole("option", { name: /Template Alpha/ }));
  await userEvent.click(within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }));
  await userEvent.click(await screen.findByText("My collection"));
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await userEvent.click(await within(dialog).findByRole("checkbox"));
  const spec = (within(dialog).getByRole("textbox", { name: "共享结构" }) as HTMLTextAreaElement).value;
  await act(async () => { client.setQueryData(["templates"], [templates[1]]); });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: /^发布 v/ }).hasAttribute("disabled")).toBe(true));
  expect(within(dialog).getByRole("combobox", { name: "发布位置" }).textContent).toContain("Template Alpha");
  expect(within(dialog).getByText("所选模板已不可用。重新加载模板列表，或选择其他发布位置。")).toBeTruthy();
  expect((within(dialog).getByRole("textbox", { name: "共享结构" }) as HTMLTextAreaElement).value).toBe(spec);
  expect((within(dialog).getByRole("textbox", { name: "模板名称" }) as HTMLInputElement).value).toBe("Template Alpha");
  fireEvent.click(within(dialog).getByRole("button", { name: /^发布 v/ }));
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole("button", { name: "重新加载模板列表" }));
  const publish = await within(dialog).findByRole("button", { name: "发布 v3" });
  await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
  expect((within(dialog).getByRole("textbox", { name: "共享结构" }) as HTMLTextAreaElement).value).toBe(spec);
  await userEvent.click(publish);
  await waitFor(() => expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(1));
  expect(writes.find(write => write.url === "/api/admin/templates")?.body).toMatchObject({
    id: "alpha", expectedVersion: 2, name: "Template Alpha", spec: { steps: [] },
  });
});

it("blocks publication during failed catalog verification without discarding the selected template or reviewed draft", async () => {
  const { client, writes } = mount(async url => url.endsWith("/sanitize")
    ? json({ spec: { steps: [] } }) : json({}), true);
  await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  await userEvent.click(within(dialog).getByRole("combobox", { name: "发布位置" }));
  await userEvent.click(await screen.findByRole("option", { name: /Template Alpha/ }));
  await userEvent.click(within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }));
  await userEvent.click(await screen.findByText("My collection"));
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await userEvent.click(await within(dialog).findByRole("checkbox"));
  const originalFetch = globalThis.fetch;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((input, init) => String(input) === "/api/templates"
    ? new Promise<Response>(resolve => { finish = resolve; }) : originalFetch(input, init)));
  let refresh!: Promise<void>;
  act(() => { refresh = client.refetchQueries({ queryKey: ["templates"], exact: true }); });
  await within(dialog).findByText("正在读取模板列表…");
  expect(within(dialog).getByRole("button", { name: "发布 v3" }).hasAttribute("disabled")).toBe(true);
  expect(within(dialog).queryByText("已不可用")).toBeNull();
  await act(async () => { finish(json({ detail: "Catalog unavailable" }, 503)); await refresh; });
  expect(await within(dialog).findByText("暂时无法加载模板")).toBeTruthy();
  expect(within(dialog).getByRole("combobox", { name: "发布位置" }).textContent).toContain("Template Alpha");
  expect(within(dialog).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByRole("button", { name: "发布 v3" }).hasAttribute("disabled")).toBe(true);
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
  vi.stubGlobal("fetch", originalFetch);
  await userEvent.click(within(dialog).getByRole("button", { name: "重新加载模板" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "发布 v3" }).hasAttribute("disabled")).toBe(false));
  await userEvent.click(within(dialog).getByRole("button", { name: "发布 v3" }));
  await waitFor(() => expect(writes.find(write => write.url === "/api/admin/templates")?.body.id).toBe("alpha"));
});

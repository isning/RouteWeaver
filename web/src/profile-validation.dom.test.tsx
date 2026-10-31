// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";

const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const missing = (location: { kind: string; id?: string }, ref = "removed") => ({
  code: "missing_action_reference",
  reference: { kind: "endpoint", id: ref },
  location,
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "/");
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
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  onlineManager.setOnline(true);
});
function mount(
  profile: Profile,
  validation: unknown = missing({ kind: "default" }),
  options: {
    status?: number;
    detail?: string;
    preview?: () => Promise<Response>;
    entries?: () => Promise<Response>;
    input?: () => Promise<Response>;
    output?: Output;
    outputs?: Output[];
    cachedEntries?: boolean;
    staleTime?: number;
  } = {},
) {
  const writes: { path: string; body: Profile }[] = [];
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options.staleTime },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  if (options.cachedEntries) client.setQueryData(["platform-entries"], []);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/me/platform-entries" && options.entries)
        return options.entries();
      if (path === "/api/me/collections/preview")
        return options.input
          ? options.input()
          : json({ endpoints: [], stages: [] });
      if (init?.method === "POST" || init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (path.endsWith("/preview"))
          return options.preview
            ? options.preview()
            : json(
                {
                  detail:
                    options.detail ||
                    "defaultAction: endpoint reference missing",
                  validation,
                },
                options.status || 400,
              );
        return json(body);
      }
      return json(
        path.endsWith("/outputs") && (options.outputs || options.output)
          ? options.outputs || [options.output]
          : path.endsWith("/sources") && profile.sourceIds?.length
            ? [
                {
                  id: profile.sourceIds[0],
                  name: "Source",
                  kind: "text",
                  enabled: true,
                  snapshot: { endpoints: [] },
                },
              ]
            : [],
      );
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={options.output}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, client };
}
function fixture() {
  const profile = {
    ...emptyProfile(),
    id: "repair-profile",
    name: "My routes",
  };
  profile.ir.defaultAction = { kind: "endpoint", ref: "removed" };
  return profile;
}
it("makes a checked missing default destination repairable without changing the draft", async () => {
  const profile = fixture();
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  const failure = await screen.findByRole("alert", {
    name: "无法检查：默认流量去向已不可用",
  });
  expect(
    screen.getAllByRole("button", { name: "调整默认流量去向" }),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "默认流量行为" }),
    ),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
  expect(within(failure).getByText("技术信息")).toBeTruthy();
});
it("lists every affected control even when default, group and rule share one missing reference", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "travel",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "removed" }],
    },
  ];
  profile.ir.rules = [
    {
      id: "news",
      match: { op: "domain", value: "news.example" },
      action: { kind: "endpoint", ref: "removed" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  const warning = await screen.findByRole("alert", {
    name: "部分流量去向当前不可用",
  });
  expect(within(warning).getAllByRole("button")).toHaveLength(3);
  await user.click(
    within(warning).getByRole("button", { name: "调整规则 1 的去向" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  expect(
    screen.getByRole("tab", { name: "分流规则" }).getAttribute("aria-selected"),
  ).toBe("true");
  await user.click(
    within(warning).getByRole("button", { name: "调整策略组「Travel」的成员" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "策略组「Travel」的固定成员" }),
    ),
  );
  expect(
    screen.getByRole("tab", { name: "策略组" }).getAttribute("aria-selected"),
  ).toBe("true");
  await user.click(
    within(warning).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "默认流量行为" }),
    ),
  );
  expect(writes).toHaveLength(0);
});

it("returns from an existing subscription check to the exact repair control without publishing", async () => {
  const profile = fixture();
  const output: Output = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  const { writes } = mount(profile, missing({ kind: "default" }), {
    status: 422,
    output,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "检查发布" }));
  await user.click(await screen.findByRole("button", { name: "检查所选订阅" }));
  const dialog = await screen.findByRole("dialog", {
    name: "检查订阅更新「Phone」",
  });
  const failure = await within(dialog).findByRole("alert", {
    name: "无法检查：默认流量去向已不可用",
  });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "默认流量行为" }),
    ),
  );
  expect(writes.map((write) => write.path)).toEqual([
    "/api/me/profiles/repair-profile/preview",
  ]);
});

it("keeps repair targets attached to rule identity after reorder and removes deleted occurrences", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "direct" };
  profile.ir.rules = [
    {
      id: "first",
      match: { op: "domain", value: "first.example" },
      action: { kind: "direct" },
    },
    {
      id: "second",
      match: { op: "domain", value: "second.example" },
      action: { kind: "endpoint", ref: "removed" },
    },
  ];
  mount(profile, missing({ kind: "rule", id: "second" }));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "调整规则 2 的去向" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "规则 2 的流量去向" }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "上移规则 2" }));
  await user.click(
    await screen.findByRole("button", { name: "调整规则 1 的去向" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  expect(
    screen
      .getAllByRole("textbox", { name: "规则匹配值" })[0]
      .getAttribute("value"),
  ).toBe("second.example");
  await user.click(screen.getByRole("button", { name: "删除规则 1" }));
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "规则匹配值" }).getAttribute("value"),
  ).toBe("first.example");
});

it("discards a late validation failure for an older editor revision", async () => {
  let rejectPreview!: (response: Response) => void;
  const { writes } = mount(fixture(), undefined, {
    preview: () =>
      new Promise((resolve) => {
        rejectPreview = resolve;
      }),
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  await user.type(
    screen.getByRole("textbox", { name: "配置名称" }),
    " revised",
  );
  rejectPreview(
    json(
      { detail: "obsolete failure", validation: missing({ kind: "default" }) },
      400,
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "预览配置" }).className,
    ).not.toContain("loading"),
  );
  expect(screen.queryByText("obsolete failure")).toBeNull();
  expect(
    within(
      await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
    ).getByRole("button", { name: "调整默认流量去向" }),
  ).toBeTruthy();
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
});

it.each([
  [400, null, "legacy missing reference"],
  [
    400,
    { ...missing({ kind: "default" }), code: "other_validation" },
    "unknown issue",
  ],
  [400, missing({ kind: "rule", id: "not-in-draft" }), "unknown rule"],
  [
    400,
    missing({ kind: "default" }, "different-reference"),
    "mismatched reference",
  ],
  [
    400,
    { ...missing({ kind: "default" }), reference: { kind: "endpoint" } },
    "malformed metadata",
  ],
  [401, missing({ kind: "default" }), "sign in required"],
  [403, missing({ kind: "default" }), "permission denied"],
  [409, missing({ kind: "default" }), "review is stale"],
] as const)(
  "keeps %s / %s failures visible without guessing a repair from local missing references",
  async (status, validation, detail) => {
    mount(fixture(), validation, { status, detail });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "检查与预览" }));
    await user.click(screen.getByRole("button", { name: "预览配置" }));
    expect(await screen.findByText(detail)).toBeTruthy();
    expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
    expect(
      within(
        await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
      ).getByRole("button", { name: "调整默认流量去向" }),
    ).toBeTruthy();
  },
);

it("does not conclude a source reference is missing during loading or failed inventory", async () => {
  let finish!: (response: Response) => void;
  let first = true;
  const profile = fixture();
  profile.sourceIds = ["source"];
  mount(profile, undefined, {
    input: () =>
      first
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(json({ endpoints: [], stages: [] })),
  });
  await screen.findByText("正在计算有效连接…");
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  await waitFor(() => expect(typeof finish).toBe("function"));
  finish(json({ detail: "Inventory could not be read" }, 503));
  await screen.findByText("Inventory could not be read");
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  expect(
    within(
      screen.getByRole("combobox", { name: "默认流量行为" }).closest("label")!,
    ).getByText("连接暂无法核对"),
  ).toBeTruthy();
  first = false;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "重新计算有效连接" }));
  expect(
    await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeTruthy();
});

it("withdraws a missing conclusion while a platform inventory refresh is pending or fails", async () => {
  let finish!: (response: Response) => void;
  let pending = false;
  const { client } = mount(fixture(), undefined, {
    entries: () =>
      pending
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(json([])),
  });
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  pending = true;
  void client.invalidateQueries({ queryKey: ["platform-entries"] });
  await waitFor(() =>
    expect(
      screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
    ).toBeNull(),
  );
  finish(json({ detail: "Platform inventory unavailable" }, 503));
  await screen.findByText("Platform inventory unavailable");
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  expect(
    within(
      screen.getByRole("combobox", { name: "默认流量行为" }).closest("label")!,
    ).getByText("连接暂无法核对"),
  ).toBeTruthy();
});

it("clears the checked failure when the user repairs the action and can preview again", async () => {
  let repaired = false;
  const { writes } = mount(fixture(), undefined, {
    preview: async () =>
      repaired
        ? json({
            valid: true,
            artifacts: [{ path: "config.json", content: "repaired" }],
          })
        : json(
            {
              detail: "defaultAction: endpoint reference missing",
              validation: missing({ kind: "default" }),
            },
            400,
          ),
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  const failure = await screen.findByRole("alert", { name: /^无法检查：/ });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  repaired = true;
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  expect(
    await screen.findByRole("dialog", { name: "草稿配置预览" }),
  ).toBeTruthy();
  expect(writes[1].body.ir.defaultAction).toEqual({ kind: "direct" });
});

it("returns from a new subscription preview to repair without creating an output", async () => {
  const { writes } = mount(fixture(), missing({ kind: "default" }), {
    status: 422,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "检查发布" }));
  const dialog = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(screen.queryByRole("dialog", { name: "选择客户端订阅" })).toBeNull();
  expect(writes).toEqual([]);
  await user.click(
    within(dialog).getByRole("button", { name: "检查发布内容" }),
  );
  const failure = await within(dialog).findByRole("alert", {
    name: /^无法检查：/,
  });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "默认流量行为" }),
    ),
  );
  expect(writes.map((write) => write.path)).toEqual([
    "/api/me/outputs/preview",
  ]);
});

it("does not navigate an ambiguous duplicate rule identity supplied through JSON", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "direct" };
  profile.ir.rules = ["first.example", "second.example"].map((value) => ({
    id: "duplicate",
    match: { op: "domain", value },
    action: { kind: "endpoint", ref: "removed" },
  }));
  mount(profile, missing({ kind: "rule", id: "duplicate" }), {
    detail: "rules[0].action: endpoint reference missing",
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("rules[0].action: endpoint reference missing");
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
});

it("does not mislabel a malformed action reference as an actionable missing destination", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "endpoint", ref: "invalid/ref" };
  mount(profile, missing({ kind: "default" }, "invalid/ref"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("defaultAction: endpoint reference missing");
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
});

it("rejects array-shaped location kinds instead of coercing them into another repair target", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "direct" };
  profile.ir.groups = [
    {
      id: "shared",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "removed" }],
    },
  ];
  profile.ir.rules = [
    {
      id: "shared",
      match: { op: "domain", value: "news.example" },
      action: { kind: "endpoint", ref: "removed" },
    },
  ];
  mount(
    profile,
    {
      ...missing({ kind: "group", id: "shared" }),
      location: { kind: ["group"], id: "shared" },
    },
    { detail: "invalid metadata shape" },
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("invalid metadata shape");
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
});

it("does not steal focus into a hidden section after the user replaces a repair navigation", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "direct" };
  profile.ir.groups = [
    {
      id: "travel",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "removed" }],
    },
  ];
  mount(profile);
  const repair = await screen.findByRole("button", {
    name: "调整策略组「Travel」的成员",
  });
  fireEvent.click(repair);
  const runtime = screen.getByRole("tab", { name: "运行设置" });
  runtime.focus();
  fireEvent.click(runtime);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(runtime.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(runtime);
});

it("preserves new-subscription choices across repair and requires a fresh check before publication", async () => {
  const { writes } = mount(fixture(), missing({ kind: "default" }), {
    status: 422,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "检查发布" }));
  let dialog = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(screen.queryByRole("dialog", { name: "选择客户端订阅" })).toBeNull();
  expect(writes).toEqual([]);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "订阅名称" }), {
    target: { value: "Custom laptop" },
  });
  await user.click(
    within(dialog).getByRole("combobox", { name: "目标客户端" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "sing-box 1.14.3" }),
  );
  await user.click(within(dialog).getByRole("combobox", { name: "输出内容" }));
  await user.click(await screen.findByRole("option", { name: "纯节点输出" }));
  await user.click(
    within(dialog).getByRole("button", { name: "检查发布内容" }),
  );
  const failure = await within(dialog).findByRole("alert", {
    name: /^无法检查：/,
  });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(screen.getByRole("button", { name: "保存并检查" }));
  dialog = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "订阅名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Custom laptop");
  expect(within(dialog).getByText("sing-box 1.14.3")).toBeTruthy();
  expect(within(dialog).getByText("纯节点输出")).toBeTruthy();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "检查发布内容",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    within(dialog).queryByRole("button", {
      name: "创建并发布「Custom laptop」",
    }),
  ).toBeNull();
  expect(writes.map((write) => write.path)).toEqual([
    "/api/me/outputs/preview",
    "/api/me/profiles/repair-profile",
  ]);
});

it("keeps the explicitly selected existing output when returning from repair", async () => {
  const profile = fixture();
  const phone: Output = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  const laptop: Output = { ...phone, id: "laptop", name: "Laptop" };
  const { writes } = mount(profile, missing({ kind: "default" }), {
    status: 422,
    output: phone,
    outputs: [phone, laptop],
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "检查发布" }));
  await user.click(
    await screen.findByRole("radio", { name: /更新「Laptop」/ }),
  );
  await user.click(screen.getByRole("button", { name: "检查所选订阅" }));
  let dialog = await screen.findByRole("dialog", {
    name: "检查订阅更新「Laptop」",
  });
  const failure = await within(dialog).findByRole("alert", {
    name: /^无法检查：/,
  });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(screen.getByRole("button", { name: "保存并检查" }));
  dialog = await screen.findByRole("dialog", {
    name: "检查订阅更新「Laptop」",
  });
  expect(
    (
      within(dialog).getByRole("button", {
        name: "确认更新「Laptop」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.queryByRole("dialog", { name: "检查订阅更新「Phone」" }),
  ).toBeNull();
  expect(writes.map((write) => write.path)).toEqual([
    "/api/me/profiles/repair-profile/preview",
    "/api/me/profiles/repair-profile",
    "/api/me/profiles/repair-profile/preview",
  ]);
  expect(
    writes
      .filter((write) => write.path.endsWith("/preview"))
      .map((write) => write.body),
  ).toMatchObject([{ outputId: "laptop" }, { outputId: "laptop" }]);
  expect(writes.some((write) => write.path.endsWith("/publish"))).toBe(false);
});

it.each(["group", "rule"] as const)(
  "uses the checked %s occurrence rather than the error text or the first shared reference",
  async (kind) => {
    const profile = fixture();
    profile.ir.groups = [
      {
        id: "travel",
        name: "Travel",
        kind: "manual",
        members: [{ kind: "group", ref: "removed" }],
      },
    ];
    profile.ir.rules = [
      {
        id: "news",
        match: { op: "domain", value: "news.example" },
        action: { kind: "group", ref: "removed" },
      },
    ];
    const location = { kind, id: kind === "group" ? "travel" : "news" };
    mount(profile, {
      ...missing(location),
      reference: { kind: "group", id: "removed" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "检查与预览" }));
    await user.click(screen.getByRole("button", { name: "预览配置" }));
    const failure = await screen.findByRole("alert", { name: /^无法检查：/ });
    const action =
      kind === "group" ? "调整策略组「Travel」的成员" : "调整规则 1 的去向";
    await user.click(within(failure).getByRole("button", { name: action }));
    const control = await screen.findByRole("combobox", {
      name:
        kind === "group" ? "策略组「Travel」的固定成员" : "规则 1 的流量去向",
    });
    await waitFor(() => expect(document.activeElement).toBe(control));
  },
);

it("does not call an offline cached inventory a fresh missing-reference check", async () => {
  onlineManager.setOnline(false);
  mount(fixture(), undefined, { cachedEntries: true });
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  expect(
    within(
      screen.getByRole("combobox", { name: "默认流量行为" }).closest("label")!,
    ).getByText("连接等待核对"),
  ).toBeTruthy();
  onlineManager.setOnline(true);
  expect(
    await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeTruthy();
});

it("rechecks a fresh cached inventory on editor entry instead of waiting indefinitely", async () => {
  const entries = vi.fn(async () => json([]));
  mount(fixture(), undefined, {
    cachedEntries: true,
    staleTime: 15000,
    entries,
  });
  expect(
    await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeTruthy();
  expect(entries).toHaveBeenCalledTimes(1);
});

it("suppresses only the checked occurrence while retaining same-reference rule and group repairs", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "travel",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "removed" }],
    },
  ];
  profile.ir.rules = [
    {
      id: "news",
      match: { op: "domain", value: "news.example" },
      action: { kind: "endpoint", ref: "removed" },
    },
  ];
  mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByRole("alert", { name: "无法检查：默认流量去向已不可用" });
  expect(
    screen.getAllByRole("button", { name: "调整默认流量去向" }),
  ).toHaveLength(1);
  const warning = screen.getByRole("alert", { name: "部分流量去向当前不可用" });
  expect(within(warning).getAllByRole("button")).toHaveLength(2);
  expect(
    within(warning).getByRole("button", { name: "调整规则 1 的去向" }),
  ).toBeTruthy();
  expect(
    within(warning).getByRole("button", { name: "调整策略组「Travel」的成员" }),
  ).toBeTruthy();
  await user.type(
    screen.getByRole("textbox", { name: "配置名称" }),
    " revised",
  );
  expect(screen.queryByRole("alert", { name: /^无法检查：/ })).toBeNull();
  expect(
    within(
      screen.getByRole("alert", { name: "部分流量去向当前不可用" }),
    ).getAllByRole("button"),
  ).toHaveLength(3);
});

it("keeps an unavailable default state readable and puts its stable identity in associated reference details", async () => {
  const profile = fixture();
  profile.ir.defaultAction = {
    kind: "endpoint",
    ref: "ep_0123456789abcdef0123456789abcdef",
  };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  const control = screen.getByRole("combobox", { name: "默认流量行为" });
  expect(
    within(control.closest("label")!).getByText("连接不可用"),
  ).toBeTruthy();
  expect(control.closest("label")!.textContent).not.toContain(
    profile.ir.defaultAction.ref,
  );
  const details = screen.getByLabelText("默认去向的引用详情", {
    selector: "details",
  });
  expect(control.getAttribute("aria-describedby")).toBe(details.id);
  expect(details.hasAttribute("open")).toBe(false);
  await user.click(within(details).getByText("引用详情"));
  expect(details.hasAttribute("open")).toBe(true);
  expect(within(details).getByText(profile.ir.defaultAction.ref!)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "调整默认流量去向" }));
  await waitFor(() => expect(document.activeElement).toBe(control));
  await user.click(control);
  const retainedOption = await screen.findByRole("option", {
    name: `连接不可用，引用 ${profile.ir.defaultAction.ref}`,
  });
  expect(
    within(retainedOption).getByText(profile.ir.defaultAction.ref!, {
      exact: true,
    }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(writes).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
});

it("distinguishes multiple unknown members and rule destinations while repairing only the selected occurrence", async () => {
  const profile = fixture();
  const first = "ep_0123456789abcdef0123456789abcdef";
  const second = "ep_fedcba9876543210fedcba9876543210";
  profile.ir.defaultAction = { kind: "endpoint", ref: first };
  profile.ir.groups = [
    {
      id: "travel",
      name: "旅行",
      kind: "manual",
      members: [
        { kind: "endpoint", ref: first },
        { kind: "endpoint", ref: second },
        { kind: "group", ref: "group_missing" },
      ],
    },
  ];
  profile.ir.rules = [
    {
      id: "first",
      match: { op: "domain", value: "first.example" },
      action: { kind: "direct" },
    },
    {
      id: "second",
      match: { op: "domain", value: "second.example" },
      action: { kind: "endpoint", ref: second },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  const warning = await screen.findByRole("alert", {
    name: "部分流量去向当前不可用",
  });
  // One repair action per affected control, not one repeated button per member.
  expect(within(warning).getAllByRole("button")).toHaveLength(3);
  expect(warning.textContent).not.toContain("ep_");
  await user.click(
    within(warning).getByRole("button", { name: "调整策略组「旅行」的成员" }),
  );
  const members = screen.getByRole("combobox", {
    name: "策略组「旅行」的固定成员",
  });
  await waitFor(() => expect(document.activeElement).toBe(members));
  const memberLabel = members.closest("label")!;
  expect(within(memberLabel).getByText("连接不可用 1")).toBeTruthy();
  expect(within(memberLabel).getByText("连接不可用 2")).toBeTruthy();
  expect(within(memberLabel).getByText("策略组不可用")).toBeTruthy();
  expect(memberLabel.textContent).not.toContain("ep_");
  const details = screen.getByLabelText("策略组「旅行」成员的引用详情", {
    selector: "details",
  });
  expect(members.getAttribute("aria-describedby")).toBe(details.id);
  await user.click(within(details).getByText("引用详情"));
  expect(
    within(details)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([
    `连接不可用 1 · ${first}`,
    `连接不可用 2 · ${second}`,
    "策略组不可用 · group_missing",
  ]);
  await user.click(members);
  // Reach this virtualized option by its identity, as a keyboard user can.
  await user.type(screen.getByPlaceholderText("搜索选项…"), second);
  const retainedOption = await screen.findByRole("option", {
    name: `连接不可用 2，引用 ${second}`,
  });
  // Identity is visible in the expanded option, not only its accessible name.
  expect(
    within(retainedOption).getByText(second, { exact: true }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await user.click(
    within(warning).getByRole("button", { name: "调整规则 2 的去向" }),
  );
  const rule = screen.getByRole("combobox", { name: "规则 2 的流量去向" });
  await waitFor(() => expect(document.activeElement).toBe(rule));
  expect(
    within(rule.closest("label")!).getAllByText("连接不可用 2").length,
  ).toBeGreaterThan(0);
  const ruleDetails = screen.getByLabelText("规则 2的引用详情", {
    selector: "details",
  });
  expect(rule.getAttribute("aria-describedby")).toBe(ruleDetails.id);
  await user.click(within(ruleDetails).getByText("引用详情"));
  expect(within(ruleDetails).getByText(second)).toBeTruthy();
  expect(writes).toHaveLength(0);
  await user.click(rule);
  const retainedRuleOption = await screen.findByRole("option", {
    name: `连接不可用 2，引用 ${second}`,
  });
  expect(
    within(retainedRuleOption).getByText(second, { exact: true }),
  ).toBeTruthy();
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
  expect(writes[0].body.ir.groups).toEqual(profile.ir.groups);
  expect(writes[0].body.ir.rules[0]).toEqual(profile.ir.rules[0]);
  expect(writes[0].body.ir.rules[1]).toEqual({
    ...profile.ir.rules[1],
    action: { kind: "direct" },
  });
});

it("keeps a reliable retained connection name after the unavailable status without changing its identity", async () => {
  const profile = fixture();
  profile.sourceIds = ["source"];
  profile.ir.endpoints = [
    {
      id: "removed",
      name: "东京 · 工作连接",
      origin: "imported",
      connection: { protocol: "socks", host: "unused.example", port: 1080 },
    },
  ];
  const { writes } = mount(profile);
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  const control = screen.getByRole("combobox", { name: "默认流量行为" });
  expect(
    within(control.closest("label")!).getByText("不可用 · 东京 · 工作连接"),
  ).toBeTruthy();
  expect(writes).toHaveLength(0);
});

it.each([
  ["loading", "连接正在核对"],
  ["offline", "连接等待核对"],
  ["failed", "连接暂无法核对"],
] as const)(
  "keeps %s inventory distinct from missing in every affected control",
  async (state, label) => {
    const profile = fixture();
    profile.ir.groups = [
      {
        id: "travel",
        name: "旅行",
        kind: "manual",
        members: [profile.ir.defaultAction],
      },
    ];
    profile.ir.rules = [
      {
        id: "rule",
        match: { op: "domain", value: "news.example" },
        action: profile.ir.defaultAction,
      },
    ];
    if (state === "offline") onlineManager.setOnline(false);
    const { writes } = mount(profile, undefined, {
      cachedEntries: state === "offline",
      entries:
        state === "failed"
          ? async () => json({ detail: "Inventory unavailable" }, 503)
          : () => new Promise(() => {}),
    });
    const user = userEvent.setup();
    const assertControl = async (name: string) => {
      const control = screen.getByRole("combobox", { name });
      await waitFor(() =>
        expect(
          within(control.closest("label")!).getAllByText(label).length,
        ).toBeGreaterThan(0),
      );
      const details = document.getElementById(
        control.getAttribute("aria-describedby")!,
      );
      expect(details?.textContent).toContain("removed");
      expect(control.closest("label")!.textContent).not.toContain("不可用");
    };
    await assertControl("默认流量行为");
    await user.click(screen.getByRole("tab", { name: "策略组" }));
    await assertControl("策略组「旅行」的固定成员");
    await user.click(screen.getByRole("tab", { name: "分流规则" }));
    await assertControl("规则 1 的流量去向");
    expect(
      screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
    ).toBeNull();
    expect(writes).toHaveLength(0);
  },
);

it("keeps one repair for a checked group with several unavailable members", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "direct" };
  profile.ir.groups = [
    {
      id: "travel",
      name: "旅行",
      kind: "manual",
      members: [
        { kind: "endpoint", ref: "removed" },
        { kind: "endpoint", ref: "another-removed" },
      ],
    },
  ];
  mount(profile, missing({ kind: "group", id: "travel" }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByRole("alert", {
    name: "无法检查：策略组「旅行」有不可用成员",
  });
  expect(
    screen.getAllByRole("button", { name: "调整策略组「旅行」的成员" }),
  ).toHaveLength(1);
});

it("waits instead of using a cached source inventory when an offline user reselects it after platform checks complete", async () => {
  const profile = fixture();
  profile.sourceIds = ["source"];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  onlineManager.setOnline(false);
  await user.click(screen.getByRole("button", { name: "编辑来源" }));
  await user.click(screen.getByRole("combobox", { name: "使用的订阅来源" }));
  const sourceOption = await screen.findByRole("option", { name: "Source" });
  await user.click(sourceOption);
  await user.click(sourceOption);
  await user.keyboard("{Escape}");
  const control = screen.getByRole("combobox", { name: "默认流量行为" });
  await waitFor(() =>
    expect(
      within(control.closest("label")!).getAllByText("连接等待核对").length,
    ).toBeGreaterThan(0),
  );
  expect(
    screen.queryByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeNull();
  expect(writes).toHaveLength(0);
  onlineManager.setOnline(true);
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
});

it("can still find a retained unknown destination by its stable reference ID", async () => {
  const { writes } = mount(fixture());
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  const user = userEvent.setup();
  const control = screen.getByRole("combobox", { name: "默认流量行为" });
  await user.click(control);
  await user.type(screen.getByPlaceholderText("搜索选项…"), "removed");
  expect(
    await screen.findByRole("option", { name: "连接不可用，引用 removed" }),
  ).toBeTruthy();
  expect(writes).toHaveLength(0);
});

it("keeps a large connection list bounded while a retained reference remains searchable", async () => {
  const profile = fixture();
  profile.ir.endpoints = Array.from({ length: 2000 }, (_, index) => ({
    id: `present_${index}`,
    name: `Connection ${index}`,
    labels: {},
    connection: { protocol: "socks", host: "unused.example", port: 1080 },
  }));
  const { writes } = mount(profile);
  await screen.findByRole("alert", { name: "部分流量去向当前不可用" });
  const user = userEvent.setup();
  const control = screen.getByRole("combobox", { name: "默认流量行为" });
  await user.click(control);
  // Rendering a missing choice must not materialize every unaffected endpoint.
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(50);
  await user.type(screen.getByPlaceholderText("搜索选项…"), "Connection 1999");
  expect(
    await screen.findByRole("option", { name: "Connection 1999" }),
  ).toBeTruthy();
  await user.clear(screen.getByPlaceholderText("搜索选项…"));
  await user.type(screen.getByPlaceholderText("搜索选项…"), "removed");
  expect(
    await screen.findByRole("option", { name: "连接不可用，引用 removed" }),
  ).toBeTruthy();
  await user.keyboard("{Enter}{Escape}");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(
      writes.filter((write) => !write.path.endsWith("/preview")),
    ).toHaveLength(1),
  );
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
});

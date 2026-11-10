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
import { compile } from "tailwindcss";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { ClientNode, Output, PlatformEntry, Profile, Source } from "./types";

const node = (id: string, name: string): ClientNode => ({
  id,
  name,
  origin: "imported",
  connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
});
const effective = [
  node("tokyo", "Tokyo accepted"),
  node("london", "London accepted"),
];
const source: Source = {
  id: "travel-source",
  name: "Travel source",
  kind: "text",
  enabled: true,
  snapshot: {
    endpoints: [...effective, node("filtered", "Raw filtered node")],
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  const profile = {
    ...emptyProfile(),
    id: "intent-profile",
    name: "Travel configuration",
    sourceIds: [source.id],
  };
  profile.ir.name = profile.name;
  return profile;
}
function mount(
  profile: Profile = fixture(),
  options: { output?: Output; inputFailure?: boolean; entryReply?: () => Promise<Response>; cachedEntries?: PlatformEntry[] } = {},
) {
  const writes: { path: string; body: any }[] = [];
  const savedSources = [source];
  const onClose = vi.fn();
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/me/platform-entries" && options.entryReply) return options.entryReply();
    if (path === "/api/me/collections/preview")
      return options.inputFailure
        ? json({ detail: "Accepted source is unavailable" }, 503)
        : json({ endpoints: effective, stages: [] });
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/api/me/sources") {
        const savedSource = { ...body, snapshot: { endpoints: effective } };
        savedSources.push(savedSource);
        return json(savedSource);
      }
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          ...(body.outputId
            ? {
                previewDigest: "a".repeat(64),
                outputId: body.outputId,
                previewScope: "output-update",
                publicationEffect: { version: 1, link: "preserve" },
              }
            : { previewDigest: "checked-phone", outputId: options.output?.id }),
          artifacts: [{ path: "config.json", content: "checked exact client" }],
        });
      return json(body);
    }
    return json(
      path.endsWith("/sources")
        ? savedSources
        : path.endsWith("/resources")
          ? profile.ir.resources
          : path.endsWith("/outputs") && options.output
            ? [options.output]
            : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (options.cachedEntries) client.setQueryData(["platform-entries"], options.cachedEntries);
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={options.output}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    client,
    fetcher,
    onClose,
    unmount: view.unmount,
    editor: within(view.container),
  };
}

it("puts authoritative imported connections and explicit traffic intent together before technical navigation", async () => {
  mount();
  const task = await screen.findByRole("region", { name: "连接与流量" });
  await within(task).findByText("2 个有效连接");
  expect(
    within(
      within(task)
        .getByRole("combobox", { name: "默认流量行为" })
        .closest("label")!,
    ).getByText("直连"),
  ).toBeTruthy();
  expect(within(task).getByText(/已导入的连接尚未用于分流/)).toBeTruthy();
  expect(within(task).getByRole("button", { name: "编辑来源" })).toBeTruthy();
  expect(within(task).queryByRole("button", { name: "添加来源" })).toBeNull();
  expect(
    within(task).getByRole("combobox", { name: "默认流量行为" }),
  ).toBeTruthy();
  expect(
    task.compareDocumentPosition(screen.getByRole("tablist")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "配置名称" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "客户端" })).toBeNull();
});

it.each([
  ["直连", { kind: "direct" }],
  ["London accepted", { kind: "endpoint", ref: "london" }],
  ["策略组 Travel choice", { kind: "group", ref: "travel-choice" }],
] as const)(
  "saves deliberate %s intent without rewriting imported input or creating policies",
  async (label, action) => {
    const profile = fixture();
    profile.ir.groups = [
      {
        id: "travel-choice",
        name: "Travel choice",
        kind: "manual",
        members: [
          { kind: "endpoint", ref: "tokyo" },
          { kind: "endpoint", ref: "london" },
        ],
      },
    ];
    const { writes } = mount(profile);
    await screen.findByText("2 个有效连接");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
    expect(screen.queryByText("Raw filtered node")).toBeNull();
    await user.click(await screen.findByRole("option", { name: label }));
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.defaultAction).toEqual(action);
    expect(writes[0].body.sourceIds).toEqual([source.id]);
    expect(writes[0].body.ir.endpoints).toEqual([]);
    expect(writes[0].body.ir.groups).toEqual(profile.ir.groups);
    expect(writes[0].body.ir.rules).toEqual([]);
  },
);

it("uses the chosen existing subscription client even after changing the new-subscription default", async () => {
  const profile = fixture();
  const output: Output = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: { ...profile.target },
    mode: "nodes-only",
    status: "published",
  };
  const { writes } = mount(profile, { output });
  await screen.findByText("2 个有效连接");
  expect(screen.getByText(/纯节点订阅仅交付连接/)).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(
    screen.getByRole("combobox", { name: "预览客户端" }),
  );
  await user.click(await screen.findByRole("option", { name: "sing-box" }));
  await user.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  const choose = await screen.findByRole("dialog", {
    name: "选择客户端订阅",
  });
  await user.click(
    within(choose).getByRole("button", { name: "检查所选订阅" }),
  );
  await screen.findByRole("dialog", { name: "检查订阅更新「Phone」" });
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0].body.target).toEqual({
    adapterId: "sing-box",
    version: "1.14.3",
  });
  expect(writes[1]).toEqual({
    path: `/api/me/profiles/${profile.id}/preview`,
    body: { outputId: output.id, target: output.target, mode: "nodes-only" },
  });
  expect(writes.some((write) => write.path.includes("/publish"))).toBe(false);
});

it("keeps failed effective inputs and invalid routing references visible outside hidden tabs without discarding them", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "empty-group",
      name: "Incomplete group",
      kind: "manual",
      members: [],
    },
  ];
  profile.ir.defaultAction = { kind: "endpoint", ref: "missing-node" };
  const { writes } = mount(profile, { inputFailure: true });
  await screen.findByText("Accepted source is unavailable");
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  const task = screen.getByRole("region", { name: "连接与流量" });
  expect(within(task).getByText("Accepted source is unavailable")).toBeTruthy();
  expect(within(task).getByText("继续完善策略组")).toBeTruthy();
  expect(
    within(task)
      .getByRole("combobox", { name: "默认流量行为" })
      .closest('[role="combobox"]')?.textContent,
  ).toContain("连接暂无法核对");
  const referenceDetails = within(task).getByLabelText("默认去向的引用详情", {
    selector: "details",
  });
  expect(
    within(task)
      .getByRole("combobox", { name: "默认流量行为" })
      .getAttribute("aria-describedby"),
  ).toBe(referenceDetails.id);
  await user.click(within(referenceDetails).getByText("引用详情"));
  expect(within(referenceDetails).getByText("missing-node")).toBeTruthy();
  expect(within(task).queryByText("0 个有效连接")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
  expect(writes[0].body.ir.groups).toEqual(profile.ir.groups);
});

it("does not claim direct traffic when native override is present and keeps required fields reachable", async () => {
  const profile = fixture();
  profile.ir.nativeOverride = {
    schemaVersion: "1",
    namespace: "routeweaver/native-client",
    target: profile.target,
    format: "json",
    ruleMode: "replace",
    content: '{"unfinished":',
  };
  const { writes } = mount(profile);
  await screen.findByText("2 个有效连接");
  expect(
    screen.getByText(
      "上方保留结构化默认行为；原生规则或设置可能改变最终行为，请按具体客户端检查。",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/已导入的连接尚未用于分流/)).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "" },
  });
  expect(screen.getByText("填写配置名称后可保存或检查。")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: /^(保存并检查|检查发布)$/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: profile.name },
  });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.nativeOverride).toEqual(profile.ir.nativeOverride);
});

it("imports nonzero connections without changing traffic, and canceling the draft never deletes the saved source", async () => {
  const profile = fixture();
  profile.sourceIds = [];
  const { writes, fetcher, onClose } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "编辑来源" }));
  await user.click(screen.getByRole("button", { name: "添加来源" }));
  const sourceDialog = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(sourceDialog.getByLabelText("来源名称"), {
    target: { value: "New imported connections" },
  });
  fireEvent.change(sourceDialog.getByLabelText("节点链接或配置内容"), {
    target: {
      value:
        "socks5://tokyo.example.test:1080#Tokyo\nsocks5://london.example.test:1080#London",
    },
  });
  await user.click(sourceDialog.getByRole("button", { name: "导入来源" }));
  await screen.findByText("2 个有效连接");
  expect(
    within(
      screen.getByRole("combobox", { name: "默认流量行为" }).closest("label")!,
    ).getByText("直连"),
  ).toBeTruthy();
  expect(screen.getByText(/已导入的连接尚未用于分流/)).toBeTruthy();
  expect(writes.map((write) => write.path)).toEqual(["/api/me/sources"]);
  await user.click(screen.getByRole("button", { name: "返回" }));
  const closeDialog = within(
    await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" }),
  );
  await user.click(closeDialog.getByRole("button", { name: "放弃修改" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(writes.map((write) => write.path)).toEqual(["/api/me/sources"]);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(
    false,
  );
});

it("keeps one completion group and safely cancels an explicit discard without saving", async () => {
  const { writes, onClose } = mount(fixture());
  const user = userEvent.setup();
  const actions = screen.getByRole("group", { name: "保存与检查配置" });
  expect(within(actions).getAllByRole("button")).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "保存草稿" })).toHaveLength(1);
  const name = screen.getByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Keep this draft" } });
  await user.click(screen.getByRole("button", { name: "返回" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  const continueEditing = within(confirmation).getByRole("button", {
    name: "继续编辑",
  });
  await waitFor(() => expect(document.activeElement).toBe(continueEditing));
  expect(
    within(confirmation).queryByRole("button", { name: /保存/ }),
  ).toBeNull();
  await user.click(continueEditing);
  expect((name as HTMLInputElement).value).toBe("Keep this draft");
  expect(writes).toHaveLength(0);
  expect(onClose).not.toHaveBeenCalled();
});

it.each([
  ["domain", "domain-suffix", "域名后缀"],
  ["domain-suffix", "domain", "完整域名"],
])(
  "preserves the domain, destination and sibling order when changing %s to %s",
  async (from, to, label) => {
    const profile = fixture();
    profile.ir.rules = [
      {
        id: "chat-rule",
        match: { op: from, value: "chatgpt.com" },
        action: { kind: "endpoint", ref: "tokyo" },
      },
      {
        id: "other-rule",
        match: { op: "domain", value: "private.example.com" },
        action: { kind: "reject" },
      },
    ];
    const { writes } = mount(profile);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "分流规则" }));
    await user.click(
      screen.getAllByRole("combobox", { name: "规则匹配方式" })[0],
    );
    await user.click(await screen.findByRole("option", { name: label }));
    expect(
      screen.getAllByRole("textbox", { name: "规则匹配值" })[0],
    ).toHaveProperty("value", "chatgpt.com");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.rules).toEqual([
      {
        id: "chat-rule",
        match: { op: to, value: "chatgpt.com" },
        action: { kind: "endpoint", ref: "tokyo" },
      },
      {
        id: "other-rule",
        match: { op: "domain", value: "private.example.com" },
        action: { kind: "reject" },
      },
    ]);
  },
);

it.each([
  ["and", "or", "任一满足（OR）"],
  ["or", "and", "全部满足（AND）"],
])(
  "preserves every nested condition and destination when changing %s to %s",
  async (from, to, label) => {
    const profile = fixture();
    profile.ir.rules = [
      {
        id: "nested-rule",
        match: {
          op: from,
          children: [
            { op: "domain-suffix", value: "example.com" },
            {
              op: "not",
              children: [{ op: "domain", value: "private.example.com" }],
            },
          ],
        },
        action: { kind: "reject" },
      },
    ];
    const { writes } = mount(profile);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "分流规则" }));
    await user.click(
      screen.getAllByRole("combobox", { name: "规则匹配方式" })[0],
    );
    await user.click(await screen.findByRole("option", { name: label }));
    expect(
      screen
        .getAllByRole("textbox", { name: "规则匹配值" })
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["example.com", "private.example.com"]);
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.rules).toEqual([
      {
        id: "nested-rule",
        match: {
          op: to,
          children: [
            { op: "domain-suffix", value: "example.com" },
            {
              op: "not",
              children: [{ op: "domain", value: "private.example.com" }],
            },
          ],
        },
        action: { kind: "reject" },
      },
    ]);
  },
);

it("adds an excluded domain without rewriting the authored domain or neighboring rule", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: { op: "domain-suffix", value: "chatgpt.com" },
      action: { kind: "reject" },
    },
    {
      id: "neighbor",
      match: { op: "domain", value: "other.example" },
      action: { kind: "direct" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getAllByRole("button", { name: "添加条件" })[0]);
  const fields = screen.getAllByRole("textbox", { name: "规则匹配值" });
  expect((fields[0] as HTMLInputElement).value).toBe("chatgpt.com");
  await user.type(fields[1], "private.chatgpt.com");
  await user.click(
    screen.getAllByRole("combobox", { name: "条件匹配关系" })[1],
  );
  await user.click(await screen.findByRole("option", { name: "不匹配" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "site",
      match: {
        op: "and",
        children: [
          { op: "domain-suffix", value: "chatgpt.com" },
          {
            op: "not",
            children: [{ op: "domain-suffix", value: "private.chatgpt.com" }],
          },
        ],
      },
      action: { kind: "reject" },
    },
    {
      id: "neighbor",
      match: { op: "domain", value: "other.example" },
      action: { kind: "direct" },
    },
  ]);
});

it("keeps a populated condition unchanged until replacement is confirmed and returns focus on cancel", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: { op: "domain", value: "chatgpt.com" },
      action: { kind: "reject" },
    },
  ];
  const { writes, onClose } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  const selector = screen.getByRole("combobox", { name: "规则匹配方式" });
  await user.click(selector);
  await user.click(await screen.findByRole("option", { name: "IP 网段" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "替换当前匹配条件？",
  });
  expect(
    (
      screen.getByRole("textbox", {
        name: "规则匹配值",
        hidden: true,
      }) as HTMLInputElement
    ).value,
  ).toBe("chatgpt.com");
  expect(writes).toHaveLength(0);
  await user.click(
    within(confirmation).getByRole("button", { name: "保留原条件" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(selector));
  await user.click(screen.getByRole("button", { name: "返回" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("放弃未保存的修改？")).toBeNull();
});

it("negates a complete nested group without changing its children or destination", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "nested",
      match: {
        op: "or",
        children: [
          { op: "domain", value: "a.example" },
          {
            op: "and",
            children: [
              { op: "domain-suffix", value: "b.example" },
              { op: "ip-cidr", value: "192.0.2.0/24" },
            ],
          },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const { writes, editor } = mount(profile);
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  await user.click(editor.getAllByRole("button", { name: "条件操作" })[0]);
  await user.click(await screen.findByRole("menuitem", { name: "不匹配此组" }));
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "nested",
      match: {
        op: "not",
        children: [
          {
            op: "or",
            children: [
              { op: "domain", value: "a.example" },
              {
                op: "and",
                children: [
                  { op: "domain-suffix", value: "b.example" },
                  { op: "ip-cidr", value: "192.0.2.0/24" },
                ],
              },
            ],
          },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("adds beside an already-negated nested group without stripping it", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "nested",
      match: {
        op: "or",
        children: [
          { op: "domain", value: "a.example" },
          {
            op: "and",
            children: [
              { op: "domain-suffix", value: "b.example" },
              { op: "ip-cidr", value: "192.0.2.0/24" },
            ],
          },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  profile.ir.rules[0].match = {
    op: "not",
    children: [profile.ir.rules[0].match],
  };
  const { writes, editor } = mount(profile);
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  // The root's add action comes after the nested group's add actions.
  const rootCard = editor
    .getAllByRole("button", { name: "条件操作" })[0]
    .closest(".rule-card")!;
  const adds = within(rootCard as HTMLElement).getAllByRole("button", {
    name: "添加条件",
  });
  await user.click(adds[adds.length - 1]);
  const fields = editor.getAllByRole("textbox", { name: "规则匹配值" });
  await user.type(fields[fields.length - 1], "c.example");
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "nested",
      match: {
        op: "and",
        children: [
          {
            op: "not",
            children: [
              {
                op: "or",
                children: [
                  { op: "domain", value: "a.example" },
                  {
                    op: "and",
                    children: [
                      { op: "domain-suffix", value: "b.example" },
                      { op: "ip-cidr", value: "192.0.2.0/24" },
                    ],
                  },
                ],
              },
            ],
          },
          { op: "domain-suffix", value: "c.example" },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("confirms actual replacement, focuses the new field, and preserves the rule destination", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: { op: "domain", value: "chatgpt.com" },
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("combobox", { name: "规则匹配方式" }));
  await user.click(await screen.findByRole("option", { name: "IP 网段" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "替换当前匹配条件？",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "替换条件" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
    ).toBeNull(),
  );
  const input = screen.getByRole("textbox", { name: "规则匹配值" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect((input as HTMLInputElement).value).toBe("");
  await user.type(input, "192.0.2.0/24");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "site",
      match: { op: "ip-cidr", value: "192.0.2.0/24" },
      action: { kind: "reject" },
    },
  ]);
});

it("changes a canonical empty leaf without a discard prompt", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "blank",
      match: { op: "domain", value: "" },
      action: { kind: "direct" },
    },
  ];
  mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("combobox", { name: "规则匹配方式" }));
  await user.click(await screen.findByRole("option", { name: "IP 网段" }));
  expect(
    screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
  ).toBeNull();
  expect(screen.getByPlaceholderText("192.168.0.0/16")).toBeTruthy();
});

it("retains an unknown expression and its opaque payload when adding a condition", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "future",
      match: {
        op: "future-match",
        value: "original",
        future: { list: ["one", "two"] },
      } as any,
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  expect(screen.getByText("未支持的匹配方式：future-match")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "规则匹配值" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "添加条件" }));
  await user.type(
    screen.getByRole("textbox", { name: "规则匹配值" }),
    "new.example",
  );
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "future",
      match: {
        op: "and",
        children: [
          {
            op: "future-match",
            value: "original",
            future: { list: ["one", "two"] },
          },
          { op: "domain-suffix", value: "new.example" },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("requires confirmation to discard a composite and keeps its entire tree on Escape", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "group",
      match: {
        op: "and",
        children: [
          { op: "domain", value: "a.example" },
          { op: "domain-suffix", value: "b.example" },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  const menu = screen.getAllByRole("button", { name: "条件操作" })[0];
  await user.click(menu);
  await user.hover(await screen.findByRole("menuitem", { name: "替换为" }));
  const replacement = await screen.findByRole("menuitem", { name: "IP 网段" });
  replacement.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("alertdialog", {
    name: "替换当前匹配条件？",
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "保留原条件" }),
    ),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(menu));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "group",
      match: {
        op: "and",
        children: [
          { op: "domain", value: "a.example" },
          { op: "domain-suffix", value: "b.example" },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("disposes a pending destructive confirmation when the owning editor closes", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: { op: "domain", value: "chatgpt.com" },
      action: { kind: "reject" },
    },
  ];
  const { writes, unmount } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("combobox", { name: "规则匹配方式" }));
  await user.click(await screen.findByRole("option", { name: "IP 网段" }));
  await screen.findByRole("alertdialog", { name: "替换当前匹配条件？" });
  unmount();
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
    ).toBeNull(),
  );
  expect(writes).toHaveLength(0);
});

it("removes only explicit negation while retaining the child and its opaque fields", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: {
        op: "not",
        children: [
          { op: "domain", value: "chatgpt.com", future: [1, 2] } as any,
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("combobox", { name: "条件匹配关系" }));
  await user.click(await screen.findByRole("option", { name: "匹配" }));
  expect(
    screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "site",
      match: { op: "domain", value: "chatgpt.com", future: [1, 2] },
      action: { kind: "reject" },
    },
  ]);
});

it("retains a malformed known group applied through JSON without coercion or a render crash", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "malformed",
      match: { op: "domain", value: "original.example" },
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByText("高级：配置意图与目标版本"));
  await user.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  const ir = {
    ...profile.ir,
    rules: [
      {
        id: "malformed",
        match: {
          op: "and",
          children: "opaque-children",
          future: { keep: true },
        },
        action: { kind: "reject" },
      },
    ],
  };
  fireEvent.change(
    await screen.findByRole("textbox", { name: "配置意图 JSON 文本" }),
    { target: { value: JSON.stringify(ir) } },
  );
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await user.click(screen.getByRole("tab", { name: "分流规则" }));
  expect(
    await screen.findByText("条件结构暂不支持，原内容已保留"),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "规则匹配方式" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "添加条件" }));
  await user.type(
    screen.getByRole("textbox", { name: "规则匹配值" }),
    "new.example",
  );
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "malformed",
      match: {
        op: "and",
        children: [
          { op: "and", children: "opaque-children", future: { keep: true } },
          { op: "domain-suffix", value: "new.example" },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it.each([
  { op: "not", children: [null] },
  { op: "or", children: [7] },
  { op: { unexpected: "operator" }, value: "keep" },
])(
  "keeps an unrepresentable condition unchanged without recursing or rendering its raw operator %#",
  async (malformed) => {
    const profile = fixture();
    profile.ir.rules = [
      { id: "retained", match: malformed as any, action: { kind: "reject" } },
    ];
    const { writes } = mount(profile);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "分流规则" }));
    expect(screen.getByText("条件结构暂不支持，原内容已保留")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "规则匹配方式" })).toBeNull();
    if (typeof malformed.op !== "string") {
      expect(screen.queryByRole("button", { name: "添加条件" })).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.rules[0].match).toEqual(malformed);
  },
);

it("retains unexpected leaf fields when changing the compatible domain match kind", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "retained",
      match: {
        op: "domain",
        value: "chatgpt.com",
        children: [{ op: "future", value: "keep" }],
        future: { preserve: true },
      } as any,
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("combobox", { name: "规则匹配方式" }));
  await user.click(await screen.findByRole("option", { name: "域名后缀" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "retained",
      match: {
        op: "domain-suffix",
        value: "chatgpt.com",
        children: [{ op: "future", value: "keep" }],
        future: { preserve: true },
      },
      action: { kind: "reject" },
    },
  ]);
});

it("stops interpreting nested input beyond the domain depth bound without deleting it", async () => {
  const profile = fixture();
  let match: any = { op: "domain", value: "deep.example" };
  for (let depth = 0; depth < 129; depth++)
    match = { op: "not", children: [match] };
  profile.ir.rules = [{ id: "deep", match, action: { kind: "reject" } }];
  const expected = JSON.parse(JSON.stringify(profile.ir.rules));
  const { writes, editor } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  expect(editor.getByText("条件结构暂不支持，原内容已保留")).toBeTruthy();
  expect(editor.queryByRole("textbox", { name: "规则匹配值" })).toBeNull();
  const save = within(toolbar).getByRole("button", { name: "保存草稿" });
  expect(save.isConnected).toBe(true);
  await user.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual(expected);
});

it("keeps keyboard focus in the edited condition after negation", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "exception",
      match: { op: "domain-suffix", value: "private.chatgpt.com" },
      action: { kind: "reject" },
    },
  ];
  const { writes, editor } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  const polarity = editor.getByRole("combobox", { name: "条件匹配关系" });
  polarity.focus();
  // Open the official combobox and navigate its real command list by keyboard.
  await user.keyboard("{Enter}");
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() =>
    expect(
      within(polarity.closest('[role="combobox"]') as HTMLElement).getByText(
        "不匹配",
      ),
    ).toBeTruthy(),
  );
  expect(document.activeElement).toBe(polarity);
  const field = editor.getByRole("textbox", { name: "规则匹配值" });
  await user.tab();
  expect(document.activeElement).toBe(field);
  expect((field as HTMLInputElement).value).toBe("private.chatgpt.com");
  await user.tab();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("条件操作");
  expect(document.activeElement?.closest(".match-editor")).toBe(
    field.closest(".match-editor"),
  );
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "exception",
      match: {
        op: "not",
        children: [{ op: "domain-suffix", value: "private.chatgpt.com" }],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("edits a scalar exclusion through visible polarity while preserving its exact saved intent", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "site",
      match: {
        op: "domain-suffix",
        value: "chatgpt.com",
        future: { retained: true },
      } as any,
      action: { kind: "reject" },
    },
  ];
  const { writes, editor, unmount } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  await user.click(editor.getByRole("combobox", { name: "条件匹配关系" }));
  await user.click(await screen.findByRole("option", { name: "不匹配" }));
  expect(editor.queryByText("不匹配以下条件")).toBeNull();
  expect(editor.getAllByRole("button", { name: "条件操作" })).toHaveLength(1);
  expect(
    (editor.getByRole("textbox", { name: "规则匹配值" }) as HTMLInputElement)
      .value,
  ).toBe("chatgpt.com");
  await user.click(editor.getByRole("combobox", { name: "规则匹配方式" }));
  await user.click(await screen.findByRole("option", { name: "完整域名" }));
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  const expected = [
    {
      id: "site",
      match: {
        op: "not",
        children: [
          { op: "domain", value: "chatgpt.com", future: { retained: true } },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  expect(writes[0].body.ir.rules).toEqual(expected);
  expect(writes[0].body.ir.defaultAction).toEqual(profile.ir.defaultAction);
  unmount();
  const reloaded = mount(writes[0].body);
  await user.click(
    await reloaded.editor.findByRole("tab", { name: "分流规则" }),
  );
  expect(
    reloaded.editor.getByRole("combobox", { name: "条件匹配关系" }),
  ).toBeTruthy();
  expect(reloaded.editor.queryByText("不匹配以下条件")).toBeNull();
  expect(
    (
      reloaded.editor.getByRole("textbox", {
        name: "规则匹配值",
      }) as HTMLInputElement
    ).value,
  ).toBe("chatgpt.com");
});

it("projects an existing negative scalar without dirtying or normalizing its value", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "negative",
      match: {
        op: "not",
        children: [{ op: "domain-suffix", value: ".example.com" }],
      },
      action: { kind: "direct" },
    },
  ];
  const { editor, writes, onClose } = mount(profile);
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  const polarity = editor.getByRole("combobox", { name: "条件匹配关系" });
  expect(
    within(polarity.closest('[role="combobox"]') as HTMLElement).getByText(
      "不匹配",
    ),
  ).toBeTruthy();
  expect(editor.queryByText("不匹配以下条件")).toBeNull();
  expect(
    (editor.getByRole("textbox", { name: "规则匹配值" }) as HTMLInputElement)
      .value,
  ).toBe(".example.com");
  await user.click(editor.getByRole("button", { name: "返回" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(0);
  expect(screen.queryByText("放弃未保存的修改？")).toBeNull();
});

it("removes only a pure negative wrapper when choosing positive matching", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "negative",
      match: {
        op: "not",
        children: [
          {
            op: "domain-suffix",
            value: ".example.com",
            future: { retained: true },
          } as any,
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const { editor, writes } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  await user.click(editor.getByRole("combobox", { name: "条件匹配关系" }));
  await user.click(await screen.findByRole("option", { name: "匹配" }));
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "negative",
      match: {
        op: "domain-suffix",
        value: ".example.com",
        future: { retained: true },
      },
      action: { kind: "reject" },
    },
  ]);
});

it("keeps opaque, group, and double negative wrappers explicit without rewriting them", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "opaque",
      match: {
        op: "not",
        future: { retained: true },
        children: [{ op: "domain", value: "a.example" }],
      } as any,
      action: { kind: "reject" },
    },
    {
      id: "group",
      match: {
        op: "not",
        children: [
          {
            op: "or",
            children: [
              { op: "domain", value: "b.example" },
              { op: "domain", value: "c.example" },
            ],
          },
        ],
      },
      action: { kind: "direct" },
    },
    {
      id: "double",
      match: {
        op: "not",
        children: [
          { op: "not", children: [{ op: "domain", value: "d.example" }] },
        ],
      },
      action: { kind: "reject" },
    },
    {
      id: "structural",
      match: {
        op: "not",
        children: [
          {
            op: "domain",
            value: "e.example",
            children: [{ op: "future", value: "retained" }],
          },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const expected = JSON.parse(JSON.stringify(profile.ir.rules));
  const { editor, writes } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  expect(editor.getAllByText("不匹配以下条件")).toHaveLength(4);
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual(expected);
});

it.each([false, true])(
  "preserves scalar negation across incompatible replacement confirmation=%s",
  async (confirm) => {
    const profile = fixture();
    profile.ir.rules = [
      {
        id: "negative",
        match: {
          op: "not",
          children: [{ op: "domain-suffix", value: "private.chatgpt.com" }],
        },
        action: { kind: "reject" },
      },
    ];
    const { editor, writes } = mount(profile);
    const toolbar = await editor.findByRole("group", {
      name: "保存与检查配置",
    });
    const user = userEvent.setup();
    await user.click(await editor.findByRole("tab", { name: "分流规则" }));
    const kind = editor.getByRole("combobox", { name: "规则匹配方式" });
    await user.click(kind);
    await user.click(await screen.findByRole("option", { name: "IP 网段" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "替换当前匹配条件？",
    });
    expect(within(dialog).getByText(/保留不匹配关系/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", {
        name: confirm ? "替换条件" : "保留原条件",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "替换当前匹配条件？" }),
      ).toBeNull(),
    );
    if (confirm) {
      const field = editor.getByRole("textbox", { name: "规则匹配值" });
      await waitFor(() => expect(document.activeElement).toBe(field));
      await user.type(field, "192.0.2.0/24");
    } else {
      await waitFor(() => expect(document.activeElement).toBe(kind));
    }
    await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.rules).toEqual([
      {
        id: "negative",
        match: {
          op: "not",
          children: [
            confirm
              ? { op: "ip-cidr", value: "192.0.2.0/24" }
              : { op: "domain-suffix", value: "private.chatgpt.com" },
          ],
        },
        action: { kind: "reject" },
      },
    ]);
  },
);

it("preserves a selected rule resource when changing scalar polarity", async () => {
  const profile = fixture();
  const resource = {
    id: "accepted-domains",
    name: "例外规则文件",
    revision: "1",
    digest: "accepted-digest",
    format: "mihomo-yaml",
    location: "inline",
    updatePolicy: "manual",
  };
  profile.ir.resources = [resource];
  profile.ir.rules = [
    {
      id: "resource-rule",
      match: { op: "not", children: [{ op: "resource", value: resource.id }] },
      action: { kind: "reject" },
    },
  ];
  const { editor, writes } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  const file = editor.getByRole("combobox", { name: "匹配规则文件" });
  expect(
    await within(file.closest('[role="combobox"]') as HTMLElement).findByText(
      "例外规则文件",
    ),
  ).toBeTruthy();
  expect(editor.queryByText("不匹配以下条件")).toBeNull();
  await user.click(editor.getByRole("combobox", { name: "条件匹配关系" }));
  await user.click(await screen.findByRole("option", { name: "匹配" }));
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "resource-rule",
      match: { op: "resource", value: "accepted-domains" },
      action: { kind: "reject" },
    },
  ]);
  expect(writes[0].body.ir.resources).toEqual([resource]);
});

it("adds beside a projected negative scalar without stripping its negation", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "negative",
      match: {
        op: "not",
        children: [{ op: "domain", value: "private.example" }],
      },
      action: { kind: "reject" },
    },
  ];
  const { editor, writes } = mount(profile);
  const toolbar = await editor.findByRole("group", { name: "保存与检查配置" });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("tab", { name: "分流规则" }));
  await user.click(editor.getByRole("button", { name: "添加条件" }));
  const fields = editor.getAllByRole("textbox", { name: "规则匹配值" });
  expect((fields[0] as HTMLInputElement).value).toBe("private.example");
  await waitFor(() => expect(document.activeElement).toBe(fields[1]));
  await user.type(fields[1], "example");
  await user.click(within(toolbar).getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id: "negative",
      match: {
        op: "and",
        children: [
          { op: "not", children: [{ op: "domain", value: "private.example" }] },
          { op: "domain-suffix", value: "example" },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("removes empty traffic-outcome chrome while retaining the same polite live region", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "travel-choice",
      name: "Travel choice",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "tokyo" }],
    },
  ];
  mount(profile);
  const message = await screen.findByText("已导入的连接尚未用于分流。");
  const live = message.parentElement!;
  expect(live.getAttribute("aria-live")).toBe("polite");
  const style = document.createElement("style");
  style.textContent = (
    await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
  ).build([...live.classList]);
  document.head.append(style);
  try {
    expect(getComputedStyle(live).position).not.toBe("absolute");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
    await user.click(
      await screen.findByRole("option", { name: "策略组 Travel choice" }),
    );
    expect(live.isConnected).toBe(true);
    expect(live.textContent).toBe("");
    expect(getComputedStyle(live).position).toBe("absolute");
    expect(getComputedStyle(live).height).toBe("1px");
    expect(getComputedStyle(live).padding).toBe("0px");
    expect(getComputedStyle(live).display).not.toBe("none");
    expect(live.hasAttribute("aria-hidden")).toBe(false);
    await user.click(screen.getByRole("combobox", { name: "默认流量行为" }));
    await user.click(await screen.findByRole("option", { name: "直连" }));
    expect(
      await screen.findByText("已导入的连接尚未用于分流。"),
    ).toHaveProperty("parentElement", live);
    expect(getComputedStyle(live).position).not.toBe("absolute");
    expect(getComputedStyle(live).height).not.toBe("1px");
  } finally {
    style.remove();
  }
});

it.each(["native", "nodes-only"] as const)(
  "retains meaningful %s traffic consequences",
  async (kind) => {
    const profile = fixture();
    if (kind === "native") {
      profile.ir.nativeOverride = {
        schemaVersion: "1",
        namespace: "routeweaver/native-client",
        target: profile.target,
        format: "json",
        ruleMode: "replace",
        content: "{}",
      };
    } else {
      profile.mode = "nodes-only";
      profile.ir.defaultAction = { kind: "reject" };
    }
    mount(profile);
    const copy =
      kind === "native"
        ? "上方保留结构化默认行为；原生规则或设置可能改变最终行为，请按具体客户端检查。"
        : "纯节点订阅仅交付连接；上方分流行为保存在共享配置中，供完整配置使用。";
    const message = await screen.findByText(copy);
    const live = message.parentElement!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toContain(copy);
    expect(live.matches(":empty")).toBe(false);
  },
);

const summaryEntry: PlatformEntry = { id: "platform-one", name: "平台入口样例", routeId: "route-one", credentialVersion: "v1", status: "active" };
function entryProfile(mixed = false) {
  const profile = mixed ? fixture() : { ...emptyProfile(), id: "entry-summary", name: "入口配置" };
  profile.platformEntryIds = [summaryEntry.id];
  profile.ir.defaultAction = { kind: "endpoint", ref: summaryEntry.id };
  return profile;
}

it.each([false, true])("scopes own connections and platform entries equally in the summary (mixed: %s)", async (mixed) => {
  mount(entryProfile(mixed), { entryReply: async () => json([summaryEntry]) });
  const own = await screen.findByText(`自有连接：${mixed ? 2 : 0} 个`);
  const platform = await screen.findByText("平台入口：1 个");
  expect(own.tagName).toBe("STRONG");
  expect(platform.tagName).toBe("STRONG");
  expect(own.parentElement).toBe(platform.parentElement);
  expect(screen.getByText("平台入口凭据在发布时解析。")).toBeTruthy();
  expect(screen.queryByText("0 个有效连接")).toBeNull();
});

it("keeps direct-only and own-only summaries concise without inventing platform entries", async () => {
  const view = mount(emptyProfile());
  await screen.findByText("直连与拒绝不需要代理连接");
  expect(screen.queryByText(/^平台入口：/)).toBeNull();
  view.unmount();
  mount();
  await screen.findByText("2 个有效连接");
  expect(screen.queryByText(/^平台入口：/)).toBeNull();
});

it("keeps a confirmed missing platform selection separate from available entry counts", async () => {
  const { writes } = mount(entryProfile(), { entryReply: async () => json([]) });
  await screen.findByText("1 个平台入口暂不可用，原选择已保留。");
  expect(screen.queryByText("平台入口：1 个")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.platformEntryIds).toEqual([summaryEntry.id]);
});

it.each([false, true])("does not count platform entries while loading or after failure and recovers explicitly (cached: %s)", async (cached) => {
  let reply: () => Promise<Response> = () => new Promise(() => {});
  const { client } = mount(entryProfile(), { cachedEntries: cached ? [summaryEntry] : undefined, entryReply: () => reply() });
  await screen.findByText("正在核对平台入口…");
  expect(screen.queryByText("平台入口：1 个")).toBeNull();
  expect(screen.queryByText(/个平台入口暂不可用/)).toBeNull();
  reply = async () => json({ detail: "入口清单读取失败" }, 503);
  await act(async () => { await client.cancelQueries({ queryKey: ["platform-entries"] }); await client.invalidateQueries({ queryKey: ["platform-entries"] }); });
  await screen.findByText("平台入口暂无法核对");
  expect(screen.queryByText("平台入口：1 个")).toBeNull();
  expect(screen.queryByText(/个平台入口暂不可用/)).toBeNull();
  reply = async () => json([summaryEntry]);
  await userEvent.setup().click(screen.getByRole("button", { name: "重新加载平台入口" }));
  await screen.findByText("平台入口：1 个");
  expect(screen.queryByText("平台入口暂无法核对")).toBeNull();
});

it("keeps a platform entry count separate from a failed own-connection read", async () => {
  mount(entryProfile(true), { inputFailure: true, entryReply: async () => json([summaryEntry]) });
  await screen.findByText("自有连接暂不可用");
  expect(screen.getByText("平台入口：1 个")).toBeTruthy();
  expect(screen.queryByText("自有连接：0 个")).toBeNull();
  expect(screen.queryByText("自有连接：2 个")).toBeNull();
});

it.each(["own", "direct"] as const)("keeps unselected platform catalog failures out of the %s summary but preserves recovery", async (kind) => {
  let reply: () => Promise<Response> = () => new Promise(() => {});
  const { client } = mount(kind === "own" ? fixture() : emptyProfile(), { entryReply: () => reply() });
  const summaryText = kind === "own" ? "2 个有效连接" : "直连与拒绝不需要代理连接";
  await screen.findByText(summaryText);
  expect(screen.queryByText("正在核对平台入口…")).toBeNull();
  reply = async () => json({ detail: "入口清单读取失败" }, 503);
  await act(async () => { await client.cancelQueries({ queryKey: ["platform-entries"] }); await client.invalidateQueries({ queryKey: ["platform-entries"] }); });
  await screen.findByText("入口清单读取失败");
  expect(screen.getByText(summaryText)).toBeTruthy();
  expect(screen.queryByText("平台入口暂无法核对")).toBeNull();
  expect(screen.queryByText(/^平台入口：/)).toBeNull();
  reply = async () => json([summaryEntry]);
  await userEvent.setup().click(screen.getByRole("button", { name: "重新加载平台入口" }));
  await waitFor(() => expect(screen.queryByText("入口清单读取失败")).toBeNull());
  expect(screen.queryByText(/^平台入口：/)).toBeNull();
  expect(screen.getByText(summaryText)).toBeTruthy();
});

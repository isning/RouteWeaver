// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateOutput } from "./Subscriptions";
import { RoutingReview } from "./RoutingSummary";

const output = {
  id: "phone-output",
  name: "Phone",
  profileId: "shared-profile",
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  status: "published",
};
const intent = {
  version: 1,
  kind: "portable",
  ruleCount: 0,
  rules: [],
  defaultAction: { kind: "group", ref: "primary", label: "Primary" },
};
const uses = {
  scope: "direct",
  state: "available",
  default: false,
  rules: [],
  groups: [],
  omittedRuleCount: 0,
  omittedGroupCount: 0,
};
const emptyCategory = {
  state: "available",
  beforeCount: 0,
  afterCount: 0,
  changedCount: 0,
  rows: [],
  omittedRowCount: 0,
};
const group = {
  id: "primary",
  kind: "modified",
  before: { label: "Primary", selection: "manual", memberCount: 1 },
  after: { label: "Primary", selection: "manual", memberCount: 1 },
  nameChanged: false,
  strategyChanged: false,
  parametersChanged: false,
  membersAdded: [{ kind: "endpoint", ref: "new-connection", label: "Tokyo" }],
  membersRemoved: [
    { kind: "endpoint", ref: "old-connection", label: "London" },
  ],
  omittedAddedMemberCount: 0,
  omittedRemovedMemberCount: 0,
  memberOrderChanged: false,
  usesBefore: { ...uses, default: true },
  usesAfter: { ...uses, default: true },
};
const clients: QueryClient[] = [];
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function review(
  semanticChanges: unknown,
  extras: Record<string, unknown> = {},
) {
  const requests: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const path = String(input);
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json(
        path.endsWith("/publish")
          ? output
          : {
              valid: true,
              outputId: output.id,
              previewScope: "output-update",
              previewDigest: "a".repeat(64),
              publicationEffect: { version: 1, link: "preserve" },
              publishedRoutingIntent: intent,
              routingIntent: intent,
              semanticChanges,
              artifacts: [],
              ...extras,
            },
      );
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <UpdateOutput output={output} onClose={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("兼容检查通过。");
  return requests;
}
it("explains a member-only group change before unchanged rules without opening technical JSON", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    groups: {
      ...emptyCategory,
      beforeCount: 1,
      afterCount: 1,
      changedCount: 1,
      rows: [group],
    },
    nodes: emptyCategory,
  });
  const changes = screen.getByRole("region", { name: "策略组变化" });
  expect(within(changes).getByText("Primary")).toBeTruthy();
  expect(
    within(changes).getByText("加入成员：连接「Tokyo」", { selector: "p" }),
  ).toBeTruthy();
  expect(
    within(changes).getByText("移除成员：连接「London」", { selector: "p" }),
  ).toBeTruthy();
  expect(
    changes.compareDocumentPosition(
      screen.getByRole("region", { name: "分流比较" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByText(/未比较规则文件内容、策略组内容和节点设置/),
  ).toBeNull();
  expect(screen.getByText("未比较规则文件内容和客户端运行设置。")).toBeTruthy();
  expect(screen.getByText("链接不变，其他订阅不受影响。")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", false);
});

it("puts changed connections before unchanged groups and exposes categories rather than private values", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    groups: emptyCategory,
    nodes: {
      ...emptyCategory,
      beforeCount: 1,
      afterCount: 1,
      changedCount: 1,
      rows: [
        {
          id: "tokyo",
          kind: "modified",
          beforeLabel: "Tokyo",
          afterLabel: "Tokyo",
          nameChanged: false,
          settingsChanged: true,
          changedCategories: ["endpoint", "authentication", "security"],
          usesBefore: uses,
          usesAfter: uses,
          password: "private-password-must-not-display",
          settingsDigest: "private-hash-must-not-display",
        },
      ],
    },
  });
  const changes = screen.getByRole("region", { name: "连接变化" });
  expect(within(changes).queryByText("修改连接")).toBeNull();
  expect(
    within(changes).getByText("连接设置已更改：服务器地址或端口、认证、安全。"),
  ).toBeTruthy();
  expect(
    changes.compareDocumentPosition(screen.getByText("策略组未变化。")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("private-password");
  expect(document.body.textContent).not.toContain("private-hash");
});

it("keeps rule-only changes ahead of a compact unchanged group and connection summary", async () => {
  await review(
    {
      version: 1,
      renderedConfigurationChanged: true,
      groups: emptyCategory,
      nodes: emptyCategory,
    },
    {
      routingIntent: { ...intent, defaultAction: { kind: "direct" } },
    },
  );
  expect(screen.getByText("默认去向已更换")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "策略组变化" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "连接变化" })).toBeNull();
  const unchanged = screen.getByText("策略组和连接未变化。");
  expect(
    screen
      .getByRole("region", { name: "分流比较" })
      .compareDocumentPosition(unchanged) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("names a strategy-only change using the same choices as the editor", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    nodes: emptyCategory,
    groups: {
      ...emptyCategory,
      beforeCount: 1,
      afterCount: 1,
      changedCount: 1,
      rows: [
        {
          ...group,
          membersAdded: [],
          membersRemoved: [],
          strategyChanged: true,
          before: { ...group.before, selection: "url-test" },
          after: { ...group.after, selection: "fallback" },
        },
      ],
    },
  });
  const changes = within(screen.getByRole("region", { name: "策略组变化" }));
  expect(changes.getByText("选择方式")).toBeTruthy();
  expect(changes.getByText("延迟优选")).toBeTruthy();
  expect(changes.getByText("故障切换")).toBeTruthy();
});

it("distinguishes same-name identity replacement and keeps same-byte review eligible for explicit selected publication", async () => {
  const requests = await review({
    version: 1,
    renderedConfigurationChanged: false,
    groups: emptyCategory,
    nodes: {
      ...emptyCategory,
      beforeCount: 1,
      afterCount: 1,
      changedCount: 2,
      rows: [
        {
          id: "new-tokyo",
          kind: "added",
          afterLabel: "Tokyo",
          nameChanged: false,
          settingsChanged: false,
          changedCategories: [],
          usesBefore: uses,
          usesAfter: uses,
        },
        {
          id: "old-tokyo",
          kind: "removed",
          beforeLabel: "Tokyo",
          nameChanged: false,
          settingsChanged: false,
          changedCategories: [],
          usesBefore: uses,
          usesAfter: uses,
        },
      ],
    },
  });
  const changes = within(screen.getByRole("region", { name: "连接变化" }));
  expect(changes.getByText("新增连接")).toBeTruthy();
  expect(changes.getByText("移除连接")).toBeTruthy();
  expect(changes.getAllByText("Tokyo")).toHaveLength(2);
  for (const detail of changes.getAllByText("查看对象标识"))
    await userEvent.click(detail);
  expect(changes.getByText("new-tokyo")).toBeTruthy();
  expect(changes.getByText("old-tokyo")).toBeTruthy();
  expect(screen.getByText("生成的配置文本与已发布版本相同。")).toBeTruthy();
  expect(screen.queryByText(/无需发布|客户端已生效|待更新内容/)).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  );
  expect(requests).toEqual([
    {
      path: "/api/me/profiles/shared-profile/preview",
      body: { outputId: output.id, target: output.target, mode: "full" },
    },
    {
      path: "/api/me/outputs/phone-output/publish",
      body: { previewDigest: "a".repeat(64) },
    },
  ]);
});

it("labels bounded member and direct-reference lists without turning unknown uses into none", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    nodes: emptyCategory,
    groups: {
      ...emptyCategory,
      beforeCount: 4,
      afterCount: 4,
      changedCount: 3,
      omittedRowCount: 2,
      rows: [
        {
          ...group,
          omittedAddedMemberCount: 2,
          omittedRemovedMemberCount: 1,
          memberOrderChanged: true,
          usesBefore: { ...uses, state: "unavailable" },
          usesAfter: {
            ...uses,
            state: "partial",
            default: true,
            rules: [{ id: "rule-4", index: 4 }],
            groups: [{ kind: "group", ref: "outer", label: "Outer" }],
            omittedRuleCount: 3,
            omittedGroupCount: 2,
          },
        },
      ],
    },
  });
  const changes = within(screen.getByRole("region", { name: "策略组变化" }));
  expect(changes.getByText("另有 2 个加入成员未列出。")).toBeTruthy();
  expect(changes.getByText("另有 1 个移除成员未列出。")).toBeTruthy();
  expect(changes.getByText("另有 2 个策略组变化未列出。")).toBeTruthy();
  for (const label of [
    "另有 2 个加入成员未列出。",
    "另有 1 个移除成员未列出。",
    "另有 2 个策略组变化未列出。",
  ])
    expect(changes.getByText(label).closest("details")).toBeNull();
  expect(changes.getByText("成员顺序已调整。")).toBeTruthy();
  await userEvent.click(changes.getByText("查看直接引用（部分不可用）"));
  expect(changes.getByText("直接引用信息不可用。")).toBeTruthy();
  expect(changes.getByText("默认去向、规则 4、策略组「Outer」")).toBeTruthy();
  expect(changes.getByText("另有 3 条规则引用未列出。")).toBeTruthy();
  expect(changes.getByText("另有 2 个策略组引用未列出。")).toBeTruthy();
  expect(changes.getByText("直接引用信息不完整。")).toBeTruthy();
  expect(
    changes.getByText("仅列直接引用，不包含全部间接依赖，也不代表实际流量。"),
  ).toBeTruthy();
  expect(changes.queryByText("无直接引用。")).toBeNull();
});

it.each([
  "baseline-missing",
  "unsupported",
  "size-limit",
  "invalid-snapshot",
  "redaction-unavailable",
])(
  "explains shared %s unavailability once and never calls it unchanged",
  async (reason) => {
    await review({
      version: 1,
      renderedConfigurationChanged: true,
      groups: { state: "unavailable", reason },
      nodes: { state: "unavailable", reason },
    });
    expect(
      screen.getAllByRole("region", { name: "策略组与连接比较" }),
    ).toHaveLength(1);
    expect(screen.getAllByText(/可查看待发布技术配置/)).toHaveLength(1);
    expect(
      screen.queryByText(/策略组未变化|连接未变化|策略组和连接未变化/),
    ).toBeNull();
  },
);

it.each([
  undefined,
  { version: 2, groups: emptyCategory, nodes: emptyCategory },
])("keeps legacy or unsupported-version review unknown", async (value) => {
  await review(value);
  expect(
    screen.getByText(
      "此版本没有可用的策略组和连接比较。可查看待发布技术配置。",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(/策略组未变化|连接未变化|策略组和连接未变化/),
  ).toBeNull();
});

it("does not call malformed category counts unchanged", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    groups: { ...emptyCategory, beforeCount: 1, afterCount: 2 },
    nodes: emptyCategory,
  });
  expect(
    screen.getByText("比较快照不可用。可查看待发布技术配置。"),
  ).toBeTruthy();
  expect(screen.queryByText("策略组未变化。")).toBeNull();
});

it("keeps unreviewed client runtime settings explicit when covered categories are unchanged", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    groups: emptyCategory,
    nodes: emptyCategory,
  });
  const scope = screen.getByText("未比较规则文件内容和客户端运行设置。");
  expect(scope.closest("details")).toBeNull();
  expect(
    screen.getAllByText("未比较规则文件内容和客户端运行设置。"),
  ).toHaveLength(1);
  expect(screen.getByText("策略组和连接未变化。")).toBeTruthy();
  expect(screen.queryByText(/配置未变化|无需发布|客户端已生效/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", false);
});

it("prioritizes the named member delta and keeps inventory and unchanged routing available on demand", async () => {
  await review({
    version: 1,
    renderedConfigurationChanged: true,
    groups: {
      ...emptyCategory,
      beforeCount: 1,
      afterCount: 1,
      changedCount: 1,
      rows: [group],
    },
    nodes: emptyCategory,
  });
  const changes = within(screen.getByRole("region", { name: "策略组变化" }));
  expect(changes.getByRole("heading", { name: "Primary" })).toBeTruthy();
  expect(changes.queryByText("修改策略组")).toBeNull();
  const counts = changes
    .getByText("1 个策略组变化 · 已发布 1 个 → 待发布 1 个")
    .closest("details");
  expect(counts).not.toBeNull();
  expect(counts).toHaveProperty("open", false);
  await userEvent.click(changes.getByText("数量明细"));
  expect(counts).toHaveProperty("open", true);
  const summary = screen.getByText("分流规则和默认去向未变化");
  const routing = summary.closest("details");
  expect(routing).toHaveProperty("open", false);
  expect(screen.getByText("未匹配规则的流量").closest("details")).toBe(routing);
  expect(
    screen.getByText("未比较规则文件内容和客户端运行设置。").closest("details"),
  ).toBeNull();
  await userEvent.click(summary);
  expect(routing).toHaveProperty("open", true);
  expect(within(routing!).getByText("由策略组「Primary」决定")).toBeTruthy();
});

it.each(["partial", "redacted", "coarse"])(
  "never collapses %s routing evidence as unchanged",
  async (kind) => {
    const partial = { ...intent, ruleCount: 1, omittedRuleCount: 1 };
    const redacted = {
      ...intent,
      ruleCount: 1,
      rules: [
        {
          id: "sensitive-rule",
          match: { state: "omitted", reason: "sensitive" },
          action: intent.defaultAction,
        },
      ],
    };
    const snapshot = kind === "redacted" ? redacted : partial;
    const coarse = {
      version: 1,
      kind: "advanced",
      advanced: {
        defaultAction: { kind: "group", label: "Primary" },
        ruleCount: 0,
        groupCount: 1,
        nodeCount: 1,
      },
    };
    await review(
      {
        version: 1,
        renderedConfigurationChanged: true,
        groups: emptyCategory,
        nodes: emptyCategory,
      },
      kind !== "coarse"
        ? { publishedRoutingIntent: snapshot, routingIntent: snapshot }
        : {
            publishedRoutingIntent: undefined,
            routingIntent: undefined,
            publishedRoutingSummary: coarse,
            routingSummary: coarse,
          },
    );
    expect(screen.queryByText("分流规则和默认去向未变化")).toBeNull();
    const limit = screen.getByText(
      kind !== "coarse"
        ? "部分规则明细未展示，无法完整比较分流规则。"
        : "摘要字段相同，不代表配置未变化。",
    );
    expect(limit.closest("details")).toBeNull();
    if (kind !== "coarse")
      expect(
        screen.getByText("未匹配规则的流量").closest("details"),
      ).toBeNull();
  },
);

it.each([false, true])(
  "preserves expanded generic routing evidence with decisionReview %s",
  (decisionReview) => {
    const frozen = {
      version: 1 as const,
      kind: "portable" as const,
      ruleCount: 0,
      rules: [],
      defaultAction: { kind: "direct" as const },
    };
    render(
      <RoutingReview
        publishedIntent={frozen}
        candidateIntent={frozen}
        decisionReview={decisionReview}
      />,
    );
    expect(screen.queryByText("分流规则和默认去向未变化")).toBeNull();
    expect(screen.getByText("未匹配规则的流量").closest("details")).toBeNull();
    expect(
      screen
        .getByText(/未比较规则文件内容、策略组内容和节点设置/)
        .closest("details"),
    ).toBeNull();
  },
);

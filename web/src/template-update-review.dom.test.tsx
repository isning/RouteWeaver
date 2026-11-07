// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { type ReactNode } from "react";
import { TemplatesPage } from "./Templates";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

it("reviews equal-count route and default changes before explicit digest-bound draft apply", async () => {
  const spec = {
    endpointSlots: [
      { id: "east", name: "东侧出口" },
      { id: "west", name: "西侧出口" },
    ],
    rules: [],
  };
  const template = {
    id: "routing",
    name: "日常分流",
    kind: "client-profile",
    version: 2,
    spec,
  };
  const binding = {
    id: "profiles_home",
    templateId: "routing",
    targetKind: "profiles",
    targetId: "home",
    mode: "follow",
    appliedVersion: 1,
    updatedAt: "2026-10-24T06:00:00Z",
    bindings: { endpoints: { east: "tokyo", west: "london" }, resources: {} },
  };
  const preview = {
    candidateVersion: 2,
    currentVersion: 1,
    compatible: true,
    hasUpdate: true,
    diagnostics: ["请核对本次模板调整", "原草稿修改会按比较结果保留"],
    changes: ["rules", "defaultAction"],
    preservedLocalEdits: [],
    nativeChecked: false,
    previewDigest: "review-authority-123",
    artifacts: [],
    review: {
      version: 1,
      scope: "profile-routing",
      current: {
        state: "available",
        intent: {
          version: 1,
          kind: "portable",
          ruleCount: 2,
          omittedRuleCount: 0,
          defaultAction: { kind: "endpoint", ref: "tokyo", label: "东京" },
          rules: [
            {
              id: "work",
              match: {
                state: "exact",
                expression: { op: "domain-suffix", value: "work.example" },
              },
              action: { kind: "endpoint", ref: "tokyo", label: "东京" },
            },
            {
              id: "local",
              match: {
                state: "exact",
                expression: { op: "domain-suffix", value: "local.example" },
              },
              action: { kind: "direct" },
            },
          ],
        },
      },
      candidate: {
        state: "available",
        intent: {
          version: 1,
          kind: "portable",
          ruleCount: 2,
          omittedRuleCount: 0,
          defaultAction: { kind: "direct" },
          rules: [
            {
              id: "work",
              match: {
                state: "exact",
                expression: { op: "domain-suffix", value: "work.example" },
              },
              action: { kind: "endpoint", ref: "london", label: "伦敦" },
            },
            {
              id: "local",
              match: {
                state: "exact",
                expression: { op: "domain-suffix", value: "local.example" },
              },
              action: { kind: "direct" },
            },
          ],
        },
      },
    },
  };
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(init.body) });
        if (url === "/api/me/template-bindings/profiles_home/preview")
          return json(preview);
        if (url === "/api/me/template-bindings/profiles_home/apply")
          return json({ binding, preview });
        throw new Error(`Unexpected mutation: ${url}`);
      }
      if (url === "/api/templates") return json([template]);
      if (url === "/api/templates/routing/versions")
        return json([template, { ...template, version: 1 }]);
      if (url === "/api/me/template-bindings") return json([binding]);
      if (url === "/api/me/profiles")
        return json([
          {
            id: "home",
            name: "家庭配置",
            sourceIds: [],
            platformEntryIds: [],
            ir: {
              endpoints: [
                { id: "tokyo", name: "目录名称不是比较权威", origin: "imported" },
                { id: "london", name: "另一目录名称", origin: "imported" },
              ],
              resources: [],
              groups: [],
              rules: [],
            },
          },
        ]);
      if (
        [
          "/api/me/collections",
          "/api/me/sources",
          "/api/me/platform-entries",
        ].includes(url)
      )
        return json([]);
      throw new Error(`Unexpected read: ${url}`);
    }),
  );
  mount(<TemplatesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "我的引用" }));
  await user.click(
    await screen.findByRole("button", { name: "检查更新 家庭配置" }),
  );
  // Establish successful inspection first, so RED is missing decision review,
  // not a failed setup selector or incompatible mock candidate.
  expect(await screen.findByText("可以更新到 v2")).toBeTruthy();
  const review = screen.getByRole("region", { name: "模板更新检查结果" });
  expect(review.classList.contains("mt-6")).toBe(true);
  expect(review.classList.contains("space-y-6")).toBe(true);
  expect(within(review).getByText("可以更新到 v2")).toBeTruthy();
  const diagnostics = within(review).getByRole("list", { name: "检查提示" });
  expect(within(diagnostics).getAllByRole("listitem")).toHaveLength(2);
  expect(within(review).getByText("将改变的内容")).toBeTruthy();

  const apply = screen.getByRole("button", { name: "应用到草稿" });
  expect(apply.hasAttribute("disabled")).toBe(false);
  expect(writes).toEqual([
    {
      url: "/api/me/template-bindings/profiles_home/preview",
      body: {
        version: 2,
        bindings: {
          endpoints: { east: "tokyo", west: "london" },
          resources: {},
        },
      },
    },
  ]);
  const changes = screen.getByRole("list", { name: "分流规则变更" });
  const work = within(changes)
    .getByText(/work\.example/)
    .closest("li")!;
  expect(within(work).getByText("当前草稿")).toBeTruthy();
  expect(within(work).getByText("更新后")).toBeTruthy();
  expect(within(work).getByText("节点「东京」")).toBeTruthy();
  expect(within(work).getByText("节点「伦敦」")).toBeTruthy();
  expect(within(work).getByText("去向已更换")).toBeTruthy();
  const defaultField = screen.getByText("默认去向已更换").parentElement!;
  expect(within(defaultField).getByText("节点「东京」")).toBeTruthy();
  expect(within(defaultField).getByText("直连")).toBeTruthy();
  expect(screen.queryByText("已发布", { exact: true })).toBeNull();
  expect(screen.queryByText("待发布", { exact: true })).toBeNull();
  expect(screen.queryByText("rules", { exact: true })).toBeNull();
  expect(screen.queryByText("defaultAction", { exact: true })).toBeNull();
  expect(writes).toHaveLength(1);
  await user.click(apply);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({
    url: "/api/me/template-bindings/profiles_home/apply",
    body: {
      previewDigest: "review-authority-123",
      version: 2,
      bindings: { endpoints: { east: "tokyo", west: "london" }, resources: {} },
    },
  });
});

// These fixtures are frozen server responses; the page must not reconstruct
// their routing or preservation decisions from the current directories.
const portableReviewIntent = (rules: unknown[] = []) => ({
  version: 1,
  kind: "portable",
  ruleCount: rules.length,
  omittedRuleCount: 0,
  rules,
  defaultAction: { kind: "direct" },
});
const frozenRule = (id: string, value: string, kind = "direct") => ({
  id,
  match: { state: "exact", expression: { op: "domain-suffix", value } },
  action: { kind },
});
async function openTemplateUpdateContract(
  overrides: Record<string, unknown>,
  collection = false,
) {
  const template = {
    id: "contract",
    name: "审阅模板",
    kind: collection ? "processing-preset" : "client-profile",
    version: 2,
    spec: { endpointSlots: [], resourceSlots: [], steps: [] },
  };
  const binding = {
    id: collection ? "collections_home" : "profiles_home",
    templateId: "contract",
    targetKind: collection ? "collections" : "profiles",
    targetId: "home",
    mode: "follow",
    appliedVersion: 1,
    updatedAt: "2026-10-24T06:00:00Z",
    bindings: {},
  };
  const response = {
    candidateVersion: 2,
    currentVersion: 1,
    compatible: true,
    hasUpdate: true,
    diagnostics: [],
    changes: [],
    preservedLocalEdits: [],
    nativeChecked: false,
    previewDigest: "contract-digest",
    artifacts: [],
    ...overrides,
  };
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(init.body) });
        if (url === `/api/me/template-bindings/${binding.id}/preview`)
          return json(response);
        if (url === `/api/me/template-bindings/${binding.id}/apply`)
          return json({ binding, preview: response });
        throw new Error(`Unexpected mutation: ${url}`);
      }
      if (url === "/api/templates") return json([template]);
      if (url === "/api/templates/contract/versions")
        return json([template, { ...template, version: 1 }]);
      if (url === "/api/me/template-bindings") return json([binding]);
      if (url === "/api/me/profiles")
        return json(
          collection
            ? []
            : [
                {
                  id: "home",
                  name: "家庭配置",
                  ir: { rules: [], groups: [], endpoints: [], resources: [] },
                },
              ],
        );
      if (url === "/api/me/collections")
        return json(
          collection
            ? [{ id: "home", name: "家庭集合", sources: [], steps: [] }]
            : [],
        );
      if (["/api/me/sources", "/api/me/platform-entries"].includes(url))
        return json([]);
      throw new Error(`Unexpected read: ${url}`);
    }),
  );
  mount(<TemplatesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "我的引用" }));
  await user.click(
    await screen.findByRole("button", {
      name: `检查更新 ${collection ? "家庭集合" : "家庭配置"}`,
    }),
  );
  expect(await screen.findByText("可以更新到 v2")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "应用到草稿" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(writes).toHaveLength(1);
  return { user, writes };
}

it("identifies a preserved local rule by its current position even when the candidate moves it", async () => {
  const personal = frozenRule("personal", "my.example", "reject");
  const { user, writes } = await openTemplateUpdateContract({
    changes: ["rules", "groups", "runtime"],
    preservedLocalEdits: [
      "rules/personal",
      "rules/deleted (deleted)",
      "runtime.dns",
      "unknown/private-secret-url",
    ],
    review: {
      version: 1,
      scope: "profile-routing",
      current: {
        state: "available",
        intent: portableReviewIntent([
          frozenRule("first", "first.example"),
          personal,
        ]),
      },
      candidate: {
        state: "available",
        intent: portableReviewIntent([
          personal,
          frozenRule("new", "new.example"),
          frozenRule("first", "first.example"),
        ]),
      },
    },
  });
  // RED target is this specific current-side identifier, not a setup failure.
  const known = screen.getByText("当前第2条规则的修改").closest("li")!;
  expect(screen.queryByText("当前第1条规则的修改")).toBeNull();
  expect(screen.getByText("本次更新保留的已知修改")).toBeTruthy();
  expect(screen.getByText("保持删除的规则")).toBeTruthy();
  expect(screen.getByText("DNS 设置")).toBeTruthy();
  expect(screen.getByText("另有 1 项保留记录未展示。")).toBeTruthy();
  expect(screen.queryByText(/private-secret-url/)).toBeNull();
  expect(screen.getByText("策略组设置已更改")).toBeTruthy();
  expect(screen.getByText("运行设置已更改")).toBeTruthy();
  await user.click(within(known).getByText("查看标识"));
  expect(within(known).getByText("personal")).toBeTruthy();
  expect(writes).toHaveLength(1);
});

it("keeps a valid repair applicable when only the current routing summary is unavailable", async () => {
  const { user, writes } = await openTemplateUpdateContract({
    changes: ["rules"],
    review: {
      version: 1,
      scope: "profile-routing",
      current: { state: "unavailable", reason: "render-failed" },
      candidate: {
        state: "available",
        intent: portableReviewIntent([frozenRule("repair", "repair.example")]),
      },
    },
  });
  expect(
    screen.getByText("当前草稿无法生成分流摘要，无法逐条比较。"),
  ).toBeTruthy();
  expect(screen.getByText("域名后缀 repair.example")).toBeTruthy();
  expect(screen.queryByText("已展示的分流规则和默认去向相同。")).toBeNull();
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual({
    url: "/api/me/template-bindings/profiles_home/apply",
    body: {
      previewDigest: "contract-digest",
      version: 2,
      bindings: { endpoints: {}, resources: {} },
    },
  });
});

it.each([
  undefined,
  { version: 2, scope: "profile-routing" },
  { version: 1, scope: "future-scope" },
])(
  "keeps missing or unknown review metadata explicitly uncomparable (%j)",
  async (review) => {
    await openTemplateUpdateContract({
      review,
      changes: ["rules", "defaultAction", "groups", "runtime"],
    });
    expect(screen.getByText("此检查未提供逐条比较。")).toBeTruthy();
    expect(screen.getByText("分流规则已更改")).toBeTruthy();
    expect(screen.getByText("默认去向已更改")).toBeTruthy();
    expect(screen.getByText("策略组设置已更改")).toBeTruthy();
    expect(screen.getByText("运行设置已更改")).toBeTruthy();
    expect(screen.queryByText("没有配置内容变更")).toBeNull();
    expect(screen.queryByText("已展示的分流规则和默认去向相同。")).toBeNull();
  },
);

it("keeps native policy opaque with draft labels and localized categories", async () => {
  await openTemplateUpdateContract({
    changes: ["rules", "runtime"],
    review: {
      version: 1,
      scope: "profile-routing",
      current: {
        state: "available",
        intent: { version: 1, kind: "native-override" },
      },
      candidate: {
        state: "available",
        intent: { version: 1, kind: "native-override" },
      },
    },
  });
  expect(
    screen.getByText(
      "当前草稿与更新后均使用原生配置覆盖，无法提供可靠的分流比较。",
    ),
  ).toBeTruthy();
  expect(screen.getByText("分流规则已更改")).toBeTruthy();
  expect(screen.getByText("运行设置已更改")).toBeTruthy();
  expect(
    screen.queryByText(
      "已发布与待发布均使用原生配置覆盖，无法提供可靠的分流比较。",
    ),
  ).toBeNull();
  expect(screen.queryByText("已展示的分流规则和默认去向相同。")).toBeNull();
});

it("keeps collection step updates separate from profile routing comparisons", async () => {
  await openTemplateUpdateContract(
    { changes: ["steps"], preservedLocalEdits: ["steps/personal"] },
    true,
  );
  expect(screen.getByText("节点处理步骤已更改")).toBeTruthy();
  expect(screen.getByText("处理步骤修改")).toBeTruthy();
  expect(screen.queryByText("此检查未提供逐条比较。")).toBeNull();
  expect(screen.queryByRole("list", { name: "分流规则变更" })).toBeNull();
});

it("describes a frozen label rename without inventing a changed destination identity", async () => {
  const rule = frozenRule("named", "named.example");
  await openTemplateUpdateContract({
    changes: ["rules"],
    review: {
      version: 1,
      scope: "profile-routing",
      current: {
        state: "available",
        intent: portableReviewIntent([
          {
            ...rule,
            action: { kind: "endpoint", ref: "same-exit", label: "旧名称" },
          },
        ]),
      },
      candidate: {
        state: "available",
        intent: portableReviewIntent([
          {
            ...rule,
            action: { kind: "endpoint", ref: "same-exit", label: "新名称" },
          },
        ]),
      },
    },
  });
  const changes = screen.getByRole("list", { name: "分流规则变更" });
  expect(within(changes).getByText("去向名称已更新")).toBeTruthy();
  expect(within(changes).getByText("节点「旧名称」")).toBeTruthy();
  expect(within(changes).getByText("节点「新名称」")).toBeTruthy();
  expect(within(changes).queryByText("去向已更换")).toBeNull();
  expect(within(changes).queryByText("查看去向标识")).toBeNull();
});

it("retains the reported rule change when bounded portable summaries cannot show its details", async () => {
  const partial = {
    version: 1,
    kind: "portable",
    ruleCount: 2,
    omittedRuleCount: 1,
    defaultAction: { kind: "direct" },
    rules: [
      {
        id: "hidden-match",
        match: { state: "omitted", reason: "sensitive" },
        action: { kind: "direct" },
      },
    ],
  };
  await openTemplateUpdateContract({
    changes: ["rules"],
    review: {
      version: 1,
      scope: "profile-routing",
      current: { state: "available", intent: partial },
      candidate: { state: "available", intent: partial },
    },
  });
  expect(
    screen.getByText("部分规则明细未展示，无法完整比较分流规则。"),
  ).toBeTruthy();
  expect(screen.getByText("分流规则已更改")).toBeTruthy();
  expect(screen.queryByText("已展示的分流规则和默认去向相同。")).toBeNull();
});

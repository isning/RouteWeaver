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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { Profile, RuleResource } from "./types";

const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture(): Profile {
  const profile = emptyProfile();
  profile.id = "routing-task";
  profile.name = "Daily";
  profile.ir.endpoints = ["a", "b"].map((id) => ({
    id,
    name: `Airport ${id}`,
    origin: "imported",
    connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
  }));
  return profile;
}
function mount(
  profile = fixture(),
  options: {
    resources?: RuleResource[];
    entries?: unknown[];
    overview?: unknown;
    overviewFailure?: boolean;
  } = {},
) {
  const writes: Profile[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "PUT" && path === `/api/me/profiles/${profile.id}`) {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return json(body);
      }
      if (path === "/api/me/resources") return json(options.resources || []);
      if (path === "/api/me/platform-entries")
        return json(options.entries || []);
      if (path === "/api/me/overview")
        return options.overviewFailure
          ? json({ detail: "Overview unavailable" }, 503)
          : json(options.overview || { routes: [] });
      if (!init?.method || init.method === "GET") return json([]);
      throw new Error(`Unexpected write: ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor initial={profile} isNew={false} onClose={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, editor: within(view.container), view };
}
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  label: string,
) {
  if (control.getAttribute("aria-expanded") !== "true")
    await user.click(control);
  const popup = document
    .getElementById(control.getAttribute("aria-controls")!)
    ?.closest("[data-slot=popover-content]");
  expect(popup).toBeTruthy();
  await user.click(
    within(popup as HTMLElement).getByText(label, { exact: true }),
  );
}

it("starts with rules and explicitly creates a candidate group for default traffic in one task", async () => {
  const { writes, editor } = mount();
  expect(
    editor.getByRole("tab", { name: "分流规则" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(editor.getByRole("button", { name: "添加规则" })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(
    editor.getByRole("button", { name: "默认流量：使用多个候选连接…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "创建并使用策略组",
  });
  expect(within(dialog).getByText("用于当前草稿：所有流量")).toBeTruthy();
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "策略组名称" }),
    { target: { value: "Travel choice" } },
  );
  const members = within(dialog).getByRole("combobox", {
    name: "策略组「Travel choice」的固定成员",
  });
  await choose(user, members, "Airport a");
  await choose(user, members, "Airport b");
  await user.keyboard("{Escape}");
  await user.click(within(dialog).getByRole("button", { name: "创建并使用" }));
  expect(writes).toEqual([]);
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.groups).toEqual([
    {
      id: expect.any(String),
      name: "Travel choice",
      kind: "manual",
      members: [
        { kind: "endpoint", ref: "a" },
        { kind: "endpoint", ref: "b" },
      ],
    },
  ]);
  expect(writes[0].ir.defaultAction).toEqual({
    kind: "group",
    ref: writes[0].ir.groups[0].id,
  });
  expect(writes[0].ir.rules).toEqual([]);
  expect(writes[0].ir.endpoints).toEqual(fixture().ir.endpoints);
});

const acceptedResource: RuleResource = {
  id: "work-rules",
  name: "Work rules",
  revision: "v2",
  digest: `sha256:${"a".repeat(64)}`,
  format: "mihomo-text",
  behavior: "domain",
  location: "local",
  path: "rules/work.txt",
  updatePolicy: "pinned",
  acceptedVersion: "accepted-v2",
  sizeBytes: 20,
};
it("selects an accepted rule file and attaches its descriptor in the same draft edit", async () => {
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "work",
      match: { op: "resource", value: "" },
      action: { kind: "direct" },
    },
  ];
  const { writes, editor } = mount(profile, {
    resources: [{ ...acceptedResource, inspection: "envelope-checked" }],
  });
  const user = userEvent.setup();
  await choose(
    user,
    editor.getByRole("combobox", { name: "匹配规则文件" }),
    "Work rules",
  );
  expect(
    editor.getByText("用于完整配置时，需下载配置与规则文件包。"),
  ).toBeTruthy();
  expect(writes).toEqual([]);
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.rules).toEqual([
    {
      id: "work",
      match: { op: "resource", value: "work-rules" },
      action: { kind: "direct" },
    },
  ]);
  expect(writes[0].ir.resources).toEqual([acceptedResource]);
  expect(writes[0].ir.defaultAction).toEqual({ kind: "direct" });
});

it("shows entitled route and current quota multiplier when choosing a platform entry directly", async () => {
  const { writes, editor } = mount(fixture(), {
    entries: [
      {
        id: "platform-a",
        name: "Personal entry",
        routeId: "route-a",
        credentialVersion: "v1",
        status: "configured-unverified",
      },
    ],
    overview: {
      routes: [
        { id: "other-route", name: "Wrong route", rateMicros: 9000000 },
        { id: "route-a", name: "Work line", rateMicros: 1500000 },
      ],
    },
  });
  const user = userEvent.setup();
  const control = editor.getByRole("combobox", { name: "默认流量行为" });
  await user.click(control);
  expect(await screen.findByText("Work line 的额度倍率 1.5×")).toBeTruthy();
  expect(screen.queryByText(/Wrong route/)).toBeNull();
  const popup = document
    .getElementById(control.getAttribute("aria-controls")!)!
    .closest("[data-slot=popover-content]")!;
  await user.click(
    within(popup as HTMLElement).getByText("平台入口 Personal entry"),
  );
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].platformEntryIds).toEqual(["platform-a"]);
  expect(writes[0].ir.defaultAction).toEqual({
    kind: "endpoint",
    ref: "platform-a",
  });
  expect(writes[0].ir.groups).toEqual([]);
});

it("makes direct group uses navigable and preserves their actions when removal is canceled", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "travel",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "a" }],
    },
  ];
  profile.ir.defaultAction = { kind: "group", ref: "travel" };
  profile.ir.rules = [
    {
      id: "work",
      match: { op: "domain", value: "example.com" },
      action: { kind: "group", ref: "travel" },
    },
  ];
  const { writes, editor } = mount(profile);
  const user = userEvent.setup();
  await user.click(editor.getByRole("tab", { name: "策略组" }));
  { const summary = editor.getByText("Travel", { exact: true }).closest("summary")!; if (!summary.closest("details")!.open) await user.click(summary); }
  const group = editor.getByRole("group", { name: "策略组「Travel」" });
  expect(
    within(group).getByRole("button", { name: "用于默认流量" }),
  ).toBeTruthy();
  await user.click(within(group).getByRole("button", { name: "用于规则 1" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      editor.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  await user.click(editor.getByRole("tab", { name: "策略组" }));
  { const summary = editor.getByText("Travel", { exact: true }).closest("summary")!; if (!summary.closest("details")!.open) await user.click(summary); }
  await user.click(
    within(editor.getByRole("group", { name: "策略组「Travel」" })).getByRole(
      "button",
      { name: "移除策略组" },
    ),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "移除策略组「Travel」？",
  });
  expect(
    within(confirm).getByText(
      "这些引用将变为不可用，需要明确选择新的流量去向后才能发布。",
    ),
  ).toBeTruthy();
  await user.click(within(confirm).getByRole("button", { name: "保留策略组" }));
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.groups).toEqual(profile.ir.groups);
  expect(writes[0].ir.rules).toEqual(profile.ir.rules);
  expect(writes[0].ir.defaultAction).toEqual(profile.ir.defaultAction);
});

it("preserves an existing accepted pin when a nested resource condition is selected again", async () => {
  const profile = fixture();
  const pinned = {
    ...acceptedResource,
    revision: "v1",
    acceptedVersion: "accepted-v1",
    digest: `sha256:${"b".repeat(64)}`,
  };
  profile.ir.resources = [pinned];
  profile.ir.rules = [
    {
      id: "work",
      match: {
        op: "and",
        children: [
          { op: "domain", value: "example.com" },
          { op: "not", children: [{ op: "resource", value: "" }] },
        ],
      },
      action: { kind: "reject" },
    },
  ];
  const { writes, editor } = mount(profile, { resources: [acceptedResource] });
  const user = userEvent.setup();
  await choose(
    user,
    editor.getByRole("combobox", { name: "匹配规则文件" }),
    "Work rules",
  );
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.resources).toEqual([pinned]);
  expect(writes[0].ir.rules).toEqual([
    {
      id: "work",
      match: {
        op: "and",
        children: [
          { op: "domain", value: "example.com" },
          { op: "not", children: [{ op: "resource", value: "work-rules" }] },
        ],
      },
      action: { kind: "reject" },
    },
  ]);
});

it("advances an accepted file pin without adopting the resource library's following policy", async () => {
  const profile = fixture();
  const previous = {
    ...acceptedResource,
    revision: "v1",
    acceptedVersion: "accepted-v1",
    digest: `sha256:${"b".repeat(64)}`,
  };
  const latest = { ...acceptedResource, updatePolicy: "follow" as const };
  profile.ir.resources = [previous];
  profile.ir.rules = [{
    id: "work",
    match: { op: "resource", value: previous.id },
    action: { kind: "reject" },
  }];
  const { writes, editor } = mount(profile, { resources: [latest] });
  const user = userEvent.setup();
  await user.click(await editor.findByRole("button", {
    name: "固定到最新接纳版本",
  }));
  // Advancing the chosen immutable version edits only the draft. It neither
  // publishes nor grants permission to follow future resource replacements.
  expect(writes).toEqual([]);
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.resources).toEqual([
    { ...acceptedResource, updatePolicy: "pinned" },
  ]);
  expect(writes[0].ir.rules).toEqual(profile.ir.rules);
  expect(writes[0].ir.defaultAction).toEqual(profile.ir.defaultAction);
});

it("makes a rule-file task directly discoverable without selecting resource references separately", async () => {
  const { writes, editor } = mount(fixture(), {
    resources: [acceptedResource],
  });
  const user = userEvent.setup();
  await user.click(editor.getByRole("button", { name: "按规则文件分流" }));
  await choose(
    user,
    editor.getByRole("combobox", { name: "匹配规则文件" }),
    "Work rules",
  );
  await choose(
    user,
    editor.getByRole("combobox", { name: "规则 1 的流量去向" }),
    "Airport b",
  );
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.resources).toEqual([acceptedResource]);
  expect(writes[0].ir.rules).toEqual([
    {
      id: expect.any(String),
      match: { op: "resource", value: "work-rules" },
      action: { kind: "endpoint", ref: "b" },
    },
  ]);
  expect(writes[0].ir.defaultAction).toEqual({ kind: "direct" });
});

it("keeps platform choices explicit when the current multiplier cannot be read", async () => {
  const { writes, editor } = mount(fixture(), {
    entries: [
      {
        id: "platform-a",
        name: "Personal entry",
        routeId: "route-a",
        credentialVersion: "v1",
        status: "configured-unverified",
      },
    ],
    overviewFailure: true,
  });
  const user = userEvent.setup();
  const control = editor.getByRole("combobox", { name: "默认流量行为" });
  await user.click(control);
  expect(await screen.findByText("倍率暂不可用")).toBeTruthy();
  expect(screen.queryByText(/额度倍率 1×/)).toBeNull();
  expect(writes).toEqual([]);
  const popup = document
    .getElementById(control.getAttribute("aria-controls")!)!
    .closest("[data-slot=popover-content]")!;
  await user.click(
    within(popup as HTMLElement).getByText("平台入口 Personal entry"),
  );
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.defaultAction).toEqual({
    kind: "endpoint",
    ref: "platform-a",
  });
});

it.each(["cancel", "escape"])(
  "does not create an orphan group or lose the parent draft on %s",
  async (dismiss) => {
    const { writes, editor } = mount();
    const user = userEvent.setup();
    fireEvent.change(editor.getByRole("textbox", { name: "配置名称" }), {
      target: { value: "My retained draft" },
    });
    await user.click(
      editor.getByRole("button", { name: "默认流量：使用多个候选连接…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "创建并使用策略组",
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "策略组名称" }),
      { target: { value: "Discard me" } },
    );
    if (dismiss === "cancel")
      await user.click(
        within(dialog).getByRole("button", { name: /^取\s*消$/ }),
      );
    else await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "创建并使用策略组" }),
      ).toBeNull(),
    );
    await user.click(editor.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].name).toBe("My retained draft");
    expect(writes[0].ir.groups).toEqual([]);
    expect(writes[0].ir.defaultAction).toEqual({ kind: "direct" });
  },
);

it("binds a new group only to the chosen incomplete rule and prevents repeated creation", async () => {
  const profile = fixture();
  profile.ir.defaultAction = { kind: "endpoint", ref: "a" };
  const { writes, editor } = mount(profile);
  const user = userEvent.setup();
  await user.click(editor.getByRole("button", { name: "添加规则" }));
  fireEvent.change(editor.getByRole("textbox", { name: "规则匹配值" }), {
    target: { value: "example.com" },
  });
  await user.click(
    editor.getByRole("button", { name: "规则 1：使用多个候选连接…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "创建并使用策略组",
  });
  expect(
    within(dialog).getByText("用于当前草稿：规则 1 匹配 example.com"),
  ).toBeTruthy();
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "策略组名称" }),
    { target: { value: "Work" } },
  );
  await choose(
    user,
    within(dialog).getByRole("combobox", { name: "策略组「Work」的固定成员" }),
    "Airport b",
  );
  await user.keyboard("{Escape}");
  const create = within(dialog).getByRole("button", { name: "创建并使用" });
  fireEvent.click(create);
  fireEvent.click(create);
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].ir.groups).toEqual([
    {
      id: expect.any(String),
      name: "Work",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "b" }],
    },
  ]);
  expect(writes[0].ir.rules).toEqual([
    {
      id: expect.any(String),
      match: { op: "domain-suffix", value: "example.com" },
      action: { kind: "group", ref: writes[0].ir.groups[0].id },
    },
  ]);
  expect(writes[0].ir.defaultAction).toEqual({ kind: "endpoint", ref: "a" });
});

it("does not activate an unselected platform entry merely by renaming an existing group", async () => {
  const profile = fixture();
  profile.ir.groups = [
    {
      id: "travel",
      name: "Travel",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "platform-a" }],
    },
  ];
  const { writes, editor } = mount(profile, {
    entries: [
      {
        id: "platform-a",
        name: "Personal entry",
        routeId: "route-a",
        credentialVersion: "v1",
        status: "configured-unverified",
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(editor.getByRole("tab", { name: "策略组" }));
  { const summary = editor.getByText("Travel", { exact: true }).closest("summary")!; if (!summary.closest("details")!.open) await user.click(summary); }
  fireEvent.change(editor.getByRole("textbox", { name: "策略组名称" }), {
    target: { value: "Renamed" },
  });
  await user.click(editor.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].platformEntryIds).toBeUndefined();
  expect(writes[0].ir.groups).toEqual([
    {
      id: "travel",
      name: "Renamed",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "platform-a" }],
    },
  ]);
});


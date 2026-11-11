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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { GroupPolicyEditor } from "./GroupPolicyEditor";
import { GroupPolicyComparison } from "./GroupPolicyComparison";
import { usePolicyChange } from "./AccessPolicy";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type {
  GroupReferenceLabels,
  GroupPolicyResource,
  UserGroup,
} from "./access-policy-model";
import type { Service } from "./types";

let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const group: UserGroup = {
  id: "g1",
  name: "Family",
  serviceId: "plan-a",
  priority: 1,
  memberIds: ["u1"],
};
const service: Service = {
  id: "plan-a",
  name: "Same name",
  quotaBytes: 50,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" },
};
const services = [service, { ...service, id: "plan-b" }];
const users = ["u1", "u2"].map((id) => ({
  id,
  name: "Same person",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
}));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const context = (value: UserGroup, revision = "opened-1") => ({
  target: { kind: "group", id: value.id },
  record: { group: value },
  precondition: { exists: true, revision },
});
const reviewed = (before: UserGroup | null, after: UserGroup) => ({
  revision: "preview-1",
  affected: [],
  blockers: [],
  guard: "opened-record",
  resource: {
    target: { kind: "group", id: after.id },
    before: before ? { group: structuredClone(before) } : null,
    after: {
      group: {
        ...after,
        memberIds: [...new Set(after.memberIds ?? [])].sort(),
      },
    },
  },
});
beforeEach((test) => {
  owner = ownedClickScenario(test);
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
function mount(initial: UserGroup | null = group, onClose = () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrap = (children: ReactNode) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <UIProviders>{children}</UIProviders>
      </QueryClientProvider>
    </StrictMode>
  );
  const editor = (
    value: UserGroup | null,
    currentUsers = users,
    currentServices = services,
  ) => (
    <GroupPolicyEditor
      initial={value}
      users={currentUsers}
      services={currentServices}
      routes={[]}
      onClose={onClose}
    />
  );
  const view = render(wrap(editor(initial)));
  return {
    rerender(value: UserGroup) {
      view.rerender(wrap(editor(value)));
    },
    rerenderCatalogs(
      currentUsers: typeof users,
      currentServices: typeof services,
    ) {
      view.rerender(wrap(editor(initial, currentUsers, currentServices)));
    },
  };
}
async function name(value: string) {
  const input = await screen.findByLabelText("用户组名称");
  owner.assertActive();
  fireEvent.change(input, { target: { value } });
}
async function preview() {
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
}
const conflict = () =>
  json(
    {
      code: "POLICY_EDIT_BASELINE_CHANGED",
      detail: "用户组已更新。当前草稿尚未保存，请查看最新版本。",
    },
    409,
  );

it("retains A's name draft while B's membership update requires explicit latest adoption before a guarded save", async () => {
  let saved = group,
    applies = 0;
  const latest = { ...group, memberIds: ["u1", "u2"] };
  const writes: any[] = [],
    close = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/"))
        return json(context(saved, saved === group ? "opened-1" : "opened-2"));
      const body = JSON.parse(init!.body as string);
      writes.push({ url: String(url), body });
      if (String(url).endsWith("/preview"))
        return body.precondition.revision === "opened-1"
          ? conflict()
          : json(reviewed(latest, body.change.group));
      return ++applies === 1
        ? json({ detail: "保存失败，请重试" }, 500)
        : json({});
    }),
  );
  mount(group, close);
  await name("Family revised");
  saved = latest;
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Family revised",
  );
  expect(screen.queryByText("草稿尚未保存，请核对最新版本。")).toBeNull();
  await name("Family revised again");
  expect(screen.getByText("草稿尚未保存，请核对最新版本。")).toBeTruthy();
  await preview();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes.map((write) => write.body.precondition.revision)).toEqual([
    "opened-1",
    "opened-1",
  ]);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "查看最新版本",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const savedComparison = within(
    await screen.findByRole("table", { name: "已保存的用户组变化" }),
  );
  expect(savedComparison.getByText("1 位")).toBeTruthy();
  expect(savedComparison.getByText("2 位")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "新增成员" })).getByText("u2"),
  ).toBeTruthy();
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Family revised again",
  );
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("Family"),
  );
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
  await name("Family revised");
  await preview();
  let review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.getByRole("heading", { name: "用户组变更" })).toBeTruthy();
  expect(writes[2].body).toMatchObject({
    precondition: { exists: true, revision: "opened-2" },
    change: { group: { name: "Family revised", memberIds: ["u1", "u2"] } },
  });
  const consent =
    "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本";
  await owner.click(() => review.getByRole("checkbox", { name: consent }));
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  await screen.findByText("保存失败，请重试");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
  await owner.click(() => review.getByRole("button", { name: "返回编辑" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
  );
  await preview();
  review = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  expect(
    review.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
  await owner.click(() => review.getByRole("checkbox", { name: consent }));
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(writes.at(-1).body).toEqual({
    change: writes.at(-2).body.change,
    revision: "preview-1",
  });
});

it("loads the saved group rather than stale catalog values and reviews priority even with no affected users", async () => {
  const saved = {
    ...group,
    serviceId: "plan-b",
    priority: 9,
    memberIds: ["u2"],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("/edit-context/")
        ? json(context(saved))
        : json(reviewed(saved, JSON.parse(init!.body as string).change.group)),
    ),
  );
  mount();
  const priority = await screen.findByLabelText("用户组优先级");
  expect((priority as HTMLInputElement).value).toBe("9");
  owner.assertActive();
  fireEvent.change(priority, { target: { value: "10" } });
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.getByText("现有用户授权不变。")).toBeTruthy();
  const row = within(review.getByRole("row", { name: /用户组优先级/ }));
  expect(row.getByText("9")).toBeTruthy();
  expect(row.getByText("10")).toBeTruthy();
});

it.each([
  "unguarded",
  "target",
  "kind",
  "before",
  "after",
  "candidate",
  "presence",
  "unknown",
  "incomplete",
] as const)(
  "rejects a %s group review without legacy downgrade or lost inputs",
  async (fault) => {
    const writes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/edit-context/")) return json(context(group));
        const body = JSON.parse(init!.body as string);
        writes.push(body);
        const result: any = reviewed(group, body.change.group);
        if (fault === "unguarded") delete result.guard;
        if (fault === "target") result.resource.target.id = "g2";
        if (fault === "kind") result.resource.target.kind = "service";
        if (fault === "before") result.resource.before.group.id = "g2";
        if (fault === "after") result.resource.after.group.id = "g2";
        if (fault === "candidate")
          result.resource.after.group.memberIds = ["u2"];
        if (fault === "presence") result.resource.before = null;
        if (fault === "unknown")
          result.resource.after.group.futurePolicy = true;
        if (fault === "incomplete") delete result.resource.after.group.priority;
        return json(result);
      }),
    );
    mount();
    await name("Still my draft");
    await preview();
    await screen.findByText(
      "服务未返回完整的用户组变更核对结果。当前草稿已保留，请重试。",
    );
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("Still my draft");
    expect(writes).toHaveLength(1);
    expect(writes[0].precondition.revision).toBe("opened-1");
  },
);

it.each([
  "unknown",
  "target",
  "kind",
  "incomplete",
  "precondition",
  "presence",
] as const)(
  "does not mount editable fields for a %s opening record",
  async (fault) => {
    const response: any = context(group);
    if (fault === "unknown")
      response.record = { group: { ...group, futurePolicy: true } };
    if (fault === "target") response.target.id = "g2";
    if (fault === "kind") response.target.kind = "service";
    if (fault === "incomplete")
      response.record = {
        group: {
          id: group.id,
          name: group.name,
          serviceId: group.serviceId,
          priority: group.priority,
        },
      };
    if (fault === "precondition") delete response.precondition;
    if (fault === "presence") response.record = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(response)),
    );
    mount();
    await screen.findByText(
      "服务未返回完整的用户组编辑数据。请重试；尚未打开可编辑草稿。",
    );
    expect(screen.queryByLabelText("用户组名称")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览影响" })).toBeNull();
  },
);

it("ignores a stale opening read when another same-named group becomes the active target", async (test) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  test.onTestFinished(release);
  const second = { ...group, id: "g2", priority: 20 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/g1")
        ? held.then(() => json(context(group)))
        : json(context(second, "opened-g2")),
    ),
  );
  const view = mount();
  expect(screen.queryByLabelText("用户组名称")).toBeNull();
  view.rerender(second);
  expect(
    ((await screen.findByLabelText("用户组优先级")) as HTMLInputElement).value,
  ).toBe("20");
  await act(async () => release());
  expect(
    (screen.getByLabelText("用户组优先级") as HTMLInputElement).value,
  ).toBe("20");
});

it("does not install a latest-version response after a newer local name edit", async (test) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  test.onTestFinished(release);
  let holdLatest = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/edit-context/")
        ? !holdLatest
          ? json(context(group))
          : held.then(() =>
              json({
                ...context({ ...group, memberIds: ["u1", "u2"] }, "opened-2"),
                references: {
                  users: [{ id: "u2", name: "Obsolete snapshot name" }],
                  services: [],
                },
              }),
            )
        : ((holdLatest = true), conflict()),
    ),
  );
  mount();
  await name("Draft");
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await name("Newer intent");
  await act(async () => release());
  expect(
    screen.queryByRole("button", { name: "使用最新版本重新编辑" }),
  ).toBeNull();
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Newer intent",
  );
  expect(screen.queryByText("Obsolete snapshot name")).toBeNull();
});

it("preserves null members in the submitted full record and accepts only documented server member normalization", async () => {
  let submitted: any;
  const saved = { ...group, memberIds: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("/edit-context/")
        ? json(context(saved))
        : ((submitted = JSON.parse(init!.body as string)),
          json(reviewed(saved, submitted.change.group))),
    ),
  );
  mount(saved);
  await name("Empty group renamed");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(submitted.change.group.memberIds).toBeNull();
});

it("keeps an absent creation draft after an ID collision and requires another explicitly absent ID", async () => {
  let firstID = "",
    collided = false;
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/")) {
        const id = decodeURIComponent(String(url).split("/").at(-1)!);
        firstID ||= id;
        return collided && id === firstID
          ? json(context({ ...group, id }, "collision-present"))
          : json({
              target: { kind: "group", id },
              record: null,
              precondition: { exists: false, revision: `absent:${id}` },
            });
      }
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      if (body.change.group.id === firstID) {
        collided = true;
        return conflict();
      }
      return json(reviewed(null, body.change.group));
    }),
  );
  mount(null);
  await name("New family");
  owner.assertActive();
  await owner.click(() => screen.getByLabelText("组服务方案"));
  await owner.click(() => screen.findByRole("option", { name: "Same name，标识：plan-a" }));
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  expect(writes[0].precondition).toEqual({
    exists: false,
    revision: `absent:${firstID}`,
  });
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() =>
    screen.findByRole("button", { name: "使用新标识另建用户组" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("New family"),
  );
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.getByText("新建用户组")).toBeTruthy();
  expect(writes[1].change.group.id).not.toBe(firstID);
  expect(writes[1].change.group.serviceId).toBe("plan-a");
  expect(writes[1].precondition).toEqual({
    exists: false,
    revision: `absent:${writes[1].change.group.id}`,
  });
});

it("does not turn deletion into an implicit recreation of an existing group", async () => {
  let deleted = false;
  const requests: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("/edit-context/")
        ? json(
            deleted
              ? {
                  target: { kind: "group", id: group.id },
                  record: null,
                  precondition: { exists: false, revision: "deleted" },
                }
              : context(group),
          )
        : (requests.push(JSON.parse(init!.body as string)),
          (deleted = true),
          conflict()),
    ),
  );
  mount();
  await name("Unsaved name");
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await screen.findByText("用户组已不存在，当前草稿不会自动新建同名用户组。");
  expect(
    screen.queryByRole("button", { name: "使用最新版本重新编辑" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "使用新标识另建用户组" }),
  ).toBeNull();
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Unsaved name",
  );
  await preview();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map((request) => request.precondition)).toEqual([
    { exists: true, revision: "opened-1" },
    { exists: true, revision: "opened-1" },
  ]);
});

it("reviews a changed service identity even when the catalog gives both services the same name", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("/edit-context/")
        ? json(context(group))
        : json(reviewed(group, JSON.parse(init!.body as string).change.group)),
    ),
  );
  mount();
  await screen.findByLabelText("组服务方案");
  owner.assertActive();
  await owner.click(() => screen.getByLabelText("组服务方案"));
  await owner.click(() => screen.findByRole("option", { name: "Same name，标识：plan-b" }));
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  const row = within(review.getByRole("row", { name: /^服务方案 / }));
  expect(row.getByText("plan-a")).toBeTruthy();
  expect(row.getByText("plan-b")).toBeTruthy();
  expect(review.queryByText("Same name")).toBeNull();
  expect(review.getByText("现有用户授权不变。")).toBeTruthy();
});

it("requires deliberate discard before closing a changed group draft", async () => {
  const close = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(context(group))),
  );
  const cancel = () =>
    within(screen.getByRole("dialog", { name: "编辑 Family" })).getByRole(
      "button",
      { name: "取消" },
    );
  mount(group, close);
  await name("Unsaved group");
  await owner.click(cancel);
  const confirmationTitle = "放弃尚未保存的授权修改？";
  const confirmation = await screen.findByRole("alertdialog", {
    name: confirmationTitle,
  });
  expect(close).not.toHaveBeenCalled();
  await owner.click(() =>
    within(confirmation).getByRole("button", { name: "继续编辑" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: confirmationTitle }),
    ).toBeNull(),
  );
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Unsaved group",
  );
  await owner.click(cancel);
  const reopened = await screen.findByRole("alertdialog", {
    name: confirmationTitle,
  });
  await owner.click(() =>
    within(reopened).getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it("keeps each retained group draft with its own opening record and keeps an incomplete priority incomplete", async () => {
  let saved = group,
    revision = "opened-1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/edit-context/")
        ? json(context(saved, revision))
        : conflict(),
    ),
  );
  mount();
  const priority = await screen.findByLabelText("用户组优先级");
  owner.assertActive();
  fireEvent.change(priority, { target: { value: "2" } });
  saved = { ...group, priority: 9, memberIds: ["u1", "u2"] };
  revision = "opened-2";
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  const adopt = async () => {
    await owner.click(() =>
      screen.getByRole("button", { name: "查看最新版本" }),
    );
    await owner.click(() =>
      screen.findByRole("button", { name: "使用最新版本重新编辑" }),
    );
    await owner.click(() =>
      screen.getByRole("button", { name: "使用最新版本" }),
    );
  };
  await adopt();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组优先级") as HTMLInputElement).value,
    ).toBe("9"),
  );
  await name("Second draft");
  saved = { ...saved, priority: 20 };
  revision = "opened-3";
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  owner.assertActive();
  fireEvent.change(screen.getByLabelText("用户组优先级"), {
    target: { value: "" },
  });
  await adopt();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组优先级") as HTMLInputElement).value,
    ).toBe("20"),
  );
  await owner.click(() => screen.getByText("较早草稿 1（未保存）"));
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const tables = screen.getAllByRole("table", { name: "保留的草稿" });
  const first = within(
    within(tables[0]).getByRole("row", { name: /用户组优先级/ }),
  ).getAllByRole("cell");
  const second = within(
    within(tables[1]).getByRole("row", { name: /用户组优先级/ }),
  ).getAllByRole("cell");
  expect(first.map((cell) => cell.textContent)).toEqual(["1", "2"]);
  expect(second.map((cell) => cell.textContent)).toEqual(["9", "尚未填写"]);
  const historicalMembers = within(
    within(tables[0]).getByRole("row", { name: /^组成员 / }),
  ).getAllByRole("cell");
  expect(historicalMembers.map((cell) => cell.textContent)).toEqual([
    "1 位",
    "1 位",
  ]);
  const firstCopy = within(tables[0].closest("section")!);
  await owner.click(() => firstCopy.getByText("查看完整成员与标识"));
  expect(
    within(
      firstCopy.getByRole("list", { name: "当时打开的版本的完整成员" }),
    ).getByText("u1"),
  ).toBeTruthy();
  const historicalDraftMembers = within(
    firstCopy.getByRole("list", { name: "保留的草稿的完整成员" }),
  );
  expect(historicalDraftMembers.getByText("u1")).toBeTruthy();
  expect(historicalDraftMembers.queryByText("u2")).toBeNull();
});

it("does not accept a latest-version confirmation after a newer local edit invalidates that decision", async () => {
  let saved = group;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/edit-context/")
        ? json(context(saved, saved === group ? "opened-1" : "opened-2"))
        : conflict(),
    ),
  );
  mount();
  await name("Draft");
  saved = { ...group, priority: 9 };
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本重新编辑" }),
  );
  // A new form intent retires the confirmation's owner even if its callback is later delivered.
  await name("Newer draft");
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Newer draft",
  );
  expect(
    (screen.getByLabelText("用户组优先级") as HTMLInputElement).value,
  ).toBe("1");
  expect(screen.queryByText("上一版草稿（未保存）")).toBeNull();
});

it("invalidates group disposal consent when the retained-copy set changes without changing its count", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      json(reviewed(group, JSON.parse(init!.body as string).change.group)),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  function Harness({ copies }: { copies: readonly object[] }) {
    const policy = usePolicyChange({
      mode: "guarded-group",
      retainedDrafts: copies,
      users: [],
      services: [],
      routes: [],
      onApplied: () => {},
    });
    return (
      <>
        <button
          onClick={() =>
            policy.propose({ group }, { exists: true, revision: "opened-1" })
          }
        >
          Preview
        </button>
        {policy.dialog}
      </>
    );
  }
  const wrap = (copies: readonly object[]) => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <Harness copies={copies} />
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(wrap([{ copy: "first" }]));
  await owner.click(() => screen.getByRole("button", { name: "Preview" }));
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  const consent =
    "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本";
  await owner.click(() => review.getByRole("checkbox", { name: consent }));
  expect(
    (review.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  view.rerender(wrap([{ copy: "second" }]));
  expect(
    review.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (review.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("does not open a creation form for an already present ID and can retry with a new absent ID", async () => {
  let firstID = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const id = decodeURIComponent(String(url).split("/").at(-1)!);
      firstID ||= id;
      return json(
        id === firstID
          ? context({ ...group, id })
          : {
              target: { kind: "group", id },
              record: null,
              precondition: { exists: false, revision: `absent:${id}` },
            },
      );
    }),
  );
  mount(null);
  await screen.findByText("此用户组标识已存在，请使用新标识重新新建。");
  expect(screen.queryByLabelText("用户组名称")).toBeNull();
  await owner.click(() =>
    screen.getByRole("button", { name: "使用新标识重新新建" }),
  );
  expect(
    ((await screen.findByLabelText("用户组名称")) as HTMLInputElement).value,
  ).toBe("");
});

it("shows snapshot names, distinct counts and one added identity without borrowing mutated catalogs", async () => {
  const openingLabels: GroupReferenceLabels = {
    users: [{ id: "u1", name: "Shared snapshot name" }],
    services: [{ id: "plan-a", name: "Opening plan" }],
  };
  const latestLabels: GroupReferenceLabels = {
    users: [
      { id: "u1", name: "Shared snapshot name" },
      { id: "u2", name: "Shared snapshot name" },
    ],
    services: [{ id: "plan-a", name: "Latest plan" }],
  };
  const previewLabels: GroupReferenceLabels = {
    users: [
      { id: "u1", name: "Preview Alice" },
      { id: "u2", name: "Preview Bob" },
    ],
    services: [{ id: "plan-a", name: "Preview plan" }],
  };
  const latest = { ...group, memberIds: ["u1", "u2"] };
  let saved = group;
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/"))
        return json({
          ...context(saved, saved === group ? "opened-1" : "opened-2"),
          references: saved === group ? openingLabels : latestLabels,
        });
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      if (body.precondition.revision === "opened-1") return conflict();
      return json({
        ...reviewed(latest, body.change.group),
        resource: {
          ...reviewed(latest, body.change.group).resource,
          references: { before: previewLabels, after: previewLabels },
        },
      });
    }),
  );
  const view = mount();
  await name("Renamed family");
  saved = latest;
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  view.rerenderCatalogs(
    users.map((user) => ({ ...user, name: "Mutable catalog name" })),
    services.map((plan) => ({ ...plan, name: "Mutable catalog plan" })),
  );
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const comparison = within(
    await screen.findByRole("region", { name: "已保存的用户组变化" }),
  );
  const row = within(comparison.getByRole("row", { name: /^组成员 / }));
  expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "1 位",
    "2 位",
  ]);
  const added = within(comparison.getByRole("list", { name: "新增成员" }));
  expect(added.getAllByRole("listitem")).toHaveLength(1);
  expect(added.getByText("Shared snapshot name")).toBeTruthy();
  expect(added.getByText("u2")).toBeTruthy();
  expect(comparison.queryByText("Mutable catalog name")).toBeNull();
  expect(comparison.queryByText("u1、u2")).toBeNull();
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Renamed family",
  );
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("Family"),
  );
  await name("Renamed family");
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  await owner.click(() => review.getByText("查看完整成员与标识"));
  expect(review.getAllByText("Preview Alice").length).toBeGreaterThan(0);
  expect(review.getAllByText("Preview Bob").length).toBeGreaterThan(0);
  expect(review.queryByText("Shared snapshot name")).toBeNull();
  expect(review.queryByText("Mutable catalog name")).toBeNull();
  expect(writes[1]).toEqual({
    change: { group: { ...latest, name: "Renamed family" } },
    precondition: { exists: true, revision: "opened-2" },
  });
});

it("retains opening labels with their draft and uses an exact ID for a draft-only member absent from that snapshot", async () => {
  const openingLabels: GroupReferenceLabels = {
    users: [{ id: "u1", name: "Opening Alice" }],
    services: [{ id: "plan-a", name: "Opening plan" }],
  };
  const latestLabels: GroupReferenceLabels = {
    users: [{ id: "u1", name: "Latest Alice" }],
    services: [{ id: "plan-a", name: "Latest plan" }],
  };
  let latest = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/edit-context/")
        ? json({
            ...context(
              latest ? { ...group, priority: 9 } : group,
              latest ? "opened-2" : "opened-1",
            ),
            references: latest ? latestLabels : openingLabels,
          })
        : ((latest = true), conflict()),
    ),
  );
  const view = mount();
  await screen.findByLabelText("组成员");
  owner.assertActive();
  await owner.click(() => screen.getByLabelText("组成员"));
  await owner.click(() => screen.findByRole("option", { name: "Same person，标识：u2" }));
  await name("Draft with new member");
  await preview();
  await screen.findByText("用户组已更新。当前草稿尚未保存，请查看最新版本。");
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const latestRegion = within(
    await screen.findByRole("region", { name: "已保存的用户组变化" }),
  );
  await owner.click(() => latestRegion.getByText("查看完整成员与标识"));
  expect(latestRegion.getByText("Opening Alice")).toBeTruthy();
  expect(latestRegion.getByText("Latest Alice")).toBeTruthy();
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() =>
    screen.findByRole("button", { name: "使用最新版本" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("用户组优先级") as HTMLInputElement).value,
    ).toBe("9"),
  );
  view.rerenderCatalogs(
    users.map((user) => ({ ...user, name: "New catalog label" })),
    services.map((plan) => ({ ...plan, name: "New catalog plan" })),
  );
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const copyHeading = await screen.findByRole("heading", {
    name: "保留的草稿",
    level: 3,
  });
  const copySection = copyHeading.closest("section");
  expect(copySection?.getAttribute("aria-labelledby")).toBe(copyHeading.id);
  const copy = within(copySection!);
  expect(
    within(copy.getByRole("list", { name: "新增成员" })).getByText("u2"),
  ).toBeTruthy();
  expect(copy.queryByText("New catalog label")).toBeNull();
  expect(copy.queryByText("Latest Alice")).toBeNull();
  await owner.click(() => copy.getByText("查看完整成员与标识"));
  expect(copy.getAllByText("Opening Alice")).toHaveLength(2);
});

const emptyLabels: GroupReferenceLabels = { users: [], services: [] };
function comparisonResource(
  before: UserGroup | null,
  after: UserGroup,
  references?: GroupPolicyResource["references"],
): GroupPolicyResource {
  return {
    target: { kind: "group", id: after.id },
    before: before ? { group: before } : null,
    after: { group: after },
    references,
  };
}
it("leads with unique names once in each member delta and keeps exact IDs in the named disclosure", async () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(
        group,
        { ...group, memberIds: ["u2"] },
        {
          before: { users: [{ id: "u1", name: "Alice" }], services: [] },
          after: { users: [{ id: "u2", name: "Bob" }], services: [] },
        },
      )}
    />,
  );
  const added = within(screen.getByRole("list", { name: "新增成员" })),
    removed = within(screen.getByRole("list", { name: "移除成员" }));
  expect(added.getByText("Bob")).toBeTruthy();
  expect(added.queryByText("u2")).toBeNull();
  expect(removed.getByText("Alice")).toBeTruthy();
  expect(removed.queryByText("u1")).toBeNull();
  await owner.click(() => screen.getByText("查看完整成员与标识"));
  expect(
    within(screen.getByRole("list", { name: "当前保存的完整成员" })).getByText(
      "u1",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "本次保存的完整成员" })).getByText(
      "u2",
    ),
  ).toBeTruthy();
});

it("disambiguates same-named plan references by their distinct IDs", () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(
        group,
        { ...group, serviceId: "plan-b" },
        {
          before: { users: [], services: [{ id: "plan-a", name: "Standard" }] },
          after: { users: [], services: [{ id: "plan-b", name: "Standard" }] },
        },
      )}
    />,
  );
  const row = within(screen.getByRole("row", { name: /^服务方案 / }));
  expect(row.getAllByText("Standard")).toHaveLength(2);
  expect(row.getByText("plan-a")).toBeTruthy();
  expect(row.getByText("plan-b")).toBeTruthy();
});

it.each(["absent", "empty", "blank"] as const)(
  "keeps exact unknown member identity when labels are %s",
  (state) => {
    const references =
      state === "absent"
        ? undefined
        : {
            before: emptyLabels,
            after:
              state === "blank"
                ? { users: [{ id: "u2", name: "  " }], services: [] }
                : emptyLabels,
          };
    render(
      <GroupPolicyComparison
        resource={comparisonResource(
          group,
          { ...group, memberIds: ["u1", "u2"] },
          references,
        )}
      />,
    );
    const added = within(screen.getByRole("list", { name: "新增成员" }));
    expect(added.getByText("u2")).toBeTruthy();
    expect(added.getAllByRole("listitem")).toHaveLength(1);
  },
);

it.each([
  {
    label: "null to empty",
    before: null,
    after: [],
    count: "0 位",
    rawBefore: "null",
    rawAfter: "[]",
  },
  {
    label: "ordering",
    before: ["u2", "u1"],
    after: ["u1", "u2"],
    count: "2 位",
    rawBefore: '["u2","u1"]',
    rawAfter: '["u1","u2"]',
  },
  {
    label: "duplicate entries",
    before: ["u1", "u1"],
    after: ["u1"],
    count: "1 位",
    rawBefore: '["u1","u1"]',
    rawAfter: '["u1"]',
  },
])(
  "does not hide a $label record change behind equal membership counts",
  async ({ before, after, count, rawBefore, rawAfter }) => {
    render(
      <GroupPolicyComparison
        resource={comparisonResource(
          { ...group, memberIds: before },
          { ...group, memberIds: after },
        )}
      />,
    );
    const row = within(screen.getByRole("row", { name: /^组成员 / }));
    expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      count,
      count,
    ]);
    expect(screen.getByText("成员不变，保存格式调整")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "新增成员" })).toBeNull();
    expect(screen.queryByRole("list", { name: "移除成员" })).toBeNull();
    await owner.click(() => screen.getByText("查看完整成员与标识"));
    expect(screen.getByText(rawBefore)).toBeTruthy();
    expect(screen.getByText(rawAfter)).toBeTruthy();
  },
);

it("does not describe a label-only rename as a membership or service assignment change", () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(group, group, {
        before: {
          users: [{ id: "u1", name: "Old Alice" }],
          services: [{ id: "plan-a", name: "Old plan" }],
        },
        after: {
          users: [{ id: "u1", name: "New Alice" }],
          services: [{ id: "plan-a", name: "New plan" }],
        },
      })}
    />,
  );
  expect(screen.getByText("用户组设置保持不变。")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("list", { name: "新增成员" })).toBeNull();
  expect(screen.queryByRole("list", { name: "移除成员" })).toBeNull();
});

it.each([
  "duplicate-id",
  "wrong-kind",
  "foreign-before",
  "foreign-after",
  "missing-side",
  "extra-field",
  "non-string",
] as const)(
  "rejects %s preview label metadata without losing the draft or downgrading its guard",
  async (fault) => {
    const writes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/edit-context/")) return json(context(group));
        const body = JSON.parse(init!.body as string);
        writes.push(body);
        const labels = {
          users: [{ id: "u1", name: "Alice" }],
          services: [{ id: "plan-a", name: "Starter" }],
        };
        const response: any = reviewed(group, body.change.group);
        response.resource.references = {
          before: structuredClone(labels),
          after: structuredClone(labels),
        };
        const references = response.resource.references;
        if (fault === "duplicate-id")
          references.after.users.push({ id: "u1", name: "Alice" });
        if (fault === "wrong-kind")
          references.after.services = [{ id: "u1", name: "Alice" }];
        if (fault === "foreign-before")
          references.before.users.push({ id: "u2", name: "Other" });
        if (fault === "foreign-after")
          references.after.services = [{ id: "plan-b", name: "Other" }];
        if (fault === "missing-side") delete references.after;
        if (fault === "extra-field")
          references.after.users[0].login = "not-display-metadata";
        if (fault === "non-string") references.after.users[0].name = 7;
        return json(response);
      }),
    );
    mount();
    await name("Draft is retained");
    await preview();
    await screen.findByText(
      "服务未返回完整的用户组变更核对结果。当前草稿已保留，请重试。",
    );
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("Draft is retained");
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0].precondition).toEqual({
      exists: true,
      revision: "opened-1",
    });
  },
);

it.each(["null", "missing-collection", "duplicate-id"] as const)(
  "does not mount a draft from %s opening label metadata",
  async (fault) => {
    const labels: any = { users: [{ id: "u1", name: "Alice" }], services: [] };
    if (fault === "missing-collection") delete labels.services;
    if (fault === "duplicate-id")
      labels.users.push({ id: "u1", name: "Another name" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...context(group),
          references: fault === "null" ? null : labels,
        }),
      ),
    );
    mount();
    await screen.findByText(
      "服务未返回完整的用户组编辑数据。请重试；尚未打开可编辑草稿。",
    );
    expect(screen.queryByLabelText("用户组名称")).toBeNull();
  },
);

it("rejects a reference label on an absent creation context rather than inventing a saved association", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      json({
        target: {
          kind: "group",
          id: decodeURIComponent(String(url).split("/").at(-1)!),
        },
        record: null,
        precondition: { exists: false, revision: "absent-1" },
        references: { users: [{ id: "u1", name: "Alice" }], services: [] },
      }),
    ),
  );
  mount(null);
  await screen.findByText(
    "服务未返回完整的用户组编辑数据。请重试；尚未打开可编辑草稿。",
  );
  expect(screen.queryByLabelText("用户组名称")).toBeNull();
});

it("distinguishes a known name that collides with another member's unknown-ID fallback", () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(
        group,
        { ...group, memberIds: ["u1", "u2"] },
        {
          before: emptyLabels,
          after: { users: [{ id: "u2", name: "u1" }], services: [] },
        },
      )}
    />,
  );
  const added = within(screen.getByRole("list", { name: "新增成员" }));
  expect(added.getByText("u1")).toBeTruthy();
  expect(added.getByText("u2")).toBeTruthy();
});

it("keeps distinct raw group names visible when both format to the same empty-name placeholder", () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(
        { ...group, name: "未命名" },
        { ...group, name: "" },
      )}
    />,
  );
  const row = within(screen.getByRole("row", { name: /^用户组名称 / }));
  expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    '未命名（保存值："未命名"）',
    '未命名（保存值：""）',
  ]);
});

it("rejects a label borrowed from the before-side ID set for a different after-side member", async () => {
  const candidate = { ...group, memberIds: ["u2"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        ...reviewed(group, candidate),
        resource: {
          ...reviewed(group, candidate).resource,
          references: {
            before: { users: [{ id: "u1", name: "Alice" }], services: [] },
            after: { users: [{ id: "u1", name: "Alice" }], services: [] },
          },
        },
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  function Harness() {
    const policy = usePolicyChange({
      mode: "guarded-group",
      users: [],
      services: [],
      routes: [],
      onApplied: () => {},
    });
    return (
      <>
        <button
          onClick={() =>
            policy.propose(
              { group: candidate },
              { exists: true, revision: "opened-1" },
            )
          }
        >
          Preview
        </button>
        <p>{policy.error?.message}</p>
        {policy.dialog}
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Harness />
      </UIProviders>
    </QueryClientProvider>,
  );
  await owner.click(() => screen.getByRole("button", { name: "Preview" }));
  await screen.findByText(
    "服务未返回完整的用户组变更核对结果。当前草稿已保留，请重试。",
  );
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

it("counts distinct initial members and lists their additions once when creating a group", () => {
  render(
    <GroupPolicyComparison
      resource={comparisonResource(
        null,
        { ...group, memberIds: ["u1", "u1"] },
        {
          before: emptyLabels,
          after: { users: [{ id: "u1", name: "Alice" }], services: [] },
        },
      )}
    />,
  );
  const row = within(screen.getByRole("row", { name: /^组成员 / }));
  expect(row.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "尚未创建",
    "1 位",
  ]);
  const added = within(screen.getByRole("list", { name: "新增成员" }));
  expect(added.getAllByRole("listitem")).toHaveLength(1);
  expect(added.getByText("Alice")).toBeTruthy();
  expect(added.queryByText("u1")).toBeNull();
});


it.each(["parentheses", "metadata"] as const)("keeps literal %s names distinct from duplicate member and service identities", async (style) => {
  const literalPlan = style === "parentheses" ? "Same name（plan-a）" : "Same name，标识：plan-a";
  const literalUser = style === "parentheses" ? "Same person（u1）" : "Same person，标识：u1";
  const planChoice = style === "parentheses" ? literalPlan : `${literalPlan}，标识：plan-c`;
  const userChoice = style === "parentheses" ? literalUser : `${literalUser}，标识：u3`;
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/edit-context/")) return json(context(group));
    const body = JSON.parse(init!.body as string);
    writes.push(body);
    return json(reviewed(group, body.change.group));
  }));
  const view = mount();
  await screen.findByLabelText("组服务方案");
  view.rerenderCatalogs(
    [...users, { ...users[0], id: "u3", name: literalUser }],
    [...services, { ...service, id: "plan-c", name: literalPlan }],
  );
  await owner.click(() => screen.getByLabelText("组服务方案"));
  const planA = await screen.findByRole("option", { name: "Same name，标识：plan-a" });
  expect(within(planA).getByText("Same name", { exact: true })).toBeTruthy();
  expect(within(planA).getByText("plan-a", { exact: true })).toBeTruthy();
  await owner.change(() => screen.getByRole("combobox", { name: "搜索选项" }), { target: { value: "plan-c" } });
  await owner.click(() => screen.getByRole("option", { name: planChoice }));
  expect(screen.getByLabelText("组服务方案").textContent).toContain(literalPlan);
  await owner.click(() => screen.getByLabelText("组成员"));
  const userOne = await screen.findByRole("option", { name: "Same person，标识：u1" });
  expect(within(userOne).getByText("u1", { exact: true })).toBeTruthy();
  await owner.change(() => screen.getByRole("combobox", { name: "搜索选项" }), { target: { value: "u3" } });
  await owner.click(() => screen.getByRole("option", { name: userChoice }));
  await owner.click(() => screen.getByLabelText("用户组名称"));
  expect(screen.getByRole("button", { name: "移除 Same person，标识：u1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: `移除 ${userChoice}` })).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "移除 Same person，标识：u1" }));
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  expect(writes[0].change.group).toMatchObject({ serviceId: "plan-c", memberIds: ["u3"] });
  expect(writes[0].precondition).toEqual({ exists: true, revision: "opened-1" });
});

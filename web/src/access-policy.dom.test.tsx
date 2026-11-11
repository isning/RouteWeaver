// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import type { ReactNode } from "react";
import { UserGroups } from "./AccessPolicy";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { groupEditFixture } from "./test-support/group-edit-fixture";
import type { Service } from "./types";
type PolicyTestOwner = ReturnType<typeof ownedClickScenario>;
let currentOwner: PolicyTestOwner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(owner: PolicyTestOwner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  // Ant's test-only constant portal IDs collide when the asynchronously loaded
  // user form mounts a closed review modal. Use real IDs for Escape stacking.
  vi.stubEnv("NODE_ENV", "development");
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
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function editPolicyField(
  owner: PolicyTestOwner,
  field: HTMLElement,
  kind: string,
) {
  owner.assertActive();
  if (kind === "service") {
    owner.assertActive();
    fireEvent.change(field, { target: { value: "Revised" } });
  } else {
    owner.assertActive();
    await userEvent.click(field);
    owner.assertActive();
    const day = document.querySelector(
      '[data-slot="calendar"] button[data-day]:not(:disabled)',
    );
    if (!day) throw new Error("Calendar day unavailable");
    owner.assertActive();
    await userEvent.click(day);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    owner.assertActive();
    await waitFor(() => expect((field as HTMLInputElement).value).not.toBe(""));
    owner.assertActive();
  }
  return (field as HTMLInputElement).value;
}
const service = {
  id: "plan-a",
  name: "Standard",
  quotaBytes: 107374182400,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
};
const serviceFixture = serviceEditFixture(service);
const groupFixture = groupEditFixture({
  id: "g1",
  name: "Family",
  serviceId: "plan-a",
  priority: 1,
  memberIds: ["u1"],
});
const before = {
  userId: "u1",
  groupIds: [],
  routeIds: [],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: { service: "none" },
  entitlement: {
    userId: "u1",
    startsAt: "2026-01-01T00:00:00Z",
    cycle: { mode: "none", anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" },
  },
};
const after = {
  ...before,
  serviceId: "plan-a",
  service,
  groupIds: ["g1"],
  quotaBytes: 107374182400,
  onlineIpLimit: 2,
  connectionLimit: 8,
  entryRateBps: 1024,
  provenance: { service: "group", quotaBytes: "service:plan-a" },
};
const userFixture = entitlementEditFixture(before);
describe("access policy user tasks", () => {
  it("reviews affected users, preserves edited membership on stale apply and requires a fresh preview", async () => {
    const owner = currentOwner;
    owner.assertActive();
    const writes: any[] = [];
    let previews = 0;
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/access-policy/edit-context/group/"))
          return json(groupFixture.context());
        if (String(url).endsWith("/user-groups"))
          return json([
            {
              id: "g1",
              name: "Family",
              serviceId: "plan-a",
              priority: 1,
              memberIds: ["u1"],
            },
          ]);
        const body = JSON.parse(init.body);
        writes.push({ url: String(url), body });
        if (String(url).endsWith("/preview"))
          return json(
            groupFixture.preview(body.change.group, {
              revision: `review-${++previews}`,
              affected: [{ userId: "u1", before, after }],
              blockers: [],
            }),
          );
        return json({ error: "Policy changed; preview again" }, 409);
      }),
    );
    mount(
      owner,
      <UserGroups
        users={[
          {
            id: "u1",
            name: "Alice",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          },
        ]}
        services={[service]}
        routes={[]}
      />,
    );
    const user = userEvent.setup();
    owner.assertActive();
    const ownedTarget1 = await screen.findByRole("button", {
      name: "编辑 Family",
    });
    owner.assertActive();
    await user.click(ownedTarget1);
    owner.assertActive();
    fireEvent.change(await screen.findByLabelText("用户组名称"), {
      target: { value: "Family revised" },
    });
    owner.assertActive();
    await user.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await screen.findByText("确认授权变更");
    owner.assertActive();
    expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
    owner.assertActive();
    await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
    owner.assertActive();
    await user.click(screen.getByRole("button", { name: "更新授权" }));
    owner.assertActive();
    await screen.findByText("Policy changed; preview again");
    owner.assertActive();
    expect(screen.queryByRole("button", { name: "更新授权" })).toBeNull();
    expect(
      (screen.getByLabelText("用户组名称") as HTMLInputElement).value,
    ).toBe("Family revised");
    owner.assertActive();
    await user.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await screen.findByText("确认授权变更");
    owner.assertActive();
    expect(writes[1].body).toEqual({
      change: {
        group: {
          id: "g1",
          name: "Family revised",
          serviceId: "plan-a",
          priority: 1,
          memberIds: ["u1"],
        },
      },
      revision: "review-1",
    });
    expect(writes[2].body).toEqual(writes[0].body);
    expect(writes[0].body.precondition).toEqual(
      groupFixture.context().precondition,
    );
  });
});

it("retains explicit zero and empty-route overrides, and blocks applying conflicting policies", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  let payload: any;
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture({
    ...after,
    entitlement: {
      ...before.entitlement,
      quotaOverride: 0,
      routeIdsOverride: [],
      connectionLimitOverride: 8,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async (_url, init) => {
        payload = JSON.parse(init.body);
        return json({
          revision: "blocked",
          affected: [
            { userId: "u1", before, after: { ...after, status: "ambiguous" } },
          ],
          blockers: ["Same-priority groups select different plans"],
        });
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  owner.assertActive();
  await user.click(screen.getByText("个人额度与限制"));
  owner.assertActive();
  await user.click(
    screen.getByRole("checkbox", { name: "覆盖个人并发逻辑流数上限" }),
  );
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("Same-priority groups select different plans");
  owner.assertActive();
  expect(payload.entitlement.quotaOverride).toBe(0);
  expect(payload.entitlement.routeIdsOverride).toEqual([]);
  expect(payload.entitlement.connectionLimitOverride).toBeNull();
  expect(payload.entitlement.cycle).toEqual(before.entitlement.cycle);
  owner.assertActive();
  await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
  owner.assertActive();
  expect(
    (screen.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("previews separate service stream and IP limits before applying the frozen change", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { ServicePolicyEditor } = await import("./ServicePolicyEditor");
  owner.assertActive();
  const writes: any[] = [];
  const applied = vi.fn();
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/access-policy/edit-context/service/"))
        return json(serviceFixture.context());
      const body = JSON.parse(init.body);
      writes.push({ url: String(url), body });
      return json(
        String(url).endsWith("/preview")
          ? serviceFixture.preview(body.change.service, {
              revision: "service-review",
              affected: [],
              blockers: [],
            })
          : { revision: "service-review", affected: [], blockers: [] },
      );
    }),
  );
  mount(
    owner,
    <ServicePolicyEditor
      initial={{
        ...service,
        cycle: {
          mode: "none",
          anchor: "2026-01-01T00:00:00Z",
          timezone: "UTC+8",
        },
      }}
      users={[]}
      services={[service]}
      routes={[]}
      onClose={applied}
    />,
  );
  const user = userEvent.setup();
  owner.assertActive();
  const limits = await screen.findByText("在线、并发与速率限制");
  owner.assertActive();
  await user.click(limits);
  owner.assertActive();
  fireEvent.change(screen.getByLabelText("账号并发逻辑流数上限"), {
    target: { value: "12" },
  });
  owner.assertActive();
  fireEvent.change(screen.getByLabelText("账号在线 IP 数上限"), {
    target: { value: "2" },
  });
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("确认授权变更");
  owner.assertActive();
  expect(writes[0].body.change.service).toMatchObject({
    connectionLimit: 12,
    onlineIpLimit: 2,
    quotaBytes: 107374182400,
  });
  owner.assertActive();
  await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "更新授权" }));
  owner.assertActive();
  await waitFor(() => expect(applied).toHaveBeenCalledOnce());
  owner.assertActive();
  expect(writes[0].body.precondition).toEqual(
    serviceFixture.context().precondition,
  );
  expect(writes[1].body).toEqual({
    change: writes[0].body.change,
    revision: "service-review",
  });
});
it("does not open an obsolete policy review after the operator edits the pending draft", async () => {
  const owner = currentOwner;
  owner.assertActive();
  let finish: ((value: Response) => void) | undefined;
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/access-policy/edit-context/group/")
        ? json(groupFixture.context())
        : String(url).endsWith("/user-groups")
          ? json([
              {
                id: "g1",
                name: "Family",
                serviceId: "plan-a",
                priority: 1,
                memberIds: ["u1"],
              },
            ])
          : new Promise<Response>((resolve) => {
              finish = resolve;
            }),
    ),
  );
  mount(owner, <UserGroups users={[]} services={[service]} routes={[]} />);
  const user = userEvent.setup();
  owner.assertActive();
  const ownedTarget2 = await screen.findByRole("button", {
    name: "编辑 Family",
  });
  owner.assertActive();
  await user.click(ownedTarget2);
  owner.assertActive();
  await user.click(await screen.findByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await waitFor(() => expect(finish).toBeTruthy());
  owner.assertActive();
  fireEvent.change(await screen.findByLabelText("用户组名称"), {
    target: { value: "Edited while reviewing" },
  });
  finish!(
    json(
      groupFixture.preview(groupFixture.context().record.group, {
        revision: "obsolete",
        affected: [],
        blockers: [],
      }),
    ),
  );
  owner.assertActive();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "预览影响" }) as HTMLButtonElement)
        .className,
    ).not.toContain("loading"),
  );
  owner.assertActive();
  expect(screen.queryByText("确认授权变更")).toBeNull();
  expect((screen.getByLabelText("用户组名称") as HTMLInputElement).value).toBe(
    "Edited while reviewing",
  );
});
it("keeps a cap reduction draft blocked while current admissions exceed the proposed cap", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  let requests = 0;
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture({
    ...after,
    entitlement: { ...before.entitlement, connectionLimitOverride: 1 },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async () => {
        requests++;
        return json({
          revision: "active-cap",
          affected: [
            {
              userId: "u1",
              before: after,
              after: { ...after, connectionLimit: 1 },
            },
          ],
          blockers: [
            "当前并发逻辑流 2 条超过新上限 1 条，请等待连接释放后重新预览。",
          ],
        });
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText(
    "当前并发逻辑流 2 条超过新上限 1 条，请等待连接释放后重新预览。",
  );
  owner.assertActive();
  await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
  owner.assertActive();
  expect(
    (screen.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "返回编辑" }));
  owner.assertActive();
  await user.click(screen.getByText("个人额度与限制"));
  owner.assertActive();
  expect(
    (screen.getByLabelText("个人并发逻辑流数上限") as HTMLInputElement).value,
  ).toBe("1");
  expect(requests).toBe(1);
});

it.each(["service", "user"])(
  "protects unsaved %s policy edits when cancelling the drawer",
  async (kind) => {
    const owner = currentOwner;
    owner.assertActive();
    const { ServicePolicyEditor } = await import("./ServicePolicyEditor");
    owner.assertActive();
    const { UserPolicyEditor } = await import("./UserPolicyEditor");
    owner.assertActive();
    const close = vi.fn();
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        userFixture.transport(async (url) =>
          String(url).includes("/access-policy/edit-context/service/")
            ? json(serviceFixture.context())
            : json({ entries: [], onlineIps: [] }),
        ),
      ),
    );
    mount(
      owner,
      kind === "service" ? (
        <ServicePolicyEditor
          initial={service}
          users={[]}
          services={[service]}
          routes={[]}
          onClose={close}
        />
      ) : (
        <UserPolicyEditor
          user={{
            id: "u1",
            name: "Alice",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          }}
          services={[service]}
          routes={[]}
          onClose={close}
        />
      ),
    );
    owner.assertActive();
    const field = await screen.findByLabelText(
      kind === "service" ? "服务方案名称" : "到期时间（留空为不过期）",
    );
    owner.assertActive();
    const value = await editPolicyField(owner, field, kind);
    owner.assertActive();
    const operator = userEvent.setup();
    owner.assertActive();
    await operator.click(screen.getByRole("button", { name: "取消" }));
    owner.assertActive();
    expect(close).not.toHaveBeenCalled();
    owner.assertActive();
    const keepEditing = await screen.findByRole("button", { name: "继续编辑" });
    owner.assertActive();
    await waitFor(() => expect(document.activeElement).toBe(keepEditing));
    owner.assertActive();
    await operator.keyboard("{Enter}");
    owner.assertActive();
    expect(close).not.toHaveBeenCalled();
    expect((field as HTMLInputElement).value).toBe(value);
    owner.assertActive();
    await operator.click(screen.getByRole("button", { name: "取消" }));
    owner.assertActive();
    const ownedTarget3 = await screen.findByRole("button", {
      name: "放弃修改",
    });
    owner.assertActive();
    await operator.click(ownedTarget3);
    owner.assertActive();
    expect(close).toHaveBeenCalledOnce();
  },
);

for (const kind of ["service", "user"] as const) {
  async function openEditor(owner: PolicyTestOwner) {
    owner.assertActive();
    const { ServicePolicyEditor } = await import("./ServicePolicyEditor");
    owner.assertActive();
    const { UserPolicyEditor } = await import("./UserPolicyEditor");
    owner.assertActive();
    const close = vi.fn();
    mount(
      owner,
      kind === "service" ? (
        <ServicePolicyEditor
          initial={service}
          users={[]}
          services={[service]}
          routes={[]}
          onClose={close}
        />
      ) : (
        <UserPolicyEditor
          user={{
            id: "u1",
            name: "Alice",
            enabled: true,
            quotaBytes: 0,
            usedBytes: 0,
          }}
          services={[service]}
          routes={[]}
          onClose={close}
        />
      ),
    );
    owner.assertActive();
    const field = await screen.findByLabelText(
      kind === "service" ? "服务方案名称" : "到期时间（留空为不过期）",
    );
    owner.assertActive();
    return {
      close,
      field,
      value: kind === "service" ? "Revised" : "2027-01-01T00:00:00Z",
    };
  }
  function fixture(
    owner: PolicyTestOwner,
    response: (url: string, submitted?: Service) => Promise<Response>,
  ) {
    owner.assertActive();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        userFixture.transport(async (url, init) =>
          String(url).includes("/access-policy/edit-context/service/")
            ? json(serviceFixture.context())
            : String(url).endsWith("/admission-status")
              ? json({ entries: [], onlineIps: [] })
              : response(
                  String(url),
                  kind === "service" && String(url).endsWith("/preview")
                    ? JSON.parse(init!.body as string).change.service
                    : undefined,
                ),
        ),
      ),
    );
  }
  it.each(["close", "escape", "mask"])(
    `${kind} policy guards dirty drawer %s and preserves the draft`,
    async (action) => {
      const owner = currentOwner;
      owner.assertActive();
      fixture(owner, async () => json({}));
      owner.assertActive();
      const { close, field } = await openEditor(owner);
      owner.assertActive();
      const value = await editPolicyField(owner, field, kind);
      owner.assertActive();
      if (action === "close")
        fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      if (action === "escape") {
        owner.assertActive();
        screen.getByRole("button", { name: "关闭" }).focus();
        owner.assertActive();
        await userEvent.keyboard("{Escape}");
        owner.assertActive();
      }
      if (action === "mask")
        await userEvent.click(document.querySelector('[data-slot="sheet-overlay"]')!);
      expect(close).not.toHaveBeenCalled();
      owner.assertActive();
      const ownedTarget4 = await screen.findByRole("button", {
        name: "继续编辑",
      });
      owner.assertActive();
      await userEvent.click(ownedTarget4);
      owner.assertActive();
      expect((field as HTMLInputElement).value).toBe(value);
      expect(close).not.toHaveBeenCalled();
    },
  );
  it(`${kind} policy closes immediately without edits`, async () => {
    const owner = currentOwner;
    owner.assertActive();
    fixture(owner, async () => json({}));
    owner.assertActive();
    const { close } = await openEditor(owner);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    owner.assertActive();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText("放弃尚未保存的授权修改？")).toBeNull();
  });
  it(`${kind} policy cannot close during preview or apply and closes after successful save`, async () => {
    const owner = currentOwner;
    owner.assertActive();
    let preview: ((r: Response) => void) | undefined;
    let apply: ((r: Response) => void) | undefined;
    let submittedService: Service | undefined;
    fixture(
      owner,
      (url, submitted) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith("/preview")) {
            submittedService = submitted;
            preview = resolve;
          } else apply = resolve;
        }),
    );
    owner.assertActive();
    const { close, field } = await openEditor(owner);
    owner.assertActive();
    const value = await editPolicyField(owner, field, kind);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await waitFor(() => expect(preview).toBeTruthy());
    owner.assertActive();
    const tryDismiss = async () => {
      owner.assertActive();
      expect(
        (screen.getByText("取消", { selector: "button" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
      const overlay = document.querySelector('[data-slot="dialog-overlay"]') || document.querySelector('[data-slot="sheet-overlay"]')!;
      await userEvent.click(overlay);
      fireEvent.keyDown(screen.getAllByRole("dialog")[0], {
        key: "Escape",
        keyCode: 27,
      });
      expect(close).not.toHaveBeenCalled();
    };
    await tryDismiss();
    const reviewed = { revision: "r1", affected: [], blockers: [] };
    preview!(
      json(
        kind === "service"
          ? serviceFixture.preview(submittedService!, reviewed)
          : reviewed,
      ),
    );
    owner.assertActive();
    const ownedTarget5 = await screen.findByRole("checkbox", {
      name: /我已核对/,
    });
    owner.assertActive();
    await userEvent.click(ownedTarget5);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "更新授权" }));
    owner.assertActive();
    await waitFor(() => expect(apply).toBeTruthy());
    owner.assertActive();
    await tryDismiss();
    apply!(json({ revision: "r2", affected: [], blockers: [] }));
    owner.assertActive();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    owner.assertActive();
    expect(screen.queryByText("放弃尚未保存的授权修改？")).toBeNull();
  });
  it(`${kind} policy retains its draft after apply fails and review is cancelled`, async () => {
    const owner = currentOwner;
    owner.assertActive();
    fixture(owner, async (url, submitted) =>
      url.endsWith("/preview")
        ? json(
            kind === "service"
              ? serviceFixture.preview(submitted!, {
                  revision: "r1",
                  affected: [],
                  blockers: [],
                })
              : { revision: "r1", affected: [], blockers: [] },
          )
        : json({ error: "Could not save policy" }, 500),
    );
    owner.assertActive();
    const { close, field } = await openEditor(owner);
    owner.assertActive();
    const value = await editPolicyField(owner, field, kind);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    const ownedTarget6 = await screen.findByRole("checkbox", {
      name: /我已核对/,
    });
    owner.assertActive();
    await userEvent.click(ownedTarget6);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "更新授权" }));
    owner.assertActive();
    await screen.findAllByText("Could not save policy");
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "返回编辑" }));
    owner.assertActive();
    expect((field as HTMLInputElement).value).toBe(value);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    owner.assertActive();
    const ownedTarget7 = await screen.findByRole("button", {
      name: "继续编辑",
    });
    owner.assertActive();
    await userEvent.click(ownedTarget7);
    owner.assertActive();
    expect((field as HTMLInputElement).value).toBe(value);
    expect(close).not.toHaveBeenCalled();
  });
}

it("shows an unset service start without the zero-date sentinel and preserves its policy when previewing unrelated changes", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyEditor } = await import("./UserPolicyEditor");
  owner.assertActive();
  const original = {
    ...before,
    entitlement: {
      ...before.entitlement,
      startsAt: "0001-01-01T00:00:00Z",
      cycle: {
        mode: "none",
        anchor: "0001-01-01T00:00:00Z",
        timezone: "UTC+8",
      },
    },
  };
  const entitlementFixture = entitlementEditFixture(original);
  let submitted: any;
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async (url, init) => {
        if (String(url).endsWith("/admission-status"))
          return json({ entries: [], onlineIps: [] });
        submitted = JSON.parse(init.body);
        return json({
          revision: "unchanged-calendar",
          affected: [],
          blockers: [],
        });
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyEditor
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  owner.assertActive();
  const starts = await screen.findByLabelText("开通时间");
  owner.assertActive();
  expect((starts as HTMLInputElement).value).toBe("");
  expect(screen.getByText("留空保留现有开通时间。")).toBeTruthy();
  owner.assertActive();
  await userEvent.click(screen.getByRole("switch", { name: "暂停平台服务" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("确认授权变更");
  owner.assertActive();
  expect(submitted.entitlement.startsAt).toBe("0001-01-01T00:00:00Z");
  expect(submitted.entitlement.cycle).toEqual(original.entitlement.cycle);
  expect(submitted.entitlement.paused).toBe(true);
  owner.assertActive();
  await userEvent.click(screen.getByRole("checkbox", { name: /我已核对/ }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "更新授权" }));
  owner.assertActive();
  await waitFor(() =>
    expect(submitted.change?.entitlement.startsAt).toBe("0001-01-01T00:00:00Z"),
  );
  owner.assertActive();
  expect(submitted.change.entitlement.cycle).toEqual(
    original.entitlement.cycle,
  );
  expect(
    vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/reset")),
  ).toBe(false);
});

it.each([
  ["2026-01-01T08:00:00.123456789+08:00", undefined],
  ["0001-01-01T00:00:00Z", "2027-01-01T08:00:00+08:00"],
])(
  "preserves the calendar and exact explicit timestamp when editing start %s",
  async (startsAt, changed) => {
    const owner = currentOwner;
    owner.assertActive();
    const { UserPolicyForm } = await import("./UserPolicyEditor");
    owner.assertActive();
    const cycle = {
      mode: "monthly",
      day: 15,
      anchor: "2025-10-15T00:00:00Z",
      timezone: "UTC+8",
    };
    let submitted: any;
    owner.assertActive();
    const entitlementFixture = entitlementEditFixture({
      ...before,
      entitlement: { ...before.entitlement, startsAt, cycle },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        entitlementFixture.transport(async (_url, init) => {
          submitted = JSON.parse(init.body);
          return json({ revision: "same-cycle", affected: [], blockers: [] });
        }),
      ),
    );
    mount(
      owner,
      <UserPolicyForm
        user={{
          id: "u1",
          name: "Alice",
          enabled: true,
          quotaBytes: 0,
          usedBytes: 0,
        }}
        initial={entitlementFixture.context()}
        services={[service]}
        routes={[]}
        onClose={() => {}}
      />,
    );
    const startField = screen.getByLabelText("开通时间");
    owner.assertActive();
    const selected = changed
      ? await editPolicyField(owner, startField, "user")
      : undefined;
    owner.assertActive();
    if (!changed)
      expect((startField as HTMLInputElement).value).toBe(
        "2026-01-01 08:00:00",
      );
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await screen.findByText("确认授权变更");
    owner.assertActive();
    if (selected) {
      const expected = new Date(
        selected.replace(" ", "T") + "+08:00",
      ).getTime();
      expect(
        Math.floor(Date.parse(submitted.entitlement.startsAt) / 1000),
      ).toBe(Math.floor(expected / 1000));
    } else expect(submitted.entitlement.startsAt).toBe(startsAt);
    expect(submitted.entitlement.cycle).toEqual(cycle);
  },
);

it.each([
  "not-a-timestamp",
  "2026-02-30T08:00:00+08:00",
  "2026-10-20T08:00:00",
])(
  "keeps invalid backend start %s visible and blocks preview until explicitly corrected",
  async (startsAt) => {
    const owner = currentOwner;
    owner.assertActive();
    const { UserPolicyForm } = await import("./UserPolicyEditor");
    owner.assertActive();
    const writes: unknown[] = [];
    owner.assertActive();
    const entitlementFixture = entitlementEditFixture({
      ...before,
      entitlement: { ...before.entitlement, startsAt },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        entitlementFixture.transport(async (_url, init) => {
          writes.push(JSON.parse(init.body));
          return json({ revision: "fixed-start", affected: [], blockers: [] });
        }),
      ),
    );
    mount(
      owner,
      <UserPolicyForm
        user={{
          id: "u1",
          name: "Alice",
          enabled: true,
          quotaBytes: 0,
          usedBytes: 0,
        }}
        initial={entitlementFixture.context()}
        services={[service]}
        routes={[]}
        onClose={() => {}}
      />,
    );
    const field = screen.getByLabelText("开通时间");
    expect((field as HTMLInputElement).value).toBe(startsAt);
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await screen.findByText(
      "请填写有效的开通时间并包含时区，例如 2026-10-20T08:00:00+08:00",
    );
    owner.assertActive();
    expect(writes).toEqual([]);
    expect((field as HTMLInputElement).value).toBe(startsAt);
    owner.assertActive();
    fireEvent.change(field, { target: { value: "2026-10-20T08:00:00+08:00" } });
    owner.assertActive();
    await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
    owner.assertActive();
    await screen.findByText("确认授权变更");
    owner.assertActive();
    expect(writes).toHaveLength(1);
  },
);

it("does not offer clearing an explicit service start or change it during unrelated preview", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  const fetcher = vi.fn(async () =>
    json({ revision: "unchanged", affected: [], blockers: [] }),
  );
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture(before);
  vi.stubGlobal("fetch", vi.fn(entitlementFixture.transport(fetcher)));
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  const start = screen.getByLabelText("开通时间") as HTMLInputElement;
  expect(start.readOnly).toBe(true);
  expect(
    start.parentElement!.querySelector('[aria-label="清除日期"]'),
  ).toBeNull();
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("确认授权变更");
  owner.assertActive();
  expect(
    JSON.parse((fetcher.mock.calls[0] as any)[1].body).entitlement.startsAt,
  ).toBe(before.entitlement.startsAt);
});

it("groups service traffic and reset policy separately from route access", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { ServicePolicyEditor } = await import("./ServicePolicyEditor");
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/access-policy/edit-context/service/"))
        return json(serviceFixture.context());
      throw new Error(`Unexpected request: ${String(url)}`);
    }),
  );
  mount(
    owner,
    <ServicePolicyEditor
      initial={service as any}
      users={[]}
      services={[]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  const traffic = await screen.findByRole("group", { name: "流量与重置" });
  owner.assertActive();
  expect(
    within(traffic).getByLabelText("周期额度（GiB，0 为不限额）"),
  ).toBeTruthy();
  expect(within(traffic).getByLabelText("默认重置规则")).toBeTruthy();
  expect(within(traffic).queryByLabelText("方案授权线路")).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "线路权限" })).getByLabelText(
      "方案授权线路",
    ),
  ).toBeTruthy();
});
it("submits personal human-unit overrides as exact bytes without changing inheritance or cycle", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  let submitted: any;
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture(before);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async (_url, init) => {
        submitted = JSON.parse(init.body);
        return json({ revision: "units", affected: [], blockers: [] });
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  owner.assertActive();
  await userEvent.click(screen.getByText("个人额度与限制"));
  owner.assertActive();
  await userEvent.click(
    screen.getByRole("checkbox", { name: "覆盖个人周期额度（GiB）" }),
  );
  owner.assertActive();
  fireEvent.change(screen.getByLabelText("个人周期额度（GiB）"), {
    target: { value: "0.5" },
  });
  owner.assertActive();
  await userEvent.click(
    screen.getByRole("checkbox", { name: "覆盖个人入口限速（Mbps）" }),
  );
  owner.assertActive();
  fireEvent.change(screen.getByLabelText("个人入口限速（Mbps）"), {
    target: { value: "100" },
  });
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("确认授权变更");
  owner.assertActive();
  expect(submitted.entitlement.quotaOverride).toBe(536870912);
  expect(submitted.entitlement.entryRateBpsOverride).toBe(12500000);
  expect(submitted.entitlement.onlineIpLimitOverride).toBeNull();
  expect(submitted.entitlement.connectionLimitOverride).toBeNull();
  expect(submitted.entitlement.cycle).toEqual(before.entitlement.cycle);
});

it("keeps reviewed rate units consistent and avoids duplicate no-plan provenance", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { PolicySummary } = await import("./AccessPolicy");
  owner.assertActive();
  mount(
    owner,
    <PolicySummary
      policy={{ ...before, entryRateBps: 12500000 }}
      services={[]}
      routes={[]}
    />,
  );
  expect(screen.getByText("100 Mbps")).toBeTruthy();
  expect(screen.queryByText("11.9 MiB/s")).toBeNull();
  expect(screen.getAllByText("无方案")).toHaveLength(1);
});

it("focuses authorization review on changed values while keeping full policy available", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { usePolicyChange } = await import("./AccessPolicy");
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        revision: "r",
        blockers: [],
        affected: [
          {
            userId: "u1",
            before,
            after: {
              ...before,
              entryRateBps: 12500000,
              provenance: { ...before.provenance, entryRateBps: "individual" },
            },
          },
        ],
      }),
    ),
  );
  function Review() {
    const change = usePolicyChange({
      mode: "legacy-replacement",
      users: [{ id: "u1", name: "Alice" }],
      services: [],
      routes: [],
      onApplied: () => {},
    });
    return (
      <>
        <button
          onClick={() => change.propose({ entitlement: before.entitlement })}
        >
          Review change
        </button>
        {change.dialog}
      </>
    );
  }
  mount(owner, <Review />);
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "Review change" }));
  owner.assertActive();
  const dialog = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  owner.assertActive();
  expect(dialog.getByText("100 Mbps")).toBeTruthy();
  expect(dialog.queryAllByText("周期额度")).toHaveLength(0);
  expect(dialog.queryAllByText("账号周期")).toHaveLength(0);
  owner.assertActive();
  await userEvent.click(dialog.getByRole("checkbox", { name: "显示完整授权" }));
  owner.assertActive();
  expect(dialog.getAllByText("周期额度")).toHaveLength(1);
  expect(dialog.getAllByText("账号周期")).toHaveLength(1);
  expect(
    dialog.getByRole("button", { name: "更新授权" }).hasAttribute("disabled"),
  ).toBe(true);
});

it.each([
  [null, "继承线路授权"],
  [["r1"], "指定个人线路"],
  [[], "禁止所有线路"],
] as const)(
  "shows effective access and an explicit route mode for %j",
  async (routeIdsOverride, mode) => {
    const owner = currentOwner;
    owner.assertActive();
    const { UserPolicyForm } = await import("./UserPolicyEditor");
    owner.assertActive();
    const entitlementFixture = entitlementEditFixture({
      ...before,
      entitlement: {
        ...before.entitlement,
        routeIdsOverride:
          routeIdsOverride === null ? null : [...routeIdsOverride],
      },
    });
    mount(
      owner,
      <UserPolicyForm
        user={{
          id: "u1",
          name: "Alice",
          enabled: true,
          quotaBytes: 0,
          usedBytes: 0,
        }}
        initial={entitlementFixture.context()}
        services={[service]}
        routes={[{ id: "r1", name: "香港线路" }]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "当前生效授权" })).toBeTruthy();
    expect(
      screen.getByRole("radio", { name: mode }).getAttribute("aria-checked"),
    ).toBe("true");
  },
);

it("requires an explicit route-denial choice and preserves null inheritance in preview payloads", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  const writes: any[] = [];
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture(before);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async (_url, init) => {
        writes.push(JSON.parse(init.body));
        return json({ message: "预览暂不可用" }, 500);
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[{ id: "r1", name: "香港线路" }]}
      onClose={() => {}}
    />,
  );
  owner.assertActive();
  await userEvent.click(screen.getByRole("radio", { name: "指定个人线路" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText(
    "请至少选择一条线路；如需停用线路，请选择“禁止所有线路”",
  );
  owner.assertActive();
  expect(writes).toHaveLength(0);
  owner.assertActive();
  await userEvent.click(screen.getByRole("radio", { name: "禁止所有线路" }));
  owner.assertActive();
  expect(screen.getByText("应用后，该用户将无法使用任何线路。")).toBeTruthy();
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await waitFor(() => expect(writes).toHaveLength(1));
  owner.assertActive();
  expect(writes[0].entitlement.routeIdsOverride).toEqual([]);
  owner.assertActive();
  await userEvent.click(screen.getByRole("radio", { name: "继承线路授权" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await waitFor(() => expect(writes).toHaveLength(2));
  owner.assertActive();
  expect(writes[1].entitlement.routeIdsOverride).toBeNull();
  expect(writes[1].entitlement.cycle).toEqual(before.entitlement.cycle);
});

it("requires a selected personal plan and restores inheritance without sending a stale plan", async () => {
  const owner = currentOwner;
  owner.assertActive();
  const { UserPolicyForm } = await import("./UserPolicyEditor");
  owner.assertActive();
  const writes: any[] = [];
  owner.assertActive();
  const entitlementFixture = entitlementEditFixture(before);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      entitlementFixture.transport(async (_url, init) => {
        writes.push(JSON.parse(init.body));
        return json({ revision: "inherit", affected: [], blockers: [] });
      }),
    ),
  );
  mount(
    owner,
    <UserPolicyForm
      user={{
        id: "u1",
        name: "Alice",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      initial={entitlementFixture.context()}
      services={[service]}
      routes={[]}
      onClose={() => {}}
    />,
  );
  owner.assertActive();
  await userEvent.click(screen.getByRole("radio", { name: "指定个人方案" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await screen.findByText("请选择个人方案，或切换为继承用户组方案");
  owner.assertActive();
  expect(writes).toHaveLength(0);
  owner.assertActive();
  await userEvent.click(screen.getByRole("combobox", { name: "个人指定方案" }));
  owner.assertActive();
  const ownedTarget8 = await screen.findByRole("option", { name: "Standard" });
  owner.assertActive();
  await userEvent.click(ownedTarget8);
  owner.assertActive();
  await userEvent.click(screen.getByRole("radio", { name: "继承用户组方案" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "预览影响" }));
  owner.assertActive();
  await waitFor(() => expect(writes).toHaveLength(1));
  owner.assertActive();
  expect(writes[0].entitlement.serviceId).toBe("");
});

it.each([false, true])("distinguishes colliding affected account labels across impact-review pages before consent (missing=%s)", async (missing) => {
  const owner = currentOwner;
  const { usePolicyChange } = await import("./AccessPolicy");
  const ids = ["account-a", "account-b", "account-c", "account-d", "account-e", "account-f"];
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    writes.push(url);
    return json({ revision: "review-identities", blockers: [], affected: ids.map(userId => ({
      userId, before: { ...before, userId }, after: { ...before, userId, connectionLimit: 8 },
    })) });
  }));
  function Review() {
    const change = usePolicyChange({ mode: "legacy-replacement",
      users: ids.filter(id => !missing || id !== "account-f").map((id, index) => ({ id, name: index === 0 || index === 5 ? (missing ? "account-f" : "同名账号") : index === 1 ? "同名账号（ID：account-a）" : `账号 ${index}` })),
      services: [], routes: [], onApplied: () => {},
    });
    return <><button onClick={() => change.propose({ entitlement: before.entitlement })}>Review identities</button>{change.dialog}</>;
  }
  mount(owner, <Review />);
  await owner.click(() => screen.getByRole("button", { name: "Review identities" }));
  const dialog = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  expect(dialog.getByRole("heading", { name: `${missing ? "account-f" : "同名账号"}，账号标识：account-a` })).toBeTruthy();
  expect(dialog.getByRole("heading", { name: "账号 2" })).toBeTruthy();
  const literal = dialog.getByRole("heading", { name: "同名账号（ID：account-a）" });
  expect(literal.querySelector("code")).toBeNull();
  expect(dialog.getByText("account-a", { selector: "code" })).toBeTruthy();
  await owner.click(() => dialog.getByRole("button", { name: "下一页" }));
  expect(dialog.getByRole("heading", { name: `${missing ? "account-f" : "同名账号"}，账号标识：account-f` })).toBeTruthy();
  expect(dialog.getByRole("button", { name: "更新授权" }).hasAttribute("disabled")).toBe(true);
  expect(writes).toEqual(["/api/access-policy/preview"]);
});

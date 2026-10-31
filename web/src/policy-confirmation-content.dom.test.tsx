// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { UIProviders } from "./ui-patterns/providers";
import { Button } from "@/components/ui/button";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { UserGroups, usePolicyChange } from "./AccessPolicy";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UserPolicyForm } from "./UserPolicyEditor";
import type {
  EffectivePolicy,
  NamedRecord,
  PolicyChange,
} from "./access-policy-model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { groupEditFixture } from "./test-support/group-edit-fixture";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
const group = {
  id: "g1",
  name: "Family",
  serviceId: "plan-a",
  priority: 1,
  memberIds: [],
};
const groupFixture = groupEditFixture(group);
const user = {
  id: "u1",
  name: "Alice",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const before: EffectivePolicy = {
  userId: "u1",
  serviceId: "plan-a",
  service,
  groupIds: [],
  routeIds: [],
  quotaBytes: 107374182400,
  onlineIpLimit: 2,
  connectionLimit: 8,
  entryRateBps: 0,
  status: "active",
  provenance: { service: "individual", quotaBytes: "service:plan-a" },
  entitlement: {
    userId: "u1",
    startsAt: "2026-01-01T00:00:00Z",
    cycle: service.cycle,
  },
};
const after: EffectivePolicy = {
  ...before,
  quotaBytes: 214748364800,
  onlineIpLimit: 3,
  connectionLimit: 9,
  provenance: { ...before.provenance, quotaBytes: "individual" },
};
const entitlementFixture = entitlementEditFixture(before);
const effect = { userId: "u1", before, after };
const consent = "我已核对本次授权变更";
const boundary = "受管入口配置不会自动应用。";
const noReset = "已有用量不会因方案或续期变化而清零。";

beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
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
  vi.unstubAllEnvs();
});
function mount(owner: Owner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const wrap = (value: ReactNode) => (
    <QueryClientProvider client={client}>
      
        <UIProviders>{value}</UIProviders>
      
    </QueryClientProvider>
  );
  const result = render(wrap(children));
  return {
    rerender: (value: ReactNode) => {
      owner.assertActive();
      result.rerender(wrap(value));
    },
  };
}
function Caller({
  change,
  users = [user],
  services = [service],
}: {
  change: PolicyChange;
  users?: NamedRecord[];
  services?: NamedRecord[];
}) {
  const policy = usePolicyChange({
    mode: "legacy-replacement",
    users,
    services,
    routes: [],
    onApplied: () => {},
  });
  return (
    <>
      <Button onClick={() => policy.propose(change)}>预览影响</Button>
      {policy.dialog}
    </>
  );
}
async function openReview(owner: Owner) {
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  return within(review);
}

it.each(["service", "group", "entitlement"] as const)(
  "reviews zero affected users for %s without an empty comparison or skipping consent",
  async (kind) => {
    const owner = currentOwner;
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(entitlementFixture.transport(async (url, init) => {
        if (String(url).endsWith("/user-groups")) return json([group]);
        if (String(url).includes("/access-policy/edit-context/group/")) return json(groupFixture.context());
        if (String(url).includes("/access-policy/edit-context/service/")) return json(serviceFixture.context());
        const body = JSON.parse(init!.body as string);
        requests.push({
          url: String(url),
          body,
        });
        const result = { revision: "zero-review", affected: [], blockers: [] };
        return json(kind === "service" && String(url).endsWith("/preview")
          ? serviceFixture.preview(body.change.service, result) : kind === "group" && String(url).endsWith("/preview") ? groupFixture.preview(body.change.group, result) : result);
      })),
    );
    if (kind === "service")
      mount(
        owner,
        <ServicePolicyEditor
          initial={service}
          users={[user]}
          services={[service]}
          routes={[]}
          onClose={() => {}}
        />,
      );
    else if (kind === "group") {
      mount(
        owner,
        <UserGroups users={[user]} services={[service]} routes={[]} />,
      );
      await owner.click(() =>
        screen.findByRole("button", { name: "编辑 Family" }),
      );
    } else
      mount(
        owner,
        <UserPolicyForm
          user={user}
          initial={entitlementFixture.context()}
          services={[service]}
          routes={[]}
          onClose={() => {}}
        />,
      );
    const review = await openReview(owner);
    owner.assertActive();
    expect(
      review.getByText(
        {
          service: "服务方案：Standard",
          group: "用户组：Family",
          entitlement: "用户：Alice",
        }[kind],
      ),
    ).toBeTruthy();
    expect(review.getByText("现有用户授权不变。")).toBeTruthy();
    // The separate plan-resource review is not an existing-user comparison.
    expect(review.queryByRole("table", { name: "Alice" })).toBeNull();
    if (kind === "group") expect(review.queryByRole("table")).toBeNull();
    if (kind === "entitlement") {
      expect(review.getByRole("heading", { name: "个人授权变更" })).toBeTruthy();
      expect(review.getByText("个人设置保持不变。")).toBeTruthy();
      expect(review.queryByRole("table")).toBeNull();
    }
    expect(review.queryByRole("checkbox", { name: "显示完整授权" })).toBeNull();
    expect(
      review.queryByText("没有现有用户受影响，配置将供后续分配使用。"),
    ).toBeNull();
    expect(review.getByText(boundary)).toBeTruthy();
    expect(review.queryByText(noReset)).toBeNull();
    const rules = review.getByRole("button", { name: "授权规则" });
    expect(rules.getAttribute("aria-expanded")).toBe("false");
    await owner.click(() => rules);
    expect(review.getByText("多个用户组不会叠加额度。")).toBeTruthy();
    expect(review.getByText(noReset)).toBeTruthy();
    const apply = review.getByRole("button", {
      name: "更新授权",
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(
      requests.filter((request) => request.url.endsWith("/apply")),
    ).toEqual([]);
    await owner.click(() => review.getByRole("checkbox", { name: consent }));
    expect(apply.disabled).toBe(false);
    await owner.click(() => review.getByRole("button", { name: "返回编辑" }));
    await openReview(owner);
    owner.assertActive();
    const fresh = within(screen.getByRole("dialog", { name: "确认授权变更" }));
    expect(
      fresh
        .getByRole("button", { name: "授权规则" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      fresh.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
    expect(
      (fresh.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      requests.filter((request) => request.url.endsWith("/apply")),
    ).toEqual([]);
  },
);

it("shows the authoritative affected count and preserves exact comparisons, provenance and full authorization", async (context) => {
  const owner = ownedClickScenario(context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ revision: "rows-review", affected: [effect], blockers: [] }),
    ),
  );
  mount(owner, <Caller change={{ service }} />);
  const review = await openReview(owner);
  owner.assertActive();
  expect(review.getByText("涉及 1 位用户。")).toBeTruthy();
  expect(review.queryByText("现有用户授权不变。")).toBeNull();
  const table = within(review.getByRole("table", { name: "Alice" }));
  expect(review.getByRole("heading", { name: "Alice" })).toBeTruthy();
  for (const value of [
    "100 GiB",
    "200 GiB",
    "2 个",
    "3 个",
    "8 条",
    "9 条",
    "方案：Standard",
    "个人覆盖",
  ])
    expect(table.getAllByText(value).length).toBeGreaterThan(0);
  expect(table.queryByText("每个逻辑入口速率")).toBeNull();
  expect(review.getByText(noReset)).toBeTruthy();
  expect(review.getByText(boundary)).toBeTruthy();
  await owner.click(() =>
    review.getByRole("checkbox", { name: "显示完整授权" }),
  );
  expect(table.getAllByText("每个逻辑入口速率")).toHaveLength(1);
  expect(table.getAllByText("不限制").length).toBeGreaterThan(0);
  expect(review.getAllByText(noReset)).toHaveLength(1);
  await owner.click(() => review.getByRole("button", { name: "授权规则" }));
  expect(review.getByText("多个用户组不会叠加额度。")).toBeTruthy();
  expect(review.getAllByText(noReset)).toHaveLength(1);
});

it.each([false, true])(
  "keeps all blockers and consent gating without a no-impact claim when rows exist=%s",
  async (hasRows) => {
    const owner = currentOwner;
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        writes.push(String(url));
        return json({
          revision: "blocked-review",
          affected: hasRows ? [effect] : [],
          blockers: [
            "Stop and settle active presences first",
            "A second independent blocker",
          ],
        });
      }),
    );
    mount(owner, <Caller change={{ service }} />);
    const review = await openReview(owner);
    owner.assertActive();
    expect(review.getByText("暂时无法更新授权")).toBeTruthy();
    expect(
      review.getByText("Stop and settle active presences first"),
    ).toBeTruthy();
    expect(review.getByText("A second independent blocker")).toBeTruthy();
    expect(review.queryByText("现有用户授权不变。")).toBeNull();
    expect(review.queryByText(/涉及 \d+ 位用户/)).toBeNull();
    expect(!!review.queryByRole("table")).toBe(hasRows);
    expect(!!review.queryByRole("checkbox", { name: "显示完整授权" })).toBe(
      hasRows,
    );
    if (hasRows) {
      expect(review.getByText("200 GiB")).toBeTruthy();
      expect(review.getByText("个人覆盖")).toBeTruthy();
    }
    await owner.click(() => review.getByRole("checkbox", { name: consent }));
    const apply = review.getByRole("button", {
      name: "更新授权",
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    await owner.click(() => apply);
    expect(writes.some((url) => url.endsWith("/apply"))).toBe(false);
    expect(review.getByRole("button", { name: "返回编辑" })).toBeTruthy();
  },
);

it("keeps a nonempty authoritative review neutral when its projected authorization fields are unchanged", async (context) => {
  const owner = ownedClickScenario(context);
  const inherited = {
    ...before,
    groupIds: ["g1"],
    provenance: { ...before.provenance, service: "group" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        revision: "membership-only",
        affected: [
          {
            userId: "u1",
            before: inherited,
            after: { ...inherited, groupIds: ["g1", "g2"] },
          },
        ],
        blockers: [],
      }),
    ),
  );
  mount(
    owner,
    <Caller
      change={{
        group: { ...group, id: "g2", name: "Also family", memberIds: ["u1"] },
      }}
    />,
  );
  const review = await openReview(owner);
  owner.assertActive();
  expect(review.getByText("涉及 1 位用户。")).toBeTruthy();
  expect(review.queryByText(/将影响.*授权/)).toBeNull();
  expect(review.getByRole("heading", { name: "Alice" })).toBeTruthy();
  expect(review.getAllByText("当前生效授权保持不变")).toHaveLength(1);
  await owner.click(() =>
    review.getByRole("checkbox", { name: "显示完整授权" }),
  );
  const table = within(review.getByRole("table", { name: "Alice" }));
  expect(table.getAllByText("100 GiB")).toHaveLength(2);
});

it.each(["service", "group", "entitlement"] as const)(
  "freezes the %s target before a held preview resolves and sends only the reviewed change and revision",
  async (kind) => {
    const owner = currentOwner;
    const change: PolicyChange =
      kind === "service"
        ? { service: structuredClone(service) }
        : kind === "group"
          ? { group: structuredClone(group) }
          : { entitlement: structuredClone(before.entitlement) };
    const expected = structuredClone(change);
    const requests: { url: string; body: unknown }[] = [];
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(init!.body as string),
        });
        if (String(url).endsWith("/preview")) return pending;
        return json(
          { detail: "Policy was not saved; review is retained." },
          503,
        );
      }),
    );
    const mounted = mount(owner, <Caller change={change} />);
    try {
      await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
      await waitFor(() => expect(requests).toHaveLength(1));
      owner.assertActive();
      if (change.service) change.service.name = "Changed outside the review";
      if (change.group) change.group.name = "Changed outside the review";
      if (change.entitlement) change.entitlement.userId = "another-user";
      mounted.rerender(
        <Caller
          change={change}
          users={[{ id: "u1", name: "Renamed Alice" }]}
          services={[{ ...service, name: "Renamed plan" }]}
        />,
      );
      await act(async () => {
        release(
          json({ revision: "frozen-review", affected: [], blockers: [] }),
        );
      });
      owner.assertActive();
      const review = within(
        await screen.findByRole("dialog", { name: "确认授权变更" }),
      );
      owner.assertActive();
      expect(
        review.getByText(
          {
            service: "服务方案：Standard",
            group: "用户组：Family",
            entitlement: "用户：Alice",
          }[kind],
        ),
      ).toBeTruthy();
      mounted.rerender(<Caller change={change} users={[]} services={[]} />);
      expect(
        review.getByText(
          {
            service: "服务方案：Standard",
            group: "用户组：Family",
            entitlement: "用户：Alice",
          }[kind],
        ),
      ).toBeTruthy();
      await owner.click(() => review.getByRole("checkbox", { name: consent }));
      await owner.click(() => review.getByRole("button", { name: "更新授权" }));
      await review.findByText("Policy was not saved; review is retained.");
      owner.assertActive();
      expect(requests.map((request) => request.body)).toEqual([
        expected,
        { change: expected, revision: "frozen-review" },
      ]);
      expect(
        review.getByText(
          {
            service: "服务方案：Standard",
            group: "用户组：Family",
            entitlement: "用户：Alice",
          }[kind],
        ),
      ).toBeTruthy();
    } finally {
      await act(async () => {
        release(
          json({ revision: "frozen-review", affected: [], blockers: [] }),
        );
      });
    }
  },
);

it.each(["service", "group"] as const)(
  "keeps the submitted %s identity neutral when catalogs are empty",
  async (kind) => {
    const owner = currentOwner;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ revision: "uncatalogued-review", affected: [], blockers: [] }),
      ),
    );
    mount(
      owner,
      <Caller
        change={kind === "service" ? { service } : { group }}
        users={[]}
        services={[]}
      />,
    );
    const review = await openReview(owner);
    owner.assertActive();
    expect(
      review.getByText(
        kind === "service" ? "服务方案：Standard" : "用户组：Family",
      ),
    ).toBeTruthy();
    expect(review.queryByText(/新建|创建/)).toBeNull();
  },
);

it("uses the frozen entitlement ID when no user label is available and never infers creation from missing catalogs", async (context) => {
  const owner = ownedClickScenario(context);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({ revision: "fallback-review", affected: [], blockers: [] }),
    ),
  );
  const mounted = mount(
    owner,
    <Caller
      change={{ entitlement: before.entitlement }}
      users={[]}
      services={[]}
    />,
  );
  const review = await openReview(owner);
  owner.assertActive();
  expect(review.getByText("用户：u1")).toBeTruthy();
  mounted.rerender(
    <Caller
      change={{ entitlement: before.entitlement }}
      users={[user]}
      services={[service]}
    />,
  );
  expect(review.getByText("用户：u1")).toBeTruthy();
  expect(review.queryByText(/新建|创建/)).toBeNull();
});

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
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { ServicePolicyComparison } from "./ServicePolicyComparison";
import { usePolicyChange } from "./AccessPolicy";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { Service } from "./types";

type Owner = ReturnType<typeof ownedClickScenario>;
let owner: Owner;
const clients: QueryClient[] = [];
const plan: Service = {
  id: "plan",
  name: "Standard",
  quotaBytes: 50 * 1024 ** 3,
  routeIds: [],
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  cycle: {
    mode: "monthly",
    day: 1,
    days: 7,
    anchor: "2026-01-01T00:00:00+08:00",
    timezone: "Asia/Shanghai",
  },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const context = (value: Service, revision = "opened-1") => ({
  target: { kind: "service", id: value.id },
  record: { service: value },
  precondition: { exists: true, revision },
});
const reviewed = (before: Service | null, after: Service) => ({
  revision: "preview-1",
  affected: [],
  blockers: [],
  guard: "opened-record",
  resource: {
    target: { kind: "service", id: after.id },
    before: before ? { service: before } : null,
    after: { service: after },
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
function mount(initial: Service | null = plan, onClose = () => {}) {
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
  const editor = (value: Service | null) => (
    <ServicePolicyEditor
      initial={value}
      users={[]}
      services={value ? [value] : []}
      routes={[]}
      onClose={onClose}
    />
  );
  const view = render(wrap(editor(initial)));
  return {
    rerender(value: Service) {
      view.rerender(wrap(editor(value)));
    },
  };
}
async function quota(value: string) {
  const input = await screen.findByLabelText("周期额度（GiB，0 为不限额）");
  owner.assertActive();
  fireEvent.change(input, { target: { value } });
}
async function preview() {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
}

it("preserves a stale quota draft and requires explicit latest-version acceptance before using its new baseline", async () => {
  const latest = { ...plan, cycle: { ...plan.cycle, day: 15 } };
  const previews: any[] = [];
  const close = vi.fn();
  let applies = 0;
  let saved = plan;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/"))
        return json(context(saved, saved === plan ? "opened-1" : "opened-2"));
      const body = JSON.parse(init!.body as string);
      if (String(url).endsWith("/preview")) {
        previews.push(body);
        if (body.precondition.revision === "opened-1")
          return json(
            {
              code: "POLICY_EDIT_BASELINE_CHANGED",
              detail: "服务方案已更新。当前草稿尚未保存，请查看最新版本。",
            },
            409,
          );
        return json(reviewed(latest, body.change.service));
      }
      applies++;
      return applies === 1
        ? json({ detail: "保存失败，请重试" }, 500)
        : json({});
    }),
  );
  mount(plan, close);
  await quota("100");
  saved = latest;
  await preview();
  await screen.findByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。");
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("100");
  expect(screen.queryByText("草稿尚未保存，请核对最新版本。")).toBeNull();
  expect(
    screen.queryByText("草稿尚未保存。查看最新版本后，可决定是否重新编辑。"),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "查看最新版本" })).toBeTruthy();
  await quota("120");
  expect(
    screen.queryByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。"),
  ).toBeNull();
  expect(screen.getByText("草稿尚未保存，请核对最新版本。")).toBeTruthy();
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("120");
  await quota("100");
  await preview();
  await waitFor(() => expect(previews).toHaveLength(2));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "查看最新版本",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(previews.map((value) => value.precondition.revision)).toEqual([
    "opened-1",
    "opened-1",
  ]);
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await screen.findByRole("button", { name: "使用最新版本重新编辑" });
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("100");
  await owner.click(() =>
    screen.getByRole("button", { name: "使用最新版本重新编辑" }),
  );
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
        .value,
    ).toBe("50"),
  );
  expect(screen.getByText("上一版草稿（未保存）")).toBeTruthy();
  await quota("100");
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.getByRole("heading", { name: "方案变更" })).toBeTruthy();
  expect(previews[2].precondition.revision).toBe("opened-2");
  expect(previews[2].change.service.cycle).toEqual(latest.cycle);
  const consent =
    "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃保留的未保存草稿副本";
  expect(
    (review.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
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
  const secondReview = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(
    secondReview.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      secondReview.getByRole("button", {
        name: "更新授权",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await owner.click(() =>
    secondReview.getByRole("checkbox", { name: consent }),
  );
  await owner.click(() =>
    secondReview.getByRole("button", { name: "更新授权" }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});

it("reviews the authoritative plan default even when no existing account is affected", async () => {
  const saved = { ...plan, cycle: { ...plan.cycle, day: 15 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).includes("/edit-context/")
        ? json(context(saved))
        : json(
            reviewed(saved, JSON.parse(init!.body as string).change.service),
          ),
    ),
  );
  mount(plan);
  const day = await screen.findByLabelText("每月几号");
  expect((day as HTMLInputElement).value).toBe("15");
  owner.assertActive();
  fireEvent.change(day, { target: { value: "1" } });
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  const table = within(review.getByRole("table", { name: "方案变更" }));
  expect(table.getByText("15 日")).toBeTruthy();
  expect(table.getByText("1 日")).toBeTruthy();
  expect(review.getByText("现有用户授权不变。")).toBeTruthy();
  expect(
    (review.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("refuses an unguarded preview response without discarding the draft or retrying legacy mode", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/")) return json(context(plan));
      writes.push(JSON.parse(init!.body as string));
      return json({ revision: "legacy", affected: [], blockers: [] });
    }),
  );
  mount();
  await quota("100");
  await preview();
  await screen.findByText(
    "服务未返回完整的方案变更核对结果。当前草稿已保留，请重试。",
  );
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("100");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    precondition: { exists: true, revision: "opened-1" },
    change: { service: { quotaBytes: 107374182400, cycle: plan.cycle } },
  });
});

it.each(["target", "before", "after", "candidate", "presence"] as const)(
  "rejects a guarded response with the wrong %s instead of offering consent",
  async (fault) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/edit-context/")) return json(context(plan));
        const submitted = JSON.parse(init!.body as string).change.service;
        const result = reviewed(plan, submitted);
        if (fault === "target") result.resource.target.id = "other";
        if (fault === "before")
          result.resource.before!.service = { ...plan, id: "other" };
        if (fault === "after") result.resource.after.service.id = "other";
        if (fault === "candidate") result.resource.after.service.cycle.day = 15;
        if (fault === "presence") result.resource.before = null;
        return json(result);
      }),
    );
    mount();
    await quota("100");
    await preview();
    await screen.findByText(
      "服务未返回完整的方案变更核对结果。当前草稿已保留，请重试。",
    );
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  },
);

it("ignores an old opening read after a different plan becomes the active edit target", async (test) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  test.onTestFinished(release);
  const second = {
    ...plan,
    id: "other",
    name: "Other",
    quotaBytes: 70 * 1024 ** 3,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/plan")
        ? held.then(() => json(context(plan)))
        : json(context(second, "other-open")),
    ),
  );
  const view = mount();
  expect(screen.queryByLabelText("服务方案名称")).toBeNull();
  view.rerender(second);
  const name = await screen.findByLabelText("服务方案名称");
  expect((name as HTMLInputElement).value).toBe("Other");
  await act(async () => release());
  expect(
    (screen.getByLabelText("服务方案名称") as HTMLInputElement).value,
  ).toBe("Other");
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("70");
});

it("does not install a latest-version read after the operator makes a newer draft edit", async (test) => {
  let release!: () => void,
    latestRead = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  test.onTestFinished(release);
  const latest = { ...plan, cycle: { ...plan.cycle, day: 15 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/edit-context/"))
        return latestRead
          ? held.then(() => json(context(latest, "later")))
          : json(context(plan));
      return json(
        { code: "POLICY_EDIT_BASELINE_CHANGED", detail: "方案已改变" },
        409,
      );
    }),
  );
  mount();
  await quota("100");
  await preview();
  await screen.findByText("方案已改变");
  latestRead = true;
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await quota("120");
  await act(async () => release());
  expect(
    (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
      .value,
  ).toBe("120");
  expect(
    screen.queryByRole("button", { name: "使用最新版本重新编辑" }),
  ).toBeNull();
});

it("requires explicit absence for creation and sends that same baseline with the new draft", async () => {
  let createdID = "";
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/")) {
        createdID = String(url).split("/").at(-1)!;
        return json({
          target: { kind: "service", id: createdID },
          record: null,
          precondition: { exists: false, revision: "absent-1" },
        });
      }
      const body = JSON.parse(init!.body as string);
      writes.push(body);
      return json(reviewed(null, body.change.service));
    }),
  );
  mount(null);
  const name = await screen.findByLabelText("服务方案名称");
  owner.assertActive();
  fireEvent.change(name, { target: { value: "New plan" } });
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  expect(review.getByText("新建方案")).toBeTruthy();
  expect(writes[0].precondition).toEqual({
    exists: false,
    revision: "absent-1",
  });
  expect(writes[0].change.service.id).toBe(createdID);
});

it.each(["create-collision", "deleted-update"] as const)(
  "does not silently change editor intent for %s",
  async (scenario) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const id = String(url).split("/").at(-1)!;
        return json(
          scenario === "create-collision"
            ? context({ ...plan, id })
            : {
                target: { kind: "service", id },
                record: null,
                precondition: { exists: false, revision: "absent" },
              },
        );
      }),
    );
    mount(scenario === "create-collision" ? null : plan);
    await screen.findByText(
      scenario === "create-collision"
        ? "此方案标识已存在，请使用新标识重新新建。"
        : "此方案已不存在，不能将旧编辑内容当作新方案保存。",
    );
    expect(screen.queryByLabelText("服务方案名称")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览影响" })).toBeNull();
  },
);

it.each([true, false])(
  "compares the full stored anchor precision while accepting an equivalent offset spelling: changed=%s",
  async (changed) => {
    const exact = {
      ...plan,
      cycle: { ...plan.cycle, anchor: "2026-01-01T00:00:00.123456789+08:00" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/edit-context/")) return json(context(exact));
        const submitted = JSON.parse(init!.body as string).change.service;
        const after = {
          ...submitted,
          cycle: {
            ...submitted.cycle,
            anchor: changed
              ? "2025-12-31T16:00:00.123456788Z"
              : "2025-12-31T16:00:00.123456789Z",
          },
        };
        return json(reviewed(exact, after));
      }),
    );
    mount(exact);
    await quota("100");
    await preview();
    if (changed) {
      await screen.findByText(
        "服务未返回完整的方案变更核对结果。当前草稿已保留，请重试。",
      );
      expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
    } else
      expect(
        await screen.findByRole("dialog", { name: "确认授权变更" }),
      ).toBeTruthy();
  },
);

it("does not mount a writable form when a stored cycle contains a field this client cannot preserve", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        context({
          ...plan,
          cycle: { ...plan.cycle, futureRule: "retain-me" },
        } as Service),
      ),
    ),
  );
  mount();
  await screen.findByText(
    "服务未返回完整的方案编辑数据。请重试；尚未打开可编辑草稿。",
  );
  expect(screen.queryByLabelText("服务方案名称")).toBeNull();
});

it("pairs stable route identities without relying on later catalog names", () => {
  render(
    <ServicePolicyComparison
      resource={{
        target: { kind: "service", id: plan.id },
        before: { service: { ...plan, routeIds: ["same-name-route-a"] } },
        after: { service: { ...plan, routeIds: ["same-name-route-b"] } },
      }}
    />,
  );
  const table = within(screen.getByRole("table", { name: "方案变更" }));
  expect(table.getByRole("cell", { name: "same-name-route-a" })).toBeTruthy();
  expect(table.getByRole("cell", { name: "same-name-route-b" })).toBeTruthy();
});

it.each(["onlineIpLimit", "anchor"] as const)(
  "does not open a partial server context missing %s",
  async (field) => {
    const partial = structuredClone(plan);
    if (field === "anchor") delete partial.cycle.anchor;
    else delete partial.onlineIpLimit;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(context(partial))),
    );
    mount();
    await screen.findByText(
      "服务未返回完整的方案编辑数据。请重试；尚未打开可编辑草稿。",
    );
    expect(screen.queryByLabelText("服务方案名称")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览影响" })).toBeNull();
  },
);

it.each(["before-limit", "after-timezone"] as const)(
  "refuses a partial authoritative resource snapshot: %s",
  async (fault) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).includes("/edit-context/")) return json(context(plan));
        const response = reviewed(
          structuredClone(plan),
          JSON.parse(init!.body as string).change.service,
        );
        if (fault === "before-limit")
          delete response.resource.before!.service.connectionLimit;
        else delete response.resource.after.service.cycle.timezone;
        return json(response);
      }),
    );
    mount();
    await quota("100");
    await preview();
    await screen.findByText(
      "服务未返回完整的方案变更核对结果。当前草稿已保留，请重试。",
    );
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  },
);

it("retains each draft against its own opening snapshot and labels an incomplete quota without treating it as unlimited", async () => {
  let saved = plan,
    revision = "opened-1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).includes("/edit-context/")
        ? json(context(saved, revision))
        : json(
            { code: "POLICY_EDIT_BASELINE_CHANGED", detail: "方案已改变" },
            409,
          ),
    ),
  );
  mount();
  await quota("100");
  saved = {
    ...plan,
    quotaBytes: 60 * 1024 ** 3,
    cycle: { ...plan.cycle, day: 15 },
  };
  revision = "opened-2";
  await preview();
  await screen.findByText("方案已改变");
  const adoptLatest = async () => {
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
  await adoptLatest();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
        .value,
    ).toBe("60"),
  );
  await quota("120");
  saved = {
    ...plan,
    quotaBytes: 70 * 1024 ** 3,
    cycle: { ...plan.cycle, day: 20 },
  };
  revision = "opened-3";
  await preview();
  await screen.findByText("方案已改变");
  await quota(""); // Replacing this incomplete draft must not require repairing it.
  await adoptLatest();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("周期额度（GiB，0 为不限额）") as HTMLInputElement)
        .value,
    ).toBe("70"),
  );
  await owner.click(() => screen.getByText("较早草稿 1（未保存）"));
  await owner.click(() => screen.getByText("上一版草稿（未保存）"));
  const tables = screen.getAllByRole("table", { name: "保留的草稿" });
  const firstQuota = within(
    within(tables[0]).getByRole("row", { name: /周期额度/ }),
  ).getAllByRole("cell");
  expect(firstQuota[0].textContent).toContain("50");
  expect(firstQuota[1].textContent).toBe("100 GiB（107374182400 字节）");
  const firstDay = within(
    within(tables[0]).getByRole("row", { name: /^每月重置日 / }),
  ).getAllByRole("cell");
  expect(firstDay.map((cell) => cell.textContent)).toEqual(["1 日", "1 日"]);
  const lastQuota = within(
    within(tables[1]).getByRole("row", { name: /周期额度/ }),
  ).getAllByRole("cell");
  expect(lastQuota[0].textContent).toContain("60");
  expect(lastQuota[1].textContent).toBe("尚未填写");
  expect(
    within(tables[1]).getByRole("columnheader", { name: "当时打开的版本" }),
  ).toBeTruthy();
});

it("keeps a still-absent creation baseline after an unrelated apply conflict instead of claiming the plan was deleted", async () => {
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/")) {
        const id = String(url).split("/").at(-1)!;
        return json({
          target: { kind: "service", id },
          record: null,
          precondition: { exists: false, revision: "absent-1" },
        });
      }
      const body = JSON.parse(init!.body as string);
      if (String(url).endsWith("/preview")) {
        writes.push(body);
        return json(reviewed(null, body.change.service));
      }
      return json({ detail: "授权已变化，请重新预览" }, 409);
    }),
  );
  mount(null);
  const name = await screen.findByLabelText("服务方案名称");
  owner.change(() => name, { target: { value: "New plan" } });
  await preview();
  const review = within(
    await screen.findByRole("dialog", { name: "确认授权变更" }),
  );
  await owner.click(() =>
    review.getByRole("checkbox", { name: "我已核对本次授权变更" }),
  );
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  await screen.findByText("授权已变化，请重新预览");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
  );
  expect(screen.getByText("草稿尚未保存，请核对最新版本。")).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await screen.findByText("方案仍未创建，可用当前草稿重新预览。");
  expect(
    screen.queryByText("方案已不存在，当前草稿不会自动新建同名方案。"),
  ).toBeNull();
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes.map((write) => write.precondition)).toEqual([
    { exists: false, revision: "absent-1" },
    { exists: false, revision: "absent-1" },
  ]);
});

it("invalidates disposal consent when the retained-copy identity changes even if its count stays the same", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      json(reviewed(plan, JSON.parse(init!.body as string).change.service)),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  clients.push(client);
  function Harness({ copies }: { copies: readonly object[] }) {
    const policy = usePolicyChange({
      mode: "guarded-service",
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
            policy.propose(
              { service: plan },
              { exists: true, revision: "opened-1" },
            )
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
  const view = render(wrap([{ label: "first copy" }]));
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
  view.rerender(wrap([{ label: "different copy" }]));
  expect(
    review.getByRole("checkbox", { name: consent }).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (review.getByRole("button", { name: "更新授权" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("preserves a stored null route list rather than replacing it with an empty list on a quota-only edit", async () => {
  // The existing broad UI type predates the complete typed wire snapshot.
  const nilRoutes = { ...plan, routeIds: null } as unknown as Service;
  const submitted: Service[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).includes("/edit-context/"))
        return json(context(nilRoutes));
      const service = JSON.parse(init!.body as string).change.service;
      submitted.push(service);
      return json(reviewed(nilRoutes, service));
    }),
  );
  mount();
  await quota("100");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(submitted).toHaveLength(1);
  expect(submitted[0].routeIds).toBeNull();
  expect(submitted[0].cycle).toEqual(nilRoutes.cycle);
  expect(submitted[0].quotaBytes).toBe(100 * 1024 ** 3);
});

it("retains service-plan fields and exact Close focus after two canceled discard decisions", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    requests.push(`${init?.method || "GET"} ${url}`);
    if (String(url).includes("/edit-context/")) return json(context(plan));
    throw new Error(`Unexpected write ${url}`);
  }));
  const onClose = vi.fn();
  mount(plan, onClose);
  const field = await screen.findByLabelText("服务方案名称") as HTMLInputElement;
  owner.change(() => field, { target: { value: "Retained service plan" } });
  const dialog = screen.getByRole("dialog", { name: "编辑 Standard" });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await owner.click(() => close);
    const review = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
    const keep = within(review).getByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await owner.click(() => keep);
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(field.value).toBe("Retained service plan");
    expect(onClose).not.toHaveBeenCalled();
  }
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

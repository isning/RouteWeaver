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
import { StrictMode } from "react";
import { UserPolicyEditor } from "./UserPolicyEditor";
import type {
  EffectivePolicy,
  EntitlementPolicyEditContext,
} from "./access-policy-model";
import type { Entitlement } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const user = {
  id: "u1",
  name: "Alice",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const original: Entitlement = {
  userId: "u1",
  startsAt: "2026-02-03T04:05:06.123456789+05:30",
  paused: false,
  cycle: {
    mode: "monthly",
    day: 1,
    days: 23,
    anchor: "2026-02-03T04:05:06.123456789+05:30",
    timezone: "Asia/Shanghai",
  },
  quotaOverride: 50 * 1024 ** 3,
  onlineIpLimitOverride: 17,
  connectionLimitOverride: 3,
  entryRateBpsOverride: 125000,
};
const effective = (ent: Entitlement): EffectivePolicy => ({
  userId: "u1",
  groupIds: [],
  routeIds: [],
  quotaBytes: ent.quotaOverride ?? 0,
  onlineIpLimit: ent.onlineIpLimitOverride ?? 0,
  connectionLimit: ent.connectionLimitOverride ?? 0,
  entryRateBps: ent.entryRateBpsOverride ?? 0,
  status: "active",
  provenance: {},
  entitlement: ent,
});
const context = (
  record: Entitlement | null,
  revision = "opened-1",
  seed = original,
): EntitlementPolicyEditContext => ({
  target: { kind: "entitlement", id: "u1" },
  record: record ? { entitlement: record } : null,
  precondition: { exists: !!record, revision },
  effective: effective(record ?? seed),
});
const reviewed = (before: Entitlement | null, after: Entitlement) => ({
  guard: "opened-record",
  revision: "preview-1",
  affected: [
    {
      userId: "u1",
      before: effective(before ?? original),
      after: effective(after),
    },
  ],
  blockers: [],
  resource: {
    target: { kind: "entitlement", id: "u1" },
    before: before ? { entitlement: before } : null,
    after: { entitlement: after },
  },
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach((test) => {
  owner = ownedClickScenario(test);
  // rc-util otherwise assigns every Drawer/Modal the same test-only aria ID.
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(close = () => {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <UIProviders>
          <UserPolicyEditor
            user={user}
            services={[]}
            routes={[]}
            onClose={close}
          />
        </UIProviders>
      </QueryClientProvider>
    </StrictMode>,
  );
}
const change = (label: string, value: string) =>
  owner.change(() => screen.getByLabelText(label), { target: { value } });
async function preview() {
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
}
async function openLimits() {
  await screen.findByLabelText("开通时间");
  owner.assertActive();
  await owner.click(() =>
    screen.getByRole("button", { name: "个人额度与限制" }),
  );
  await screen.findByLabelText("个人周期额度（GiB）");
  owner.assertActive();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Fixture = {
  saved: Entitlement; revision: string; conflict: boolean;
  nextRead?: Promise<Response>; nextPreview?: Promise<Response>;
};
const fixture = (): Fixture => ({ saved: original, revision: "opened-1", conflict: false });
function capturePreview(state = fixture()) {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const method = init?.method || "GET";
    if (method === "GET" && String(url) === "/api/users/u1/admission-status")
      return json({ asOf: original.startsAt, maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] });
    if (method === "GET" && String(url) === "/api/access-policy/edit-context/entitlement/u1") {
      const held = state.nextRead;
      state.nextRead = undefined;
      return held ?? json(context(state.saved, state.revision));
    }
    if (method === "POST" && String(url) === "/api/access-policy/preview") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      const held = state.nextPreview;
      state.nextPreview = undefined;
      return held ?? (state.conflict ? json({ code: "POLICY_EDIT_BASELINE_CHANGED", detail: "个人授权已改变" }, 409)
        : json(reviewed(state.saved, body.change.entitlement)));
    }
    throw new Error("Unexpected personal-override fixture request");
  }));
  return writes;
}

const overrideCases = [
  ["个人周期额度（GiB）", "quotaOverride"],
  ["个人在线 IP 数上限", "onlineIpLimitOverride"],
  ["个人并发逻辑流数上限", "connectionLimitOverride"],
  ["个人入口限速（Mbps）", "entryRateBpsOverride"],
] as const;

it.each(overrideCases)("does not turn an enabled but cleared %s into inheritance after accordion collapse", async (label, key) => {
  const writes = capturePreview();
  mount();
  await openLimits();
  expect(screen.getByRole("checkbox", { name: `覆盖${label}` }).getAttribute("aria-checked")).toBe("true");
  change(label, "");
  await preview();
  expect(writes).toEqual([]);
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await preview();
  expect(writes).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  const control = screen.getByLabelText(label) as HTMLInputElement;
  expect(control.value).toBe("");
  expect(screen.getByRole("checkbox", { name: `覆盖${label}` }).getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(control));
  change(label, "3");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  expect(writes[0].change.entitlement[key]).toBe(key === "quotaOverride" ? 3 * 1024 ** 3 : key === "entryRateBpsOverride" ? 375000 : 3);
});

it.each([
  ["个人周期额度（GiB）", "-"],
  ["个人在线 IP 数上限", "-"],
  ["个人并发逻辑流数上限", "1e"],
  ["个人入口限速（Mbps）", "1e"],
] as const)("already blocks nonempty incomplete %s even when hidden and native submission is bypassed", async (label, raw) => {
  const writes = capturePreview(), close = vi.fn();
  mount(close);
  await openLimits();
  change(label, raw);
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await preview();
  const form = screen.getByLabelText("开通时间").closest("form")!;
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toEqual([]);
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(close).not.toHaveBeenCalled();
});

it.each([
  ["个人周期额度（GiB）", "-"],
  ["个人在线 IP 数上限", "-"],
  ["个人并发逻辑流数上限", "1e"],
  ["个人入口限速（Mbps）", "1e"],
] as const)("restores the pending raw %s spelling when its accordion is reopened", async (label, raw) => {
  const writes = capturePreview();
  mount();
  await openLimits();
  change(label, raw);
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await preview();
  expect(writes).toEqual([]);
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
});


it.each(overrideCases)("keeps explicit inheritance separate from a blank enabled %s", async (label, key) => {
  const writes = capturePreview();
  mount();
  await openLimits();
  change(label, "");
  await owner.click(() => screen.getByRole("checkbox", { name: `覆盖${label}` }));
  expect(screen.getByRole("checkbox", { name: `覆盖${label}` }).getAttribute("aria-checked")).toBe("false");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  expect(writes[0].change.entitlement[key]).toBeNull();
});

it.each(overrideCases)("keeps explicit unlimited zero separate from a blank enabled %s", async (label, key) => {
  const writes = capturePreview();
  mount();
  await openLimits();
  change(label, "");
  change(label, "0");
  expect(screen.getByRole("checkbox", { name: `覆盖${label}` }).getAttribute("aria-checked")).toBe("true");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  expect(writes[0].change.entitlement[key]).toBe(0);
});

it.each(overrideCases)("reveals and validates hidden blank %s on direct form submission", async (label) => {
  const writes = capturePreview();
  mount();
  await openLimits();
  change(label, "");
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  const form = screen.getByLabelText("开通时间").closest("form")!;
  await act(async () => { fireEvent.submit(form); });
  expect(writes).toEqual([]);
  const control = screen.getByLabelText(label) as HTMLInputElement;
  expect(control.value).toBe("");
  await waitFor(() => expect(document.activeElement).toBe(control));
});

it.each(overrideCases)("preserves blank enabled %s after Cancel and Continue", async (label) => {
  const writes = capturePreview(), close = vi.fn();
  mount(close);
  await openLimits();
  change(label, "");
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(close).not.toHaveBeenCalled();
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("checkbox", { name: `覆盖${label}` }).getAttribute("aria-checked")).toBe("true");
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await preview();
  expect(writes).toEqual([]);
});

it.each(overrideCases)("retains blank enabled %s separately when explicitly adopting the latest settings", async (label, key) => {
  const state = fixture(), writes = capturePreview(state);
  mount();
  await openLimits();
  state.conflict = true;
  await preview();
  await screen.findByText("个人授权已改变");
  change(label, "");
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  state.saved = { ...original, quotaOverride: 2 * 1024 ** 3, onlineIpLimitOverride: 23, connectionLimitOverride: 5, entryRateBpsOverride: 250000 };
  state.revision = "opened-2";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() => screen.findByRole("button", { name: "使用最新版本重新编辑" }));
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  await owner.click(() => screen.findByRole("button", { name: "保留的草稿 1（未保存）" }));
  const copy = within(screen.getByRole("region", { name: "保留的个人授权草稿" }));
  expect(copy.getByText(`覆盖${label}`).nextElementSibling?.textContent).toBe("true");
  const copyLabel = key === "quotaOverride" ? "个人周期额度（字节），含未启用值"
    : key === "entryRateBpsOverride" ? "个人入口限速（字节/秒），含未启用值" : `${label}（表单保存值）`;
  expect(copy.getByText(copyLabel).nextElementSibling?.textContent).toBe("null");
  await owner.click(() => screen.getByRole("button", { name: "个人额度与限制" }));
  const divisor = key === "quotaOverride" ? 1024 ** 3 : key === "entryRateBpsOverride" ? 125000 : 1;
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(String(state.saved[key]! / divisor));
  state.conflict = false;
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(2);
  expect(writes[1].change.entitlement[key]).toBe(state.saved[key]);
  expect(writes[1].precondition.revision).toBe("opened-2");
});

it.each(overrideCases)("invalidates a held latest read when %s is cleared", async (label) => {
  const state = fixture(), writes = capturePreview(state);
  mount();
  await openLimits();
  state.conflict = true;
  await preview();
  await screen.findByText("个人授权已改变");
  const held = deferred<Response>();
  state.nextRead = held.promise;
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  change(label, "");
  await act(async () => { held.resolve(json(context({ ...original, onlineIpLimitOverride: 23 }, "late"))); });
  expect(screen.queryByRole("button", { name: "使用最新版本重新编辑" })).toBeNull();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
  expect(writes).toHaveLength(1);
});

it.each(overrideCases)("rejects a held preview after %s is cleared", async (label) => {
  const state = fixture(), writes = capturePreview(state);
  mount();
  await openLimits();
  const held = deferred<Response>();
  state.nextPreview = held.promise;
  await preview();
  await waitFor(() => expect(writes).toHaveLength(1));
  change(label, "");
  await act(async () => { held.resolve(json(reviewed(original, writes[0].change.entitlement))); });
  await waitFor(() => expect(screen.getByRole("button", { name: "预览影响" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
});

it("starts a fresh editor from saved overrides after explicitly discarding blanks", async () => {
  const writes = capturePreview(), close = vi.fn();
  const first = mount(close);
  await openLimits();
  for (const [label] of overrideCases) change(label, "");
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  first.unmount();
  mount();
  await openLimits();
  for (const [label] of overrideCases)
    expect((screen.getByLabelText(label) as HTMLInputElement).value).not.toBe("");
  await preview();
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(writes).toHaveLength(1);
  for (const [, key] of overrideCases) expect(writes[0].change.entitlement[key]).toBe(original[key]);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { TaskDialog } from "./ui-patterns/task-overlays";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { UserPolicyForm } from "./UserPolicyEditor";
import { usePolicyChange } from "./AccessPolicy";
import App from "./App";
import { hasUnsavedChanges } from "./navigation";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { Entitlement, UserRecord } from "./types";
import type { EffectivePolicy, EntitlementPolicyEditContext } from "./access-policy-model";

const alice: UserRecord = { id: "u1", name: "Alice", enabled: true, quotaBytes: 0, usedBytes: 0 };
const bob: UserRecord = { ...alice, id: "u2", name: "Bob" };
const original: Entitlement = {
  userId: "u1", serviceId: "", startsAt: "2026-02-03T04:05:06Z", paused: false,
  cycle: { mode: "monthly", day: 1, anchor: "2026-02-03T04:05:06Z", timezone: "UTC+8" },
  quotaOverride: null, onlineIpLimitOverride: null, connectionLimitOverride: null,
  entryRateBpsOverride: null, routeIdsOverride: null,
};
const effective = (entitlement: Entitlement): EffectivePolicy => ({
  userId: entitlement.userId, groupIds: [], routeIds: [], quotaBytes: 0,
  onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
  status: "active", provenance: {}, entitlement,
});
const context = (entitlement = original, revision = "opened-1"): EntitlementPolicyEditContext => ({
  target: { kind: "entitlement", id: entitlement.userId }, record: { entitlement },
  precondition: { exists: true, revision }, effective: effective(entitlement),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
let owner: ReturnType<typeof ownedClickScenario>;
beforeEach(test => {
  owner = ownedClickScenario(test);
  history.replaceState(null, "", "#services");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "#services");
});
function network() {
  const writes: { path: string; body: any }[] = [];
  const resets: ((response: Response) => void)[] = [];
  let latest = original, previewConflict = false, overviewReads = 0;
  let applyReply = () => json({});
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url), method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      writes.push({ path, body });
      if (/\/users\/u[12]\/reset$/.test(path))
        return new Promise<Response>(resolve => resets.push(resolve));
      if (path === "/api/access-policy/preview") {
        if (previewConflict) return json({ code: "POLICY_EDIT_BASELINE_CHANGED", detail: "个人授权已更新。当前草稿尚未保存，请查看最新版本。" }, 409);
        return json({ guard: "opened-record", revision: "preview-1", affected: [], blockers: [],
          resource: { target: { kind: "entitlement", id: "u1" }, before: { entitlement: latest }, after: body.change } });
      }
      if (path === "/api/access-policy/apply") return applyReply();
      throw new Error(`Unexpected synthetic write: ${method} ${path}`);
    }
    if (path === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "synthetic" });
    if (path === "/api/state") return json({ users: [alice], nodes: [], routes: [], capabilities: [], revisions: [] });
    if (path === "/api/settings") return json({ name: "RouteWeaver", timezone: "UTC+8", registration: "invite" });
    if (path.includes("/edit-context/")) return json(context(latest, latest === original ? "opened-1" : "opened-2"));
    if (path.endsWith("/admission-status")) return json({ asOf: original.startsAt, maxLeaseSeconds: 30, onlineIps: [], activeStreams: 0, entries: [] });
    if (path === "/fixture/overview") return json(++overviewReads);
    return json([]);
  }));
  return { writes, resets,
    newer: () => { latest = { ...original, cycle: { ...original.cycle, day: 15 } }; previewConflict = true; },
    allowPreview: () => { previewConflict = false; },
    failApply: (status: number, detail: string) => { applyReply = () => json({ detail }, status); },
  };
}
function FormHost({ user = alice }: { user?: UserRecord }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open authorization</button>{open && <UserPolicyForm
    key={user.id} user={user} initial={context({ ...original, userId: user.id })}
    services={[]} routes={[]} drawer onClose={() => setOpen(false)}
  />}</>;
}
function mount(content: ReactNode = <FormHost />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(content, { wrapper: ({ children }) => <StrictMode><QueryClientProvider client={client}><UIProviders>{children}</UIProviders></QueryClientProvider></StrictMode> });
}
async function open(name = "Alice") {
  await owner.click(() => screen.getByRole("button", { name: "Open authorization" }));
  const sheet = await screen.findByRole("dialog", { name: `${name} 的服务授权` });
  owner.assertActive();
  return sheet;
}
function reason(sheet: HTMLElement) {
  return within(sheet).getByLabelText("重置原因", { exact: true }) as HTMLTextAreaElement;
}
function edit(sheet: HTMLElement, value: string) {
  owner.change(() => reason(sheet), { target: { value } });
}
async function reviewReset(sheet: HTMLElement, name = "Alice") {
  await owner.click(() => within(sheet).getByRole("button", { name: "重置本周期用量" }));
  const decision = await screen.findByRole("alertdialog", { name: `重置「${name}」的本周期用量？` });
  owner.assertActive();
  return decision;
}

it.each(["Close", "Cancel", "Escape"])("retains a reason-only draft on canceled %s, then discards only explicitly", async dismissal => {
  const net = network();
  mount();
  let sheet = await open();
  const text = "  Audit reason\nExact spacing  ";
  edit(sheet, text);
  expect(reason(sheet).closest("form")).toBeNull();
  expect(hasUnsavedChanges()).toBe(true);
  const dismiss = async () => {
    if (dismissal === "Escape") { await userEvent.keyboard("{Escape}"); owner.assertActive(); }
    else await owner.click(() => within(sheet).getByRole("button", { name: dismissal === "Close" ? "关闭" : "取消" }));
  };
  await dismiss();
  let discard = await screen.findByRole("alertdialog", { name: "放弃重置原因？" });
  owner.assertActive();
  expect(within(discard).getByText("重置原因尚未提交。放弃后将无法恢复。")).toBeTruthy();
  await owner.click(() => within(discard).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe(text);
  await dismiss();
  discard = await screen.findByRole("alertdialog", { name: "放弃重置原因？" });
  owner.assertActive();
  await owner.click(() => within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  expect(hasUnsavedChanges()).toBe(false);
  sheet = await open();
  expect(reason(sheet).value).toBe("");
  expect(net.writes).toEqual([]);
});

it("composes policy and reason discard into one decision without clearing either on cancellation", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Independent reason");
  await owner.click(() => within(sheet).getByRole("switch", { name: "暂停平台服务" }));
  await owner.click(() => within(sheet).getByRole("button", { name: "取消" }));
  const discard = await screen.findByRole("alertdialog", { name: "放弃授权修改与重置原因？" });
  owner.assertActive();
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(within(discard).getByText("当前授权修改尚未保存。重置原因尚未提交。放弃后将无法恢复。")).toBeTruthy();
  await owner.click(() => within(discard).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe("Independent reason");
  expect(within(sheet).getByRole("switch", { name: "暂停平台服务" }).getAttribute("aria-checked")).toBe("true");
  expect(net.writes).toEqual([]);
});

it("protects whitespace as raw input but treats exact clearing as a clean task", async () => {
  const net = network();
  mount();
  let sheet = await open();
  expect(hasUnsavedChanges()).toBe(false);
  edit(sheet, " \n ");
  expect(hasUnsavedChanges()).toBe(true);
  expect((within(sheet).getByRole("button", { name: "重置本周期用量" }) as HTMLButtonElement).disabled).toBe(true);
  edit(sheet, "");
  expect(hasUnsavedChanges()).toBe(false);
  await owner.click(() => within(sheet).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  sheet = await open();
  await owner.click(() => within(sheet).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(net.writes).toEqual([]);
});

it("sends nothing on Enter or reset-review cancellation and submits the exact live reason once", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "  Review text  ");
  await owner.click(() => reason(sheet));
  await userEvent.keyboard("{Enter}");
  owner.assertActive();
  const submitted = reason(sheet).value;
  expect(submitted).toContain("\n");
  expect(net.writes).toEqual([]);
  let decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe(submitted);
  expect(net.writes).toEqual([]);
  decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.writes).toEqual([{ path: "/api/users/u1/reset", body: { reason: submitted } }]));
  owner.assertActive();
  expect(reason(sheet).disabled).toBe(true);
  expect((within(sheet).getByRole("button", { name: "取消", hidden: true }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(sheet).queryByRole("button", { name: "关闭", hidden: true })).toBeNull();
  expect((within(decision).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard("{Escape}");
  owner.assertActive();
  expect(screen.getByRole("alertdialog")).toBe(decision);
  // Queue duplicate events at the public button while the request is unresolved.
  fireEvent.click(within(decision).getByRole("button", { name: "确认重置" }));
  expect(net.writes).toHaveLength(1);
  await act(async () => net.resets[0](json({})));
  owner.assertActive();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe("");
  expect(hasUnsavedChanges()).toBe(false);
  expect(net.writes).toHaveLength(1);
});

it("keeps a rejected reset reason recoverable without an automatic retry", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Keep failed reason");
  const decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  await act(async () => net.resets[0](json({ detail: "Reset rejected" }, 400)));
  owner.assertActive();
  await within(decision).findByText("Reset rejected");
  owner.assertActive();
  await owner.click(() => within(decision).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe("Keep failed reason");
  await owner.click(() => within(sheet).getByRole("button", { name: "关闭" }));
  await screen.findByRole("alertdialog", { name: "放弃重置原因？" });
  owner.assertActive();
  expect(net.writes).toEqual([{ path: "/api/users/u1/reset", body: { reason: "Keep failed reason" } }]);
});

it("retires a reset decision when its editor leaves a retained provider", async () => {
  const net = network();
  const view = mount();
  const sheet = await open();
  edit(sheet, "Old owner");
  await reviewReset(sheet);
  view.rerender(<p>Replacement page</p>);
  // If a regression leaves a usable old decision, its public button must not write.
  const ghost = screen.queryByRole("alertdialog", { name: "重置「Alice」的本周期用量？" });
  if (ghost) await owner.click(() => within(ghost).getByRole("button", { name: "确认重置" }));
  expect(net.writes).toEqual([]);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(net.writes).toEqual([]);
  view.rerender(<FormHost user={bob} />);
  const next = await open("Bob");
  expect(reason(next).value).toBe("");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

function OverviewProbe() {
  const query = useQuery({ queryKey: ["overview"], queryFn: async () => (await fetch("/fixture/overview")).json() as Promise<number> });
  return <output aria-label="Overview reads">{query.data ?? "Loading"}</output>;
}
it.each([200, 400])("ignores a departed reset completion (%s) without clearing, notifying or refetching in a replacement task", async status => {
  const net = network();
  const view = mount(<><FormHost /><OverviewProbe /></>);
  await screen.findByText("1", { selector: "output" });
  owner.assertActive();
  const sheet = await open();
  edit(sheet, "Old pending reason");
  const decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  // Only replace the editor: the query/confirmation providers and observer remain.
  view.rerender(<><FormHost user={bob} /><OverviewProbe /></>);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  const next = screen.queryByRole("dialog", { name: "Bob 的服务授权" }) ?? await open("Bob");
  edit(next, "New draft must survive");
  await act(async () => net.resets[0](json(status === 200 ? {} : { detail: "Old failure" }, status)));
  owner.assertActive();
  expect(reason(next).value).toBe("New draft must survive");
  expect(screen.queryByText("本周期用量已重置，历史记录与下次自动重置时间保留")).toBeNull();
  expect(screen.queryByText("Old failure")).toBeNull();
  expect(screen.getByLabelText("Overview reads").textContent).toBe("1");
  expect(net.writes).toHaveLength(1);
});

it("preserves the independent reason through policy rebasing", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Keep through latest version");
  await owner.click(() => within(sheet).getByRole("switch", { name: "暂停平台服务" }));
  net.newer();
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  await screen.findByText("个人授权已更新。当前草稿尚未保存，请查看最新版本。");
  owner.assertActive();
  await owner.click(() => within(sheet).getByRole("button", { name: "查看最新版本" }));
  await screen.findByRole("table", { name: "已保存的个人授权变化" });
  owner.assertActive();
  await owner.click(() => within(sheet).getByRole("button", { name: "使用最新版本重新编辑" }));
  const decision = await screen.findByRole("alertdialog", { name: "使用最新版本重新编辑？" });
  owner.assertActive();
  await owner.click(() => within(decision).getByRole("button", { name: "使用最新版本" }));
  await screen.findByRole("button", { name: "保留的草稿 1（未保存）" });
  owner.assertActive();
  const replacement = screen.getByRole("dialog", { name: "Alice 的服务授权" });
  expect(reason(replacement).value).toBe("Keep through latest version");
  expect(net.writes.map(write => write.path)).toEqual(["/api/access-policy/preview"]);
});

it("names reset-reason disposal in policy-apply consent without putting reason in the policy payload", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Separate audit text");
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  expect(net.writes).toEqual([{ path: "/api/access-policy/preview", body: {
    change: { entitlement: original }, precondition: { exists: true, revision: "opened-1" },
  } }]);
  const consentLabel = "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃重置原因";
  expect(within(review).getByRole("checkbox", { name: consentLabel })).toBeTruthy();
  expect((within(review).getByRole("button", { name: "更新授权" }) as HTMLButtonElement).disabled).toBe(true);
  await owner.click(() => within(review).getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe("Separate audit text");
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  const nextReview = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  await owner.click(() => within(nextReview).getByRole("checkbox", { name: consentLabel }));
  await owner.click(() => within(nextReview).getByRole("button", { name: "更新授权" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  expect(net.writes).toEqual([
    { path: "/api/access-policy/preview", body: { change: { entitlement: original }, precondition: { exists: true, revision: "opened-1" } } },
    { path: "/api/access-policy/preview", body: { change: { entitlement: original }, precondition: { exists: true, revision: "opened-1" } } },
    { path: "/api/access-policy/apply", body: { change: { entitlement: original }, revision: "preview-1" } },
  ]);
});

it("keeps reset review on canceled browser Back and retires it after explicit navigation discard", async () => {
  const net = network();
  mount(<App />);
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  owner.assertActive();
  const navigation = screen.getByRole("navigation", { name: "工作空间导航" });
  await owner.click(() => within(navigation).getByRole("button", { name: "用户" }));
  await screen.findByRole("heading", { name: "用户", level: 1 });
  owner.assertActive();
  await owner.click(() => screen.getByRole("button", { name: "更多操作 Alice" }));
  await owner.click(() => screen.getByRole("menuitem", { name: "授权与续期" }));
  // The loading sheet is replaced when its context arrives; own the current control.
  await screen.findByRole("textbox", { name: "重置原因" });
  owner.assertActive();
  const sheet = screen.getByRole("dialog", { name: "Alice 的服务授权" });
  edit(sheet, "Keep on canceled Back");
  await reviewReset(sheet);
  const proof = history.state;
  await act(async () => history.back());
  owner.assertActive();
  let leave = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  owner.assertActive();
  await owner.click(() => within(leave).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" })).toBeNull());
  owner.assertActive();
  expect(location.hash).toBe("#users");
  expect(history.state).toEqual(proof);
  expect(screen.getByRole("alertdialog", { name: "重置「Alice」的本周期用量？" })).toBeTruthy();
  expect(reason(sheet).value).toBe("Keep on canceled Back");
  expect(net.writes).toEqual([]);
  await act(async () => history.back());
  owner.assertActive();
  leave = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  owner.assertActive();
  await owner.click(() => within(leave).getByRole("button", { name: "放弃修改并离开" }));
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  owner.assertActive();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(net.writes).toEqual([]);
  await act(async () => history.forward());
  owner.assertActive();
  await screen.findByRole("heading", { name: "用户", level: 1 });
  owner.assertActive();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(net.writes).toEqual([]);
});

it("returns successful reset focus to the enabled reason input", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Successful reset");
  const decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  await act(async () => net.resets[0](json({})));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  await waitFor(() => expect(document.activeElement).toBe(reason(sheet)));
  expect(reason(sheet).disabled).toBe(false);
  expect((within(sheet).getByRole("button", { name: "重置本周期用量" }) as HTMLButtonElement).disabled).toBe(true);
});

it("does not take newer sheet focus when a successful reset decision finishes closing", async () => {
  const net = network();
  mount();
  const sheet = await open();
  edit(sheet, "Successful reset with newer focus");
  const next = within(sheet).getByRole("button", { name: "预览影响" });
  const field = reason(sheet);
  const decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  let newerClaimed = false, stoleNewerFocus = false;
  field.addEventListener("focus", () => { if (newerClaimed) stoleNewerFocus = true; });
  const observer = new MutationObserver(() => {
    if (!newerClaimed && !decision.isConnected) {
      newerClaimed = true;
      next.focus();
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
  try {
    await act(async () => net.resets[0](json({})));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    owner.assertActive();
    await act(async () => {});
    owner.assertActive();
    expect(newerClaimed).toBe(true);
    expect(document.activeElement).toBe(next);
    expect(stoleNewerFocus).toBe(false);
  } finally { observer.disconnect(); }
});

async function openWorkspaceEditor() {
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  owner.assertActive();
  await owner.click(() => within(screen.getByRole("navigation", { name: "工作空间导航" })).getByRole("button", { name: "用户" }));
  await screen.findByRole("heading", { name: "用户", level: 1 });
  owner.assertActive();
  await owner.click(() => screen.getByRole("button", { name: "更多操作 Alice" }));
  await owner.click(() => screen.getByRole("menuitem", { name: "授权与续期" }));
  // The loading sheet is replaced when its context arrives; own the current control.
  await screen.findByRole("textbox", { name: "重置原因" });
  owner.assertActive();
  const sheet = screen.getByRole("dialog", { name: "Alice 的服务授权" });
  return sheet;
}
it("warns that pending reset is not canceled by Back, preserves it on stay, then suppresses late completion after leaving", async () => {
  const net = network();
  mount(<App />);
  const sheet = await openWorkspaceEditor();
  edit(sheet, "Pending navigation reason");
  const decision = await reviewReset(sheet);
  await owner.click(() => within(decision).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  expect(within(sheet).getByRole("button", { name: "预览影响", hidden: true }).getAttribute("aria-disabled")).toBe("true");
  await act(async () => history.back());
  owner.assertActive();
  let leave = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  owner.assertActive();
  expect(within(leave).getByText("用量重置正在提交。离开不会取消已提交的重置；请返回后核对结果。")).toBeTruthy();
  await owner.click(() => within(leave).getByRole("button", { name: "留在当前页面" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "离开当前页面？" })).toBeNull());
  owner.assertActive();
  expect(location.hash).toBe("#users");
  expect(screen.getByRole("alertdialog", { name: "重置「Alice」的本周期用量？" })).toBe(decision);
  expect(reason(sheet).value).toBe("Pending navigation reason");
  expect(net.writes).toHaveLength(1);
  await act(async () => history.back());
  owner.assertActive();
  leave = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  owner.assertActive();
  await owner.click(() => within(leave).getByRole("button", { name: "仍然离开" }));
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  await act(async () => net.resets[0](json({})));
  owner.assertActive();
  expect(screen.queryByText("本周期用量已重置，历史记录与下次自动重置时间保留")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(net.writes).toEqual([{ path: "/api/users/u1/reset", body: { reason: "Pending navigation reason" } }]);
});

it("names retained policy copies and reset text together in apply consent and explicit local discard", async () => {
  const net = network();
  mount();
  let sheet = await open();
  edit(sheet, "Independent retained reason");
  await owner.click(() => within(sheet).getByRole("switch", { name: "暂停平台服务" }));
  net.newer();
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  await screen.findByText("个人授权已更新。当前草稿尚未保存，请查看最新版本。");
  owner.assertActive();
  await owner.click(() => within(sheet).getByRole("button", { name: "查看最新版本" }));
  await screen.findByRole("table", { name: "已保存的个人授权变化" });
  owner.assertActive();
  await owner.click(() => within(sheet).getByRole("button", { name: "使用最新版本重新编辑" }));
  const decision = await screen.findByRole("alertdialog", { name: "使用最新版本重新编辑？" });
  owner.assertActive();
  await owner.click(() => within(decision).getByRole("button", { name: "使用最新版本" }));
  await screen.findByRole("button", { name: "保留的草稿 1（未保存）" });
  owner.assertActive();
  sheet = screen.getByRole("dialog", { name: "Alice 的服务授权" });
  net.allowPreview();
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  expect(within(review).getByRole("checkbox", {
    name: "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃重置原因与保留的未保存草稿副本",
  }).getAttribute("aria-checked")).toBe("false");
  await owner.click(() => within(review).getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  owner.assertActive();
  await owner.click(() => within(sheet).getByRole("button", { name: "取消" }));
  let discard = await screen.findByRole("alertdialog", { name: "放弃授权修改与重置原因？" });
  owner.assertActive();
  expect(discard.textContent).toContain("保留的授权草稿尚未保存。");
  expect(discard.textContent).toContain("重置原因尚未提交。");
  await owner.click(() => within(discard).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(reason(sheet).value).toBe("Independent retained reason");
  expect(within(sheet).getByRole("button", { name: "保留的草稿 1（未保存）" })).toBeTruthy();
  await owner.click(() => within(sheet).getByRole("button", { name: "取消" }));
  discard = await screen.findByRole("alertdialog", { name: "放弃授权修改与重置原因？" });
  owner.assertActive();
  await owner.click(() => within(discard).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  expect(net.writes.map(write => write.path)).toEqual(["/api/access-policy/preview", "/api/access-policy/preview"]);
});

it.each([
  [503, "Apply rejected", "Apply rejected"],
  [409, "Apply conflict", "Apply conflict"],
  [500, "policy applied; audit could not be recorded", "平台授权已更新，但审计记录未能保存。请核对最新授权和审计记录，不要重复提交本次变更。当前输入和保留的草稿未清除。"],
] as const)("retains the independent reason when policy apply returns %s: %s", async (status, detail, visible) => {
  const net = network();
  net.failApply(status, detail);
  mount();
  const sheet = await open();
  edit(sheet, "Keep after failed policy apply");
  await owner.click(() => within(sheet).getByRole("switch", { name: "暂停平台服务" }));
  await owner.click(() => within(sheet).getByRole("button", { name: "预览影响" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  await owner.click(() => within(review).getByRole("checkbox", { name: "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃重置原因" }));
  await owner.click(() => within(review).getByRole("button", { name: "更新授权" }));
  await screen.findByText(visible);
  owner.assertActive();
  expect(sheet.isConnected).toBe(true);
  expect(reason(sheet).value).toBe("Keep after failed policy apply");
  expect(hasUnsavedChanges()).toBe(true);
  expect(net.writes.map(write => write.path)).toEqual(["/api/access-policy/preview", "/api/access-policy/apply"]);
});

function CompanionCaller({ revision }: { revision: number }) {
  const [closed, setClosed] = useState(false);
  const policy = usePolicyChange({ mode: "guarded-entitlement", users: [alice], services: [], routes: [],
    onApplied: () => setClosed(true),
    closeCompanion: { pending: false, dirty: true, revision, label: "重置原因", discardDescription: "重置原因尚未提交。" },
  });
  return closed ? <p>Caller closed</p> : <><button onClick={() => policy.propose({ entitlement: original }, context().precondition)}>Preview caller</button>{policy.dialog}</>;
}
it("revokes policy-apply disposal consent when the public caller supplies a newer companion revision", async () => {
  const net = network();
  const view = mount(<CompanionCaller revision={1} />);
  await owner.click(() => screen.getByRole("button", { name: "Preview caller" }));
  const review = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  const label = "我已核对本次授权变更，并同意更新成功后关闭编辑器、丢弃重置原因";
  await owner.click(() => within(review).getByRole("checkbox", { name: label }));
  expect(within(review).getByRole("checkbox", { name: label }).getAttribute("aria-checked")).toBe("true");
  view.rerender(<CompanionCaller revision={2} />);
  expect(within(review).getByRole("checkbox", { name: label }).getAttribute("aria-checked")).toBe("false");
  const apply = within(review).getByRole("button", { name: "更新授权" }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(apply);
  expect(net.writes.map(write => write.path)).toEqual(["/api/access-policy/preview"]);
  await owner.click(() => within(review).getByRole("checkbox", { name: label }));
  await owner.click(() => within(review).getByRole("button", { name: "更新授权" }));
  await screen.findByText("Caller closed");
  owner.assertActive();
  expect(net.writes.map(write => write.path)).toEqual(["/api/access-policy/preview", "/api/access-policy/apply"]);
});

it("keeps navigation focus during reset completion and returns to an eligible reset control after Stay", async () => {
  const net = network();
  mount(<App />);
  const sheet = await openWorkspaceEditor();
  edit(sheet, "Finish while deciding navigation");
  const reset = await reviewReset(sheet);
  await owner.click(() => within(reset).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  await act(async () => history.back());
  const leave = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  owner.assertActive();
  const stay = within(leave).getByRole("button", { name: "留在当前页面" });
  await waitFor(() => expect(document.activeElement).toBe(stay));
  await act(async () => net.resets[0](json({})));
  owner.assertActive();
  await waitFor(() => expect(reset.isConnected).toBe(false));
  expect(document.activeElement).toBe(stay);
  expect(reason(sheet).value).toBe("");
  await owner.click(() => stay);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(location.hash).toBe("#users");
  await waitFor(() => expect(document.activeElement).toBe(reason(sheet)));
  expect(reason(sheet).disabled).toBe(false);
  expect(net.writes).toHaveLength(1);
});

it.each(["control", "modal"] as const)("revokes the delayed reset handoff for a newer %s when Stay releases navigation", async kind => {
  const net = network();
  const tree = (newer = false) => <><App /><TaskDialog title="Newer task" open={newer} onOpenChange={() => {}}
    initialFocus={() => screen.getByRole("button", { name: "Newer task action" })}
  ><button>Newer task action</button></TaskDialog></>;
  const view = mount(tree());
  const sheet = await openWorkspaceEditor();
  edit(sheet, "Finish before newer task");
  const field = reason(sheet);
  const nextControl = within(sheet).getByRole("button", { name: "预览影响" });
  const reset = await reviewReset(sheet);
  await owner.click(() => within(reset).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  await act(async () => history.back());
  const leave = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  owner.assertActive();
  await act(async () => net.resets[0](json({})));
  await waitFor(() => expect(reset.isConnected).toBe(false));
  owner.assertActive();
  let claimed = false, stole = false;
  field.addEventListener("focus", () => { if (claimed) stole = true; });
  const observer = new MutationObserver(() => {
    if (!claimed && !leave.isConnected) {
      claimed = true;
      if (kind === "control") nextControl.focus();
      else flushSync(() => view.rerender(tree(true)));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
  try {
    await owner.click(() => within(leave).getByRole("button", { name: "留在当前页面" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    owner.assertActive();
    await act(async () => {});
    owner.assertActive();
    expect(claimed).toBe(true);
    const expected = kind === "control" ? nextControl : screen.getByRole("button", { name: "Newer task action" });
    expect(document.activeElement).toBe(expected);
    expect(stole).toBe(false);
    expect(field.value).toBe("");
    expect(net.writes).toHaveLength(1);
  } finally { observer.disconnect(); }
});

it("cancels the deferred success handoff when navigation discards the reset editor", async () => {
  const net = network();
  mount(<App />);
  const sheet = await openWorkspaceEditor();
  edit(sheet, "Finish before leaving");
  const field = reason(sheet);
  const reset = await reviewReset(sheet);
  await owner.click(() => within(reset).getByRole("button", { name: "确认重置" }));
  await waitFor(() => expect(net.resets).toHaveLength(1));
  owner.assertActive();
  await act(async () => history.back());
  const leave = await screen.findByRole("alertdialog", { name: "离开当前页面？" });
  owner.assertActive();
  await act(async () => net.resets[0](json({})));
  await waitFor(() => expect(reset.isConnected).toBe(false));
  owner.assertActive();
  let restoredDepartingInput = false;
  field.addEventListener("focus", () => { restoredDepartingInput = true; });
  await owner.click(() => within(leave).getByRole("button", { name: "仍然离开" }));
  await screen.findByRole("heading", { name: "服务方案", level: 1 });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  owner.assertActive();
  expect(sheet.isConnected).toBe(false);
  expect(restoredDepartingInput).toBe(false);
  expect(sheet.contains(document.activeElement)).toBe(false);
  await act(async () => history.forward());
  await screen.findByRole("heading", { name: "用户", level: 1 });
  owner.assertActive();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(restoredDepartingInput).toBe(false);
  expect(net.writes).toHaveLength(1);
});

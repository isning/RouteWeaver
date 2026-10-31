// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TaskDialog } from "./ui-patterns/task-overlays";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { UserPolicyForm } from "./UserPolicyEditor";
import { UserGroups } from "./AccessPolicy";
import { ErrorNotice } from "./components";
import { SessionBoundary, useSessionAccess } from "./SessionBoundary";
import { setCSRF, setToken } from "./api";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { entitlementEditFixture } from "./test-support/entitlement-edit-fixture";
import { groupEditFixture } from "./test-support/group-edit-fixture";
import type { EffectivePolicy } from "./access-policy-model";

type Owner = ReturnType<typeof ownedClickScenario>;
let currentOwner: Owner;
let currentContext: TestContext;
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const plan = { id: "plan", name: "保留方案", quotaBytes: 107374182400, routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, cycle: { mode: "monthly", day: 1, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8" } };
const serviceFixture = serviceEditFixture(plan, "opened-plan");
function serviceReview(submitted: typeof plan, revision: string) {
  return serviceFixture.preview(submitted, { revision, affected: [], blockers: [] });
}
const user = { id: "u1", name: "Alice", enabled: true, quotaBytes: 0, usedBytes: 0 };
const initial: EffectivePolicy = {
  userId: user.id, serviceId: plan.id, service: plan, groupIds: [], routeIds: [],
  quotaBytes: plan.quotaBytes, onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0, status: "active",
  provenance: { service: "individual", quotaBytes: "service:plan" },
  entitlement: { userId: user.id, serviceId: plan.id, startsAt: "2026-01-01T00:00:00Z", cycle: plan.cycle },
};
const entitlementFixture = entitlementEditFixture(initial);
const consent = "我已核对本次授权变更";
function deferred() {
  let finish!: (response: Response) => void;
  let delivered = false;
  const promise = new Promise<Response>((done) => { finish = done; });
  const resolve = (response: Response) => {
    if (delivered) return;
    delivered = true;
    finish(response);
  };
  // A failed setup must not leave an owned mock response pending after its
  // native test finishes. Normal journeys explicitly deliver their response.
  currentContext.onTestFinished(() => resolve(json({ error: "Retired test response" }, 503)));
  return { promise, resolve };
}
beforeEach((context) => {
  currentContext = context;
  currentOwner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  setToken(""); setCSRF("");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} postMessage() {} close() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  setToken(""); setCSRF("");
});
function mount(owner: Owner, children: ReactNode) {
  owner.assertActive();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const host = document.createElement("div"); document.body.append(host);
  const wrap = (value: ReactNode) => <StrictMode><QueryClientProvider client={client}><UIProviders portal={host}>{value}</UIProviders></QueryClientProvider></StrictMode>;
  const view = render(wrap(children), { container: host });
  return { host, rerender(value: ReactNode) { owner.assertActive(); view.rerender(wrap(value)); }, unmount() { owner.assertActive(); view.unmount(); host.remove(); } };
}
function Editor({ services = [plan] }: { services?: typeof plan[] }) {
  return <ServicePolicyEditor initial={plan} users={[user]} services={services} routes={[]} onClose={() => {}} />;
}
async function preview(owner: Owner) {
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  const dialog = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive(); return within(dialog);
}
async function update(owner: Owner) {
  const dialog = await preview(owner);
  await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
  await owner.click(() => dialog.getByRole("button", { name: "更新授权" }));
  return dialog;
}
function alertFor(message: string) {
  return screen.getByText(message).closest('[role="alert"]') as HTMLElement;
}
function summaryFor(message: string) {
  return screen.getByRole("group", { name: "操作未完成", description: message });
}

it("hands a settled retained-update failure to the current review error without duplicating the parent error", async () => {
  const owner = currentOwner;
  const pending = deferred();
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/access-policy/edit-context/service/")) return json(serviceFixture.context());
    writes.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith("/preview") ? json(serviceReview(JSON.parse(init!.body as string).change.service, "review-v1")) : pending.promise;
  }));
  mount(owner, <Editor />);
  const dialog = await update(owner);
  expect(dialog.getByRole("button", { name: "更新授权" }).getAttribute("aria-busy")).toBe("true");
  await act(async () => pending.resolve(json({ error: "Update unavailable; draft retained" }, 503)));
  owner.assertActive();
  await dialog.findByText("Update unavailable; draft retained");
  owner.assertActive();
  const summary = dialog.getByRole("group", { name: "操作未完成", description: "Update unavailable; draft retained" });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  owner.assertActive();
  expect(summary.tabIndex).toBe(-1);
  const passiveAlert = within(summary).getByRole("alert");
  expect(summary.firstElementChild).toBe(passiveAlert);
  expect(summary.classList.contains("form-error")).toBe(true);
  expect(passiveAlert.classList.contains("form-error")).toBe(false);
  expect(document.getElementById(summary.getAttribute("aria-labelledby")!)).toBe(within(passiveAlert).getByText("操作未完成"));
  expect(document.getElementById(summary.getAttribute("aria-describedby")!)).toBe(within(passiveAlert).getByText("Update unavailable; draft retained"));
  expect(passiveAlert).not.toBe(summary);
  expect(passiveAlert.hasAttribute("tabindex")).toBe(false);
  expect(document.activeElement).not.toBe(passiveAlert);
  expect(screen.getAllByText("Update unavailable; draft retained")).toHaveLength(1);
  expect(dialog.getByRole("button", { name: "更新授权" }).getAttribute("aria-busy")).not.toBe("true");
  expect(dialog.getByRole("checkbox", { name: consent }).getAttribute("aria-checked")).toBe("true");
  expect(writes[1]).toEqual({ url: "/api/access-policy/apply", body: { change: (writes[0].body as { change: { service: unknown } }).change, revision: "review-v1" } });
  await owner.click(() => dialog.getByRole("button", { name: "返回编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull());
  owner.assertActive();
  const editor = within(screen.getByRole("dialog", { name: "编辑 保留方案" }));
  const retainedError = editor.getByRole("alert");
  expect(within(retainedError).getByText("Update unavailable; draft retained")).toBeTruthy();
  expect(screen.getAllByRole("alert")).toEqual([retainedError]);
  expect((editor.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("保留方案");
  expect(document.activeElement).not.toBe(editor.getByRole("group", { name: "操作未完成", description: "Update unavailable; draft retained" }));
  expect(document.activeElement).not.toBe(retainedError);
  expect(retainedError.hasAttribute("tabindex")).toBe(false);
});

it("focuses each failed retry once but never steals focus during an ordinary catalog rerender", async () => {
  const owner = currentOwner;
  const pending = deferred();
  let applies = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/access-policy/edit-context/service/")) return json(serviceFixture.context());
    if (String(url).endsWith("/preview")) return json(serviceReview(JSON.parse(init!.body as string).change.service, "retry-review"));
    applies++;
    return applies === 1 ? pending.promise : json({ error: "Check current authorization before retrying" }, 503);
  }));
  const mounted = mount(owner, <Editor />);
  const focused: Element[] = [];
  const record = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches('.form-error[role="group"]')) focused.push(event.target);
  };
  document.addEventListener("focusin", record);
  try {
    const dialog = await update(owner);
    await act(async () => pending.resolve(json({ error: "Check current authorization before retrying" }, 503)));
    owner.assertActive();
    await waitFor(() => expect(document.activeElement).toBe(dialog.getByRole("group", { name: "操作未完成", description: "Check current authorization before retrying" })));
    owner.assertActive();
    expect(focused).toHaveLength(1);
    await owner.click(() => dialog.getByRole("checkbox", { name: consent }));
    const checkbox = dialog.getByRole("checkbox", { name: consent });
    mounted.rerender(<Editor services={[{ ...plan, name: "目录更新" }]} />);
    expect(document.activeElement).toBe(checkbox);
    expect(focused).toHaveLength(1);
    await owner.click(() => checkbox);
    await owner.click(() => dialog.getByRole("button", { name: "更新授权" }));
    await waitFor(() => expect(focused).toHaveLength(2));
    owner.assertActive();
    expect(applies).toBe(2);
    expect(document.activeElement).toBe(dialog.getByRole("group", { name: "操作未完成", description: "Check current authorization before retrying" }));
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  } finally { document.removeEventListener("focusin", record); }
});

it("hands a failed preview to the editor summary and preserves the editable values", async () => {
  const owner = currentOwner;
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : json({ error: "Preview unavailable" }, 503)));
  mount(owner, <Editor />);
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  await screen.findByText("Preview unavailable");
  owner.assertActive();
  await waitFor(() => expect(document.activeElement).toBe(summaryFor("Preview unavailable")));
  owner.assertActive();
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  const name = screen.getByLabelText("服务方案名称") as HTMLInputElement;
  expect(name.value).toBe("保留方案");
  await owner.click(() => name);
  owner.change(() => name, { target: { value: "继续编辑" } });
  expect(screen.queryByText("Preview unavailable")).toBeNull();
  expect(document.activeElement).toBe(name);
  expect(name.value).toBe("继续编辑");
});

it.each(["group", "user"] as const)("uses the same editor-owned failed-preview handoff for %s authorization", async (kind) => {
  const owner = currentOwner;
  const groupFixture = groupEditFixture({ id: "g1", name: "Family", serviceId: plan.id, priority: 1, memberIds: [] });
  vi.stubGlobal("fetch", vi.fn(entitlementFixture.transport(async (url) => String(url).includes("/access-policy/edit-context/group/") ? json(groupFixture.context()) : String(url).endsWith("/user-groups")
    ? json([{ id: "g1", name: "Family", serviceId: plan.id, priority: 1, memberIds: [] }])
    : json({ error: "Preview needs recovery" }, 503))));
  mount(owner, kind === "group"
    ? <UserGroups users={[user]} services={[plan]} routes={[]} />
    : <UserPolicyForm user={user} initial={entitlementFixture.context()} services={[plan]} routes={[]} onClose={() => {}} />);
  if (kind === "group") await owner.click(() => screen.findByRole("button", { name: "编辑 Family" }));
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  await screen.findByText("Preview needs recovery");
  owner.assertActive();
  await waitFor(() => expect(document.activeElement).toBe(summaryFor("Preview needs recovery")));
  owner.assertActive();
  expect(screen.getAllByText("Preview needs recovery")).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

it("hands a 409 back to the editor only after review closure and requires fresh consent", async () => {
  const owner = currentOwner;
  let previews = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : String(url).endsWith("/preview")
    ? json(serviceReview(JSON.parse(init!.body as string).change.service, `review-${++previews}`))
    : json({ error: "Policy changed; preview again" }, 409)));
  mount(owner, <Editor />);
  const transitions: boolean[] = [];
  const record = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.matches('.form-error[role="group"]'))
      transitions.push(screen.queryByRole("dialog", { name: "确认授权变更" }) === null);
  };
  document.addEventListener("focusin", record);
  try {
    await update(owner);
    await screen.findByText("Policy changed; preview again");
    owner.assertActive();
    await waitFor(() => expect(document.activeElement).toBe(summaryFor("Policy changed; preview again")));
    owner.assertActive();
    expect(transitions).toEqual([true]);
    expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
    expect((screen.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("保留方案");
    const fresh = await preview(owner);
    expect(fresh.queryByText("Policy changed; preview again")).toBeNull();
    expect(fresh.getByRole("checkbox", { name: consent }).getAttribute("aria-checked")).toBe("false");
    expect((fresh.getByRole("button", { name: "更新授权" }) as HTMLButtonElement).disabled).toBe(true);
    expect(previews).toBe(2);
  } finally { document.removeEventListener("focusin", record); }
});

it("does not announce or focus a stale preview failure after the user edits the draft", async () => {
  const owner = currentOwner;
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : pending.promise));
  mount(owner, <Editor />);
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  const name = screen.getByLabelText("服务方案名称") as HTMLInputElement;
  await owner.click(() => name);
  owner.change(() => name, { target: { value: "较新的草稿" } });
  await act(async () => pending.resolve(json({ error: "Obsolete preview failure" }, 503)));
  owner.assertActive();
  await waitFor(() => expect(screen.getByRole("button", { name: "预览影响" }).getAttribute("aria-busy")).not.toBe("true"));
  owner.assertActive();
  expect(screen.queryByText("Obsolete preview failure")).toBeNull();
  expect(document.activeElement).toBe(name);
  expect(name.value).toBe("较新的草稿");
});

it.each(["hidden", "inert", "aria-hidden", "display-none", "visibility-hidden", "inactive-workspace"] as const)("drops a %s feedback target instead of replaying focus when it becomes visible", async (condition) => {
  const owner = currentOwner;
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : String(url).endsWith("/preview")
    ? json(serviceReview(JSON.parse(init!.body as string).change.service, "hidden-review")) : pending.promise));
  const mounted = mount(owner, <Editor />);
  await update(owner);
  const otherTask = render(<TaskDialog open onOpenChange={() => {}} title="Other task"><button>Continue other task</button></TaskDialog>);
  const safe = screen.getByRole("button", { name: "Continue other task" });
  try {
    if (condition === "hidden") mounted.host.hidden = true;
    if (condition === "inert") mounted.host.setAttribute("inert", "");
    if (condition === "aria-hidden") mounted.host.setAttribute("aria-hidden", "true");
    if (condition === "display-none") mounted.host.style.display = "none";
    if (condition === "visibility-hidden") mounted.host.style.visibility = "hidden";
    if (condition === "inactive-workspace") { mounted.host.setAttribute("data-session-workspace", ""); mounted.host.setAttribute("aria-busy", "true"); }
    act(() => safe.focus());
    await act(async () => pending.resolve(json({ error: "Hidden review failure" }, 503)));
    owner.assertActive();
    await waitFor(() => expect(mounted.host.textContent).toContain("Hidden review failure"));
    owner.assertActive();
    expect(document.activeElement).toBe(safe);
    mounted.host.hidden = false; mounted.host.removeAttribute("inert"); mounted.host.removeAttribute("aria-hidden"); mounted.host.style.display = ""; mounted.host.style.visibility = ""; mounted.host.removeAttribute("aria-busy");
    mounted.rerender(<Editor services={[{ ...plan, name: "Fresh catalog" }]} />);
    expect(screen.getAllByText("Hidden review failure")).toHaveLength(1);
    expect(document.activeElement).toBe(safe);
    expect(screen.getByText("Hidden review failure").closest('[role="group"]')!.hasAttribute("tabindex")).toBe(false);
    expect(alertFor("Hidden review failure").hasAttribute("tabindex")).toBe(false);
  } finally { otherTask.unmount(); }
});

it("does not take focus from a different active dialog or replay the dropped handoff later", async () => {
  const owner = currentOwner;
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : String(url).endsWith("/preview")
    ? json(serviceReview(JSON.parse(init!.body as string).change.service, "other-dialog")) : pending.promise));
  const mounted = mount(owner, <Editor />);
  await update(owner);
  const otherTask = render(<TaskDialog open onOpenChange={() => {}} title="Other task"><button>Continue other task</button></TaskDialog>);
  const safe = screen.getByRole("button", { name: "Continue other task" });
  try {
    act(() => safe.focus());
    await act(async () => pending.resolve(json({ error: "Review failed behind another task" }, 503)));
    owner.assertActive();
    await screen.findByText("Review failed behind another task");
    owner.assertActive();
    expect(document.activeElement).toBe(safe);
    otherTask.unmount();
    mounted.rerender(<Editor services={[{ ...plan, name: "Catalog changed" }]} />);
    expect(document.activeElement).not.toBe(summaryFor("Review failed behind another task"));
    expect(summaryFor("Review failed behind another task").hasAttribute("tabindex")).toBe(false);
    expect(alertFor("Review failed behind another task").hasAttribute("tabindex")).toBe(false);
  } finally { otherTask.unmount(); }
});

it.each([401, 403])("leaves status %s focus to session recovery without changing the error", async (status) => {
  const owner = currentOwner;
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : pending.promise));
  mount(owner, <Editor />);
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  await act(async () => pending.resolve(json({ error: "Session verification required" }, status)));
  owner.assertActive();
  await screen.findByText("Session verification required");
  owner.assertActive();
  expect(document.activeElement).not.toBe(summaryFor("Session verification required"));
  expect(summaryFor("Session verification required").hasAttribute("tabindex")).toBe(false);
  expect(alertFor("Session verification required").hasAttribute("tabindex")).toBe(false);
});

it("cannot focus an unmounted editor when its held failure later settles", async () => {
  const owner = currentOwner;
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("/access-policy/edit-context/service/") ? json(serviceFixture.context()) : pending.promise));
  const mounted = mount(owner, <Editor />);
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  mounted.rerender(<button>Current task</button>);
  const current = screen.getByRole("button", { name: "Current task" });
  await owner.click(() => current);
  await act(async () => pending.resolve(json({ error: "Unmounted failure" }, 503)));
  owner.assertActive();
  expect(document.activeElement).toBe(current);
  expect(screen.queryByText("Unmounted failure")).toBeNull();
});

it("keeps ordinary ErrorNotice rendering non-focusable and does not move current input focus", async () => {
  const owner = currentOwner;
  const tree = (error: Error | null) => <><input aria-label="Other input" /><ErrorNotice error={error} /></>;
  const mounted = mount(owner, tree(null));
  const input = screen.getByLabelText("Other input");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(mounted.host.querySelector(".form-error")).toBeNull();
  await owner.click(() => input);
  mounted.rerender(tree(new Error("Ordinary notice")));
  expect(document.activeElement).toBe(input);
  expect(alertFor("Ordinary notice").hasAttribute("tabindex")).toBe(false);
  expect(screen.queryByRole("group", { name: "操作未完成" })).toBeNull();
  expect(alertFor("Ordinary notice").classList.contains("form-error")).toBe(true);
  expect(input.nextElementSibling).toBe(alertFor("Ordinary notice"));
});

function SessionEditor() {
  const { snapshot } = useSessionAccess();
  const name = snapshot.session!.user.name;
  return <><p>{name}</p><ServicePolicyEditor initial={{ ...plan, name: `${name} plan` }} users={[user]} services={[plan]} routes={[]} onClose={() => {}} /></>;
}
it("does not expose or focus the previous account's held policy failure after a session replacement", async () => {
  const owner = currentOwner;
  let account: "A" | "B" = "A";
  const sessionFixtures = {
    A: serviceEditFixture({ ...plan, name: "Account A plan" }, "opened-A"),
    B: serviceEditFixture({ ...plan, name: "Account B plan" }, "opened-B"),
  };
  const pending = deferred();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).endsWith("/auth/me")) return json({ user: { id: account, name: `Account ${account}`, role: "admin" }, csrfToken: `csrf-${account}` });
    if (String(url).includes("/access-policy/edit-context/service/")) return json(sessionFixtures[account].context());
    if (String(url).endsWith("/access-policy/preview")) return pending.promise;
    throw new Error(`Unexpected request: ${String(url)}`);
  }));
  mount(owner, <SessionBoundary login={() => <p>Recover session</p>}><SessionEditor /></SessionBoundary>);
  await screen.findByText("Account A");
  owner.assertActive();
  await owner.click(() => screen.findByRole("button", { name: "预览影响" }));
  account = "B";
  act(() => fireEvent(window, new Event("focus")));
  await screen.findByText("Account B");
  owner.assertActive();
  const input = await screen.findByLabelText("服务方案名称") as HTMLInputElement;
  owner.assertActive();
  await owner.click(() => input);
  await act(async () => pending.resolve(json({ error: "Account A private failure" }, 503)));
  owner.assertActive();
  expect(input.value).toBe("Account B plan");
  expect(document.activeElement).toBe(input);
  expect(screen.queryByText("Account A private failure")).toBeNull();
  expect(screen.queryByText("Account A")).toBeNull();
});

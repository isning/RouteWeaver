// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { Service } from "./types";

let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const cases = [
  { mode: "monthly", key: "day", label: "每月几号", initial: 1, raw: "1.0000000000000001", ordinaryFraction: "1.5", correction: "2e0", corrected: 2 },
  { mode: "fixed-days", key: "days", label: "每周期天数", initial: 23, raw: "23.0000000000000001", ordinaryFraction: "23.5", correction: "24.000", corrected: 24 },
] as const;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

beforeEach(context => {
  owner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => original(element));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
function mount(mode: "monthly" | "fixed-days", conflict = false, options: { create?: boolean; cycle?: Partial<Service["cycle"]> } = {}) {
  const saved: Service = {
    id: "cycle-draft", name: "Cycle draft plan", quotaBytes: 1073741824,
    routeIds: [], onlineIpLimit: 0, connectionLimit: 0, entryRateBps: 0,
    cycle: { mode, day: 1, days: 23, anchor: "2026-01-01T00:00:00Z", timezone: "UTC+8", ...options.cycle },
  };
  const fixture: { record: Service | null; revision: string; conflict: boolean; nextRead?: Promise<Response>; nextPreview?: Promise<Response> } = {
    record: options.create ? null : saved, revision: "cycle-open", conflict,
  };
  const previews: { change: { service: Service }; precondition: { exists: boolean; revision: string } }[] = [];
  const close = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const read = /^\/api\/access-policy\/edit-context\/service\/([^/]+)$/.exec(String(url));
    if (read && (options.create || read[1] === saved.id) && (!init?.method || init.method === "GET")) {
      const held = fixture.nextRead;
      fixture.nextRead = undefined;
      return held ?? json({ target: { kind: "service", id: read[1] }, record: fixture.record ? { service: fixture.record } : null, precondition: { exists: !!fixture.record, revision: fixture.revision } });
    }
    if (String(url) === "/api/access-policy/preview" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      previews.push(body);
      const held = fixture.nextPreview;
      fixture.nextPreview = undefined;
      if (held) return held;
      if (fixture.conflict && body.precondition.revision === "cycle-open") return new Response(JSON.stringify({ code: "POLICY_EDIT_BASELINE_CHANGED", detail: "服务方案已更新。当前草稿尚未保存，请查看最新版本。" }), { status: 409, headers: { "Content-Type": "application/json" } });
      return json({ revision: "cycle-reviewed", guard: "opened-record", affected: [], blockers: [],
        resource: { target: { kind: "service", id: body.change.service.id }, before: fixture.record ? { service: fixture.record } : null, after: { service: body.change.service } } });
    }
    throw new Error("Unexpected active-cycle fixture request");
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<StrictMode><QueryClientProvider client={client}><UIProviders>
    <ServicePolicyEditor initial={options.create ? null : saved} users={[]} services={[saved]} routes={[]} onClose={close} />
  </UIProviders></QueryClientProvider></StrictMode>);
  return { previews, close, saved, fixture, unmount: view.unmount, setLatest: () => { fixture.record = { ...saved, name: "Latest cycle plan", cycle: { ...saved.cycle, day: 16, days: 28 } }; fixture.revision = "cycle-latest"; } };
}
const preview = () => screen.getByRole("button", { name: "预览影响" });

it.each(cases)("does not round an active $mode cycle draft into its previous integer on ordinary Preview", async ({ mode, label, initial, raw }) => {
  const { previews } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  expect(control.value).toBe(String(initial));
  owner.change(() => control, { target: { value: raw } });
  expect(control.value).toBe(raw);
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(control.value).toBe(raw);
});

it.each(cases)("already rejects an obvious active $mode fraction and accepts an explicit exact correction", async ({ mode, key, label, ordinaryFraction, correction, corrected }) => {
  const { previews, saved } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: ordinaryFraction } });
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect(control.value).toBe(ordinaryFraction);
  owner.change(() => control, { target: { value: correction } });
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.cycle).toEqual({ ...saved.cycle, [key]: corrected });
  expect(previews[0].precondition).toEqual({ exists: true, revision: "cycle-open" });
});

it.each(cases)("already blocks visible unfinished native input for the active $mode rule", async ({ mode, label }) => {
  const { previews } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: "1e" } });
  expect(control.checkValidity()).toBe(false);
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect(control.value).toBe("1e");
});

it.each(cases)("protects an unaccepted active $mode cycle spelling on Cancel", async ({ mode, label, raw }) => {
  const { close } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: raw } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  expect(close).not.toHaveBeenCalled();
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  expect(control.value).toBe(raw);
});


const incompleteCases = cases.flatMap(test => ["-", "1e"].map(incomplete => ({ ...test, incomplete })));
it.each(incompleteCases)("protects ordinary incomplete $mode input $incomplete on Cancel", async ({ mode, label, incomplete }) => {
  const { close } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: incomplete } });
  expect(control.checkValidity()).toBe(false);
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  expect(close).not.toHaveBeenCalled();
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  expect(control.value).toBe(incomplete);
});

it.each(incompleteCases)("retains ordinary incomplete $mode input $incomplete after explicit latest adoption", async ({ mode, label, incomplete }) => {
  const { previews, setLatest } = mount(mode, true);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  await owner.click(preview);
  await screen.findByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。");
  owner.assertActive();
  expect(previews).toHaveLength(1);
  owner.change(() => control, { target: { value: incomplete } });
  expect(control.checkValidity()).toBe(false);
  setLatest();
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() => screen.findByRole("button", { name: "使用最新版本重新编辑" }));
  await owner.click(() => screen.findByRole("button", { name: "使用最新版本" }));
  await screen.findByDisplayValue("Latest cycle plan");
  owner.assertActive();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(mode === "monthly" ? "16" : "28");
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const retained = await screen.findByRole("table", { name: "保留的草稿" });
  owner.assertActive();
  const row = within(retained).getByRole("rowheader", { name: mode === "monthly" ? "每月重置日" : "周期天数" }).closest("tr")!;
  expect(within(row).getAllByRole("cell").at(-1)?.textContent).toContain(incomplete);
  expect(previews).toHaveLength(1);
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.cycle).toMatchObject({ mode, day: 16, days: 28 });
  expect(previews[1].precondition).toEqual({ exists: true, revision: "cycle-latest" });
});


async function chooseRule(label: string) {
  await owner.click(() => screen.getByLabelText("默认重置规则"));
  await owner.click(() => screen.findByRole("option", { name: label }));
}

it.each(incompleteCases)("blocks direct submit of incomplete active $mode input $incomplete", async ({ mode, label, incomplete }) => {
  const { previews } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: incomplete } });
  await act(async () => { fireEvent.submit(control.closest("form")!); });
  expect(previews).toEqual([]);
  expect(control.value).toBe(incomplete);
  await waitFor(() => expect(document.activeElement).toBe(control));
});

it.each(cases)("keeps explicit mode changes available without losing the inactive $mode raw draft", async ({ mode, label, initial }) => {
  const { previews, saved } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: "1e" } });
  await chooseRule("不自动重置");
  expect(screen.queryByLabelText(label)).toBeNull();
  await chooseRule(mode === "monthly" ? "每月固定日" : "固定天数周期");
  const returned = screen.getByLabelText(label) as HTMLInputElement;
  expect(returned.value).toBe("1e");
  expect(returned.checkValidity()).toBe(false);
  await act(async () => { fireEvent.submit(returned.closest("form")!); });
  expect(previews).toEqual([]);
  await chooseRule("不自动重置");
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.cycle).toEqual({ ...saved.cycle, mode: "none" });
  expect(previews[0].change.service.cycle[mode === "monthly" ? "day" : "days"]).toBe(initial);
});


it.each(cases.flatMap(test => ["", "0", "-0", "-1", test.ordinaryFraction, String(test.mode === "monthly" ? 32 : 3661), test.raw, "1e99999"].map(invalid => ({ ...test, invalid }))))(
  "rejects active $mode input $invalid until an exact in-range correction", async ({ mode, key, label, invalid }) => {
    const { previews } = mount(mode);
    const control = await screen.findByLabelText(label) as HTMLInputElement;
    owner.change(() => control, { target: { value: invalid } });
    await act(async () => { fireEvent.submit(control.closest("form")!); });
    expect(previews).toEqual([]);
    expect(control.value).toBe(invalid);
    const maximum = mode === "monthly" ? 31 : 3660;
    owner.change(() => control, { target: { value: `+${maximum}.000` } });
    await owner.click(preview);
    await screen.findByRole("dialog", { name: "确认授权变更" });
    expect(previews).toHaveLength(1);
    expect(previews[0].change.service.cycle[key]).toBe(maximum);
  },
);

it.each(cases.flatMap(test => [{ raw: "+0001.000", expected: 1 }, { raw: test.mode === "monthly" ? "3.1e1" : "3.66e3", expected: test.mode === "monthly" ? 31 : 3660 }].map(value => ({ ...test, ...value }))))(
  "previews exact bounded $mode input $raw", async ({ mode, key, label, raw, expected }) => {
    const { previews } = mount(mode);
    const control = await screen.findByLabelText(label) as HTMLInputElement;
    owner.change(() => control, { target: { value: raw } });
    await owner.click(preview);
    await screen.findByRole("dialog", { name: "确认授权变更" });
    expect(previews).toHaveLength(1);
    expect(previews[0].change.service.cycle[key]).toBe(expected);
  },
);

it.each(cases)("does not validate the untouched inactive parameter of $mode", async ({ mode, label }) => {
  const inactive = mode === "monthly" ? { days: -7 } : { day: 91 };
  const { previews, saved } = mount(mode, false, { cycle: inactive });
  await screen.findByLabelText(label);
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.cycle).toEqual(saved.cycle);
});

it.each(cases)("drops discarded $mode raw text when the saved task reopens", async ({ mode, label, initial }) => {
  const first = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: "1e" } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "放弃修改" }));
  expect(first.close).toHaveBeenCalledOnce();
  first.unmount();
  const next = mount(mode);
  expect((await screen.findByLabelText(label) as HTMLInputElement).value).toBe(String(initial));
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(next.previews).toHaveLength(1);
  expect(next.previews[0].change.service.cycle).toEqual(next.saved.cycle);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(cases)("invalidates a held latest read after a raw-only $mode edit", async ({ mode, label }) => {
  const { fixture, saved } = mount(mode, true);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  await owner.click(preview);
  await screen.findByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。");
  const held = deferred<Response>();
  fixture.nextRead = held.promise;
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  owner.change(() => control, { target: { value: "-" } });
  await act(async () => { held.resolve(json({ target: { kind: "service", id: saved.id }, record: { service: { ...saved, name: "Late cycle plan" } }, precondition: { exists: true, revision: "late-cycle" } })); });
  expect(screen.queryByRole("button", { name: "使用最新版本重新编辑" })).toBeNull();
  expect(control.value).toBe("-");
});

it.each(cases)("invalidates a held preview after a raw-only $mode edit", async ({ mode, label }) => {
  const { previews, fixture, saved } = mount(mode);
  const control = await screen.findByLabelText(label) as HTMLInputElement;
  const held = deferred<Response>();
  fixture.nextPreview = held.promise;
  await owner.click(preview);
  await waitFor(() => expect(previews).toHaveLength(1));
  owner.change(() => control, { target: { value: "1e" } });
  await act(async () => { held.resolve(json({ revision: "late-cycle-preview", guard: "opened-record", affected: [], blockers: [], resource: { target: { kind: "service", id: saved.id }, before: { service: saved }, after: { service: previews[0].change.service } } })); });
  await waitFor(() => expect(preview().getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(control.value).toBe("1e");
});

it.each(cases)("keeps active $mode raw text and dirty ownership through a corrected collision restart", async ({ mode, key, label }) => {
  const { previews, fixture, close, saved } = mount(mode, true, { create: true });
  await screen.findByLabelText("服务方案名称");
  owner.change(() => screen.getByLabelText("服务方案名称"), { target: { value: "New cycle plan" } });
  if (mode === "fixed-days") await chooseRule("固定天数周期");
  const raw = mode === "monthly" ? "+0002.000" : "2.4e1";
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await owner.click(preview);
  await screen.findByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。");
  const collided = previews[0].change.service;
  owner.change(() => screen.getByLabelText(label), { target: { value: "-" } });
  fixture.record = { ...saved, id: collided.id };
  fixture.revision = "collision";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const blockedRestart = await screen.findByRole("button", { name: "使用新标识另建方案" }) as HTMLButtonElement;
  expect(blockedRestart.disabled).toBe(true);
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const restart = await screen.findByRole("button", { name: "使用新标识另建方案" });
  fixture.record = null;
  fixture.revision = "absent-restart";
  await owner.click(() => restart);
  await screen.findByDisplayValue("New cycle plan");
  owner.assertActive();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const copy = screen.getByRole("table", { name: "保留的草稿" });
  expect(within(copy).getByRole("cell", { name: `${raw} ${mode === "monthly" ? "日" : "天"}` })).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "丢弃此草稿副本" }));
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(close).not.toHaveBeenCalled();
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  fixture.conflict = false;
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.id).not.toBe(collided.id);
  expect(previews[1].change.service.cycle[key]).toBe(mode === "monthly" ? 2 : 24);
  expect(previews[1].precondition).toEqual({ exists: false, revision: "absent-restart" });
});


it.each(cases)("retains an inactive unfinished $mode draft through a new-ID restart without blocking the chosen mode", async ({ mode, label, key, correction, corrected }) => {
  const { previews, fixture, saved } = mount(mode, true, { create: true });
  await screen.findByLabelText("服务方案名称");
  owner.change(() => screen.getByLabelText("服务方案名称"), { target: { value: "Inactive cycle draft" } });
  if (mode === "fixed-days") {
    await chooseRule("固定天数周期");
    owner.change(() => screen.getByLabelText(label), { target: { value: "23" } });
  }
  owner.change(() => screen.getByLabelText(label), { target: { value: "1e" } });
  await chooseRule("不自动重置");
  await owner.click(preview);
  await screen.findByText("服务方案已更新。当前草稿尚未保存，请查看最新版本。");
  const collided = previews[0].change.service;
  expect(collided.cycle).toMatchObject({ mode: "none", [key]: mode === "monthly" ? 1 : 23 });
  fixture.record = { ...saved, id: collided.id };
  fixture.revision = "collision";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const restart = await screen.findByRole("button", { name: "使用新标识另建方案" }) as HTMLButtonElement;
  expect(restart.disabled).toBe(false);
  fixture.record = null;
  fixture.revision = "absent-restart";
  await owner.click(() => restart);
  await screen.findByDisplayValue("Inactive cycle draft");
  owner.assertActive();
  expect(screen.queryByLabelText(label)).toBeNull();
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const copy = screen.getByRole("table", { name: "保留的草稿" });
  expect(within(copy).getByRole("cell", { name: `未启用（草稿输入：1e ${mode === "monthly" ? "日" : "天"}（待修正））` })).toBeTruthy();
  await chooseRule(mode === "monthly" ? "每月固定日" : "固定天数周期");
  const control = screen.getByLabelText(label) as HTMLInputElement;
  expect(control.value).toBe("1e");
  await act(async () => { fireEvent.submit(control.closest("form")!); });
  expect(previews).toHaveLength(1);
  owner.change(() => control, { target: { value: correction } });
  fixture.conflict = false;
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.cycle).toMatchObject({ mode, [key]: corrected });
  expect(previews[1].precondition).toEqual({ exists: false, revision: "absent-restart" });
});

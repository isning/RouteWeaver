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
const saved: Service = {
  id: "service-limit-draft", name: "Limit draft plan", quotaBytes: 1073741824,
  routeIds: [], onlineIpLimit: 2, connectionLimit: 10, entryRateBps: 250000,
  cycle: { mode: "none", anchor: "0001-01-01T00:00:00Z", timezone: "UTC+8" },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const editContext = (id: string, value: Service | null, revision: string) => ({
  target: { kind: "service", id }, record: value ? { service: value } : null,
  precondition: { exists: !!value, revision },
});
const reviewed = (before: Service | null, after: Service) => ({
  revision: "reviewed-limits", guard: "opened-record", affected: [], blockers: [],
  resource: { target: { kind: "service", id: after.id }, before: before ? { service: before } : null, after: { service: after } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach((context) => {
  owner = ownedClickScenario(context);
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function mount(initial: Service | null = saved) {
  const onClose = vi.fn();
  const previews: { change: { service: Service }; precondition: { exists: boolean; revision: string } }[] = [];
  const fixture: {
    current: Service | null; revision: string; conflict: boolean;
    nextRead?: Promise<Response>; nextPreview?: Promise<Response>;
  } = { current: initial, revision: "opened-limits", conflict: false };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const read = /^\/api\/access-policy\/edit-context\/service\/([^/]+)$/.exec(String(url));
    if (read && (!initial || read[1] === initial.id) && (!init?.method || init.method === "GET")) {
      const held = fixture.nextRead;
      fixture.nextRead = undefined;
      return held ?? json(editContext(read[1], fixture.current, fixture.revision));
    }
    if (String(url) === "/api/access-policy/preview" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      previews.push(body);
      const held = fixture.nextPreview;
      fixture.nextPreview = undefined;
      return held ?? (fixture.conflict
        ? json({ code: "POLICY_EDIT_BASELINE_CHANGED", detail: "方案已改变" }, 409)
        : json(reviewed(fixture.current, body.change.service)));
    }
    throw new Error("Unexpected service-count fixture request");
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<StrictMode><QueryClientProvider client={client}><UIProviders>
    <ServicePolicyEditor initial={initial} users={[]} services={initial ? [initial] : []} routes={[]} onClose={onClose} />
  </UIProviders></QueryClientProvider></StrictMode>);
  return { previews, onClose, fixture, unmount: view.unmount };
}

const counts = [
  { field: "onlineIpLimit", label: "账号在线 IP 数上限", raw: "-", savedValue: 2 },
  { field: "connectionLimit", label: "账号并发逻辑流数上限", raw: "1e", savedValue: 10 },
] as const;
const limits = () => screen.getByRole("button", { name: "在线、并发与速率限制" });
const preview = () => screen.getByRole("button", { name: "预览影响" });

it.each(counts)("native validity already blocks visible partial $field", async ({ label, raw }) => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  const control = screen.getByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: raw } });
  expect(control.validity.customError).toBe(true);
  expect(control.checkValidity()).toBe(false);
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect(control.value).toBe(raw);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

it.each(counts)("does not preview the old stored $field after collapsing its incomplete raw draft", async ({ label, raw, savedValue }) => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  const control = screen.getByLabelText(label) as HTMLInputElement;
  expect(control.value).toBe(String(savedValue));
  owner.change(() => control, { target: { value: raw } });
  expect(control.checkValidity()).toBe(false);
  await owner.click(preview);
  expect(previews).toEqual([]);
  await owner.click(limits);
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(limits().getAttribute("aria-expanded")).toBe("true");
  const returned = screen.getByLabelText(label) as HTMLInputElement;
  expect(returned.value).toBe(raw);
  await waitFor(() => expect(document.activeElement).toBe(returned));
});

it.each(counts)("retains exact partial $field spelling across collapse and reopen", async ({ label, raw }) => {
  mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await owner.click(limits);
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  await owner.click(limits);
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
});

it.each(counts)("protects a raw-only $field draft on Cancel", async ({ label, raw }) => {
  const { onClose } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  expect(onClose).not.toHaveBeenCalled();
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
});

it.each(counts)("checks raw $field ownership even when native form validity is bypassed", async ({ label, raw }) => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  const control = screen.getByLabelText(label) as HTMLInputElement;
  owner.change(() => control, { target: { value: raw } });
  expect(control.checkValidity()).toBe(false);
  await act(async () => { fireEvent.submit(control.closest("form")!); });
  expect(previews).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

it.each(counts.flatMap(count => ["", "-1", "1.5", "2.000000000000000000001", "9007199254740992"].map(raw => ({ ...count, raw }))))(
  "keeps invalid $field $raw out of requests until an explicit integer correction",
  async ({ field, label, raw }) => {
    const { previews } = mount();
    await screen.findByLabelText("服务方案名称");
    await owner.click(limits);
    const control = screen.getByLabelText(label) as HTMLInputElement;
    owner.change(() => control, { target: { value: raw } });
    await act(async () => { fireEvent.submit(control.closest("form")!); });
    expect(previews).toEqual([]);
    expect(control.value).toBe(raw);
    owner.change(() => control, { target: { value: "+003.000" } });
    expect(control.checkValidity()).toBe(true);
    await owner.click(preview);
    await screen.findByRole("dialog", { name: "确认授权变更" });
    expect(previews).toHaveLength(1);
    expect(previews[0].change.service[field]).toBe(3);
    expect(previews[0].precondition).toEqual({ exists: true, revision: "opened-limits" });
  },
);

it.each(counts.flatMap(count => [
  { raw: "0", expected: 0 }, { raw: "-0e7", expected: 0 },
  { raw: "9.007199254740991e15", expected: 9007199254740991 },
].map(value => ({ ...count, ...value }))))("previews exact $field $raw without rounding", async ({ field, label, raw, expected }) => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service[field]).toBe(expected);
});

it("discards only the selected collapsed count draft and preserves the other raw edit", async () => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(counts[0].label), { target: { value: "3" } });
  owner.change(() => screen.getByLabelText(counts[0].label), { target: { value: "-" } });
  owner.change(() => screen.getByLabelText(counts[1].label), { target: { value: "12" } });
  owner.change(() => screen.getByLabelText(counts[1].label), { target: { value: "1e" } });
  await owner.click(limits);
  await waitFor(() => expect(screen.queryByLabelText(counts[1].label)).toBeNull());
  await owner.click(() => screen.getByRole("button", { name: "放弃输入，保留 IP 上限" }));
  await owner.click(preview);
  expect(previews).toEqual([]);
  expect((screen.getByLabelText(counts[0].label) as HTMLInputElement).value).toBe("3");
  const connection = screen.getByLabelText(counts[1].label) as HTMLInputElement;
  expect(connection.value).toBe("1e");
  await waitFor(() => expect(document.activeElement).toBe(connection));
  await owner.click(() => screen.getByRole("button", { name: "放弃输入，保留并发上限" }));
  expect((screen.getByLabelText(counts[1].label) as HTMLInputElement).value).toBe("12");
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service).toMatchObject({ onlineIpLimit: 3, connectionLimit: 12 });
});

it("starts a reopened editor from saved counts after explicitly discarding the raw draft", async () => {
  const first = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  for (const count of counts)
    owner.change(() => screen.getByLabelText(count.label), { target: { value: count.raw } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(first.onClose).toHaveBeenCalledOnce());
  first.unmount();
  const next = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  for (const count of counts)
    expect((screen.getByLabelText(count.label) as HTMLInputElement).value).toBe(String(count.savedValue));
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(next.previews).toHaveLength(1);
  expect(next.previews[0].change.service).toMatchObject({ onlineIpLimit: 2, connectionLimit: 10 });
});

it.each(counts)("retains incomplete $field in the comparison while latest adoption owns the active count", async ({ field, label, raw }) => {
  const { previews, fixture } = mount();
  await screen.findByLabelText("服务方案名称");
  fixture.conflict = true;
  await owner.click(preview);
  await screen.findByText("方案已改变");
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  fixture.current = { ...saved, name: "Latest saved plan", onlineIpLimit: 5, connectionLimit: 20 };
  fixture.revision = "latest-counts";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() => screen.findByRole("button", { name: "使用最新版本重新编辑" }));
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  await waitFor(() => expect((screen.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("Latest saved plan"));
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const copy = screen.getByRole("table", { name: "保留的草稿" });
  const row = within(copy).getByRole("row", { name: field === "onlineIpLimit" ? /在线 IP 上限/ : /并发逻辑流上限/ });
  expect(within(row).getAllByRole("cell")[1].textContent).toBe(field === "onlineIpLimit" ? "- 个（待修正）" : "1e 条（待修正）");
  await owner.click(limits);
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(String(fixture.current[field]));
  fixture.conflict = false;
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service).toMatchObject({ onlineIpLimit: 5, connectionLimit: 20 });
  expect(previews[1].precondition).toEqual({ exists: true, revision: "latest-counts" });
});

it.each(counts)("invalidates a held latest read after a raw-only $field edit", async ({ label, raw }) => {
  const { fixture } = mount();
  await screen.findByLabelText("服务方案名称");
  fixture.conflict = true;
  await owner.click(preview);
  await screen.findByText("方案已改变");
  await owner.click(limits);
  const held = deferred<Response>();
  fixture.nextRead = held.promise;
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await act(async () => { held.resolve(json(editContext(saved.id, { ...saved, onlineIpLimit: 5, connectionLimit: 20 }, "late-counts"))); });
  expect(screen.queryByRole("button", { name: "使用最新版本重新编辑" })).toBeNull();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
});

it.each(counts)("rejects a held preview after a raw-only $field edit", async ({ label, raw }) => {
  const { previews, fixture } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(limits);
  const held = deferred<Response>();
  fixture.nextPreview = held.promise;
  await owner.click(preview);
  await waitFor(() => expect(previews).toHaveLength(1));
  owner.change(() => screen.getByLabelText(label), { target: { value: raw } });
  await act(async () => { held.resolve(json(reviewed(saved, previews[0].change.service))); });
  await waitFor(() => expect(preview().getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(raw);
});

it("retains valid exact count spelling through a collision restart and separate copy discard", async () => {
  const { previews, fixture, onClose } = mount(null);
  await screen.findByLabelText("服务方案名称");
  owner.change(() => screen.getByLabelText("服务方案名称"), { target: { value: "New count plan" } });
  await owner.click(limits);
  owner.change(() => screen.getByLabelText(counts[0].label), { target: { value: "+003.000" } });
  owner.change(() => screen.getByLabelText(counts[1].label), { target: { value: "1.2e1" } });
  fixture.conflict = true;
  await owner.click(preview);
  await screen.findByText("方案已改变");
  const collided = previews[0].change.service;
  fixture.current = { ...saved, id: collided.id };
  fixture.revision = "collision";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const restart = await screen.findByRole("button", { name: "使用新标识另建方案" });
  fixture.current = null;
  fixture.revision = "absent-restart";
  await owner.click(() => restart);
  await waitFor(() => expect((screen.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("New count plan"));
  await owner.click(limits);
  expect((screen.getByLabelText(counts[0].label) as HTMLInputElement).value).toBe("+003.000");
  expect((screen.getByLabelText(counts[1].label) as HTMLInputElement).value).toBe("1.2e1");
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const copy = screen.getByRole("table", { name: "保留的草稿" });
  expect(within(copy).getByRole("cell", { name: "+003.000 个" })).toBeTruthy();
  expect(within(copy).getByRole("cell", { name: "1.2e1 条" })).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "丢弃此草稿副本" }));
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(onClose).not.toHaveBeenCalled();
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fixture.conflict = false;
  await owner.click(preview);
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.id).not.toBe(collided.id);
  expect(previews[1].change.service).toMatchObject({ onlineIpLimit: 3, connectionLimit: 12 });
  expect(previews[1].precondition).toEqual({ exists: false, revision: "absent-restart" });
});

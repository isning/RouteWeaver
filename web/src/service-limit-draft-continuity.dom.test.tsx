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

function mount(onClose = vi.fn(), initial: Service | null = saved) {
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
    throw new Error("Unexpected service-limit fixture request");
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<StrictMode><QueryClientProvider client={client}><UIProviders>
    <ServicePolicyEditor initial={initial} users={[]} services={initial ? [initial] : []} routes={[]} onClose={onClose} />
  </UIProviders></QueryClientProvider></StrictMode>);
  return { previews, onClose, fixture, unmount: view.unmount };
}

it("does not preview the stored rate for an incomplete rate draft and accepts only the explicit correction", async () => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  const rate = await screen.findByRole("spinbutton", { name: "每个入口限速（Mbps）" });
  expect((rate as HTMLInputElement).value).toBe("2");
  owner.change(() => rate, { target: { value: "-" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  expect(previews).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect((rate as HTMLInputElement).value).toBe("-");
  await screen.findByText("请输入非负 Mbps 数值，需为 0.000008 Mbps 的整数倍且不超过上限");
  owner.change(() => rate, { target: { value: "3" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  await waitFor(() => expect(previews).toHaveLength(1));
  expect(previews[0].change.service.entryRateBps).toBe(375000);
  expect(previews[0].precondition).toEqual({ exists: true, revision: "opened-limits" });
});

it.each(["1e", ".", "-1", "", " 2 ", "0.000001", "2.0000000000000000000001", "72057594037.927936"])(
  "retains invalid rate input %j and rejects direct form submission without falling back to the old rate",
  async (raw) => {
    const { previews } = mount();
    await screen.findByLabelText("服务方案名称");
    await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
    const rate = await screen.findByLabelText("每个入口限速（Mbps）");
    owner.change(() => rate, { target: { value: raw } });
    await act(async () => { fireEvent.submit(rate.closest("form")!); });
    expect(previews).toEqual([]);
    expect((rate as HTMLInputElement).value).toBe(raw);
    await screen.findByText("请输入非负 Mbps 数值，需为 0.000008 Mbps 的整数倍且不超过上限");
  },
);

it("protects a raw-only rate draft on Cancel and preserves it when continuing", async () => {
  const { previews, onClose } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  const rate = await screen.findByLabelText("每个入口限速（Mbps）");
  owner.change(() => rate, { target: { value: "-" } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  expect(onClose).not.toHaveBeenCalled();
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((rate as HTMLInputElement).value).toBe("-");
  expect(previews).toEqual([]);
});

it("starts a reopened editor from the saved rate after explicitly discarding the old draft", async () => {
  const first = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "-" } });
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  await owner.click(() => within(decision).getByRole("button", { name: "放弃修改" }));
  await waitFor(() => expect(first.onClose).toHaveBeenCalledOnce());
  first.unmount();
  const next = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("2");
  expect(screen.queryByRole("button", { name: "放弃本次输入，保留上一个有效限速" })).toBeNull();
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(next.previews).toHaveLength(1);
  expect(next.previews[0].change.service.entryRateBps).toBe(250000);
});

it.each(["preview", "direct submit"])("reveals and focuses an unfinished collapsed rate on %s before allowing correction", async (submission) => {
  const { previews } = mount();
  const name = await screen.findByLabelText("服务方案名称");
  const limits = () => screen.getByRole("button", { name: "在线、并发与速率限制" });
  await owner.click(limits);
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "1e" } });
  await owner.click(limits);
  expect(limits().getAttribute("aria-expanded")).toBe("false");
  if (submission === "preview")
    await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  else
    await act(async () => { fireEvent.submit(name.closest("form")!); });
  expect(previews).toEqual([]);
  expect(screen.getByRole("button", { name: "放弃本次输入，保留上一个有效限速" })).toBeTruthy();
  const returned = await screen.findByLabelText("每个入口限速（Mbps）");
  expect(limits().getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(returned));
  expect((returned as HTMLInputElement).value).toBe("1e");
  owner.change(() => returned, { target: { value: "3" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.entryRateBps).toBe(375000);
});

it("discards a collapsed unfinished rate without requiring the field to be mounted", async () => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  const limits = () => screen.getByRole("button", { name: "在线、并发与速率限制" });
  await owner.click(limits);
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "3" } });
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "1e" } });
  await owner.click(limits);
  await owner.click(() => screen.getByRole("button", { name: "放弃本次输入，保留上一个有效限速" }));
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.entryRateBps).toBe(375000);
});

it("retains a valid rate spelling through accordion remount and discards only a later unfinished input", async () => {
  const { previews } = mount();
  await screen.findByLabelText("服务方案名称");
  const limits = () => screen.getByRole("button", { name: "在线、并发与速率限制" });
  await owner.click(limits);
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "+03.000" } });
  await owner.click(limits);
  await owner.click(limits);
  const rate = await screen.findByLabelText("每个入口限速（Mbps）");
  expect((rate as HTMLInputElement).value).toBe("+03.000");
  owner.change(() => rate, { target: { value: "-" } });
  await owner.click(() => screen.getByRole("button", { name: "放弃本次输入，保留上一个有效限速" }));
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("3");
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.entryRateBps).toBe(375000);
});

it.each([["0.000008", 1], ["1.000032", 125004], ["3e0", 375000], ["72057594037.927928", 9007199254740991], ["0", 0]] as const)(
  "accepts exact fractional Mbps %s as %i whole bytes per second",
  async (raw, bytes) => {
    const { previews } = mount();
    await screen.findByLabelText("服务方案名称");
    await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
    owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: raw } });
    await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
    await screen.findByRole("dialog", { name: "确认授权变更" });
    expect(previews).toHaveLength(1);
    expect(previews[0].change.service.entryRateBps).toBe(bytes);
  },
);

it("does not reconstruct an untouched large stored rate from its rounded Mbps display", async () => {
  const { previews } = mount(undefined, { ...saved, entryRateBps: 9007199254740991 });
  const name = await screen.findByLabelText("服务方案名称");
  owner.change(() => name, { target: { value: "Renamed plan" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(1);
  expect(previews[0].change.service.entryRateBps).toBe(9007199254740991);
});

it.each(["1e", "+03.000", "-0e7"])("retains raw rate %j in the copy while an adopted saved baseline owns the active rate", async (raw) => {
  const { previews, fixture } = mount();
  await screen.findByLabelText("服务方案名称");
  fixture.conflict = true;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText("方案已改变");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: raw } });
  fixture.current = { ...saved, name: "Latest saved plan", entryRateBps: 875000 };
  fixture.revision = "latest-limits";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  await owner.click(() => screen.findByRole("button", { name: "使用最新版本重新编辑" }));
  await owner.click(() => screen.getByRole("button", { name: "使用最新版本" }));
  await waitFor(() => expect((screen.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("Latest saved plan"));
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  const copy = screen.getByRole("table", { name: "保留的草稿" });
  const cells = within(within(copy).getByRole("row", { name: /每个逻辑入口速率/ })).getAllByRole("cell");
  expect(cells[1].textContent).toBe(raw === "1e" ? "1e Mbps（待修正）" : raw === "-0e7" ? "不限制（-0e7 Mbps）" : "+03.000 Mbps（375000 字节/秒）");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("7");
  fixture.conflict = false;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.entryRateBps).toBe(875000);
  expect(previews[1].precondition).toEqual({ exists: true, revision: "latest-limits" });
});

it("invalidates a held latest read when only the raw rate changes", async () => {
  const { fixture, onClose } = mount();
  await screen.findByLabelText("服务方案名称");
  fixture.conflict = true;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText("方案已改变");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  const held = deferred<Response>();
  fixture.nextRead = held.promise;
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "-" } });
  await act(async () => { held.resolve(json(editContext(saved.id, { ...saved, entryRateBps: 875000 }, "late-limits"))); });
  expect(screen.queryByRole("button", { name: "使用最新版本重新编辑" })).toBeNull();
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("-");
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(onClose).not.toHaveBeenCalled();
});

it("rejects a held preview after a raw-only rate change instead of reopening stale review", async () => {
  const { previews, fixture } = mount();
  await screen.findByLabelText("服务方案名称");
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  const held = deferred<Response>();
  fixture.nextPreview = held.promise;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await waitFor(() => expect(previews).toHaveLength(1));
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "1e" } });
  await act(async () => { held.resolve(json(reviewed(saved, previews[0].change.service))); });
  await waitFor(() => expect(screen.getByRole("button", { name: "预览影响" }).getAttribute("aria-busy")).not.toBe("true"));
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("1e");
});

it("retains exact rate spelling and active ownership through a collision restart and copy discard", async () => {
  const { previews, fixture, onClose } = mount(undefined, null);
  const name = await screen.findByLabelText("服务方案名称");
  owner.change(() => name, { target: { value: "New rate plan" } });
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  owner.change(() => screen.getByLabelText("每个入口限速（Mbps）"), { target: { value: "+03.000" } });
  fixture.conflict = true;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByText("方案已改变");
  const collided = previews[0].change.service;
  fixture.current = { ...saved, id: collided.id };
  fixture.revision = "collision";
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const restart = await screen.findByRole("button", { name: "使用新标识另建方案" });
  fixture.current = null;
  fixture.revision = "absent-restart";
  await owner.click(() => restart);
  await waitFor(() => expect((screen.getByLabelText("服务方案名称") as HTMLInputElement).value).toBe("New rate plan"));
  await owner.click(() => screen.getByRole("button", { name: "在线、并发与速率限制" }));
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("+03.000");
  await owner.click(() => screen.getByRole("button", { name: "上一版草稿（未保存）" }));
  await owner.click(() => screen.getByRole("button", { name: "丢弃此草稿副本" }));
  await owner.click(() => screen.getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃尚未保存的授权修改？" });
  expect(onClose).not.toHaveBeenCalled();
  await owner.click(() => within(decision).getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText("每个入口限速（Mbps）") as HTMLInputElement).value).toBe("+03.000");
  fixture.conflict = false;
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  await screen.findByRole("dialog", { name: "确认授权变更" });
  expect(previews).toHaveLength(2);
  expect(previews[1].change.service.id).not.toBe(collided.id);
  expect(previews[1].change.service.entryRateBps).toBe(375000);
  expect(previews[1].precondition).toEqual({ exists: false, revision: "absent-restart" });
});

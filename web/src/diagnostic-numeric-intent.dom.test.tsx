// @vitest-environment jsdom
// Source-only reconstruction. All behavior checks UNRUN; no diagnostic traffic.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionBoundary } from "./SessionBoundary";
import { DiagnosticStartForm } from "./Diagnostics";

const session = { user: { id: "admin-a", role: "admin", name: "Admin" }, csrfToken: "secret-not-for-storage" };
const target = { id: "target", nodeId: "host", name: "Owned target", url: "https://example.test/probe", methods: ["connectivity" as const, "download" as const, "upload" as const] };
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/xray", version: "26.10.31" };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const key = "routeweaver.diagnostic-request.v1.admin-a";
function mount(onCreated = vi.fn()) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <SessionBoundary login={() => <p>Login</p>}>
      <DiagnosticStartForm targets={[target]} instances={[instance]} onClose={() => {}} onCreated={onCreated} />
    </SessionBoundary>
  </QueryClientProvider>);
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function choose(label: string, option: string) {
  fireEvent.click(await screen.findByLabelText(label));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}
async function prepare(kind = "下载测试") {
  await choose("执行实例", "Core");
  await choose("授权目标", "Owned target");
  await choose("测试方式", kind);
}
function intercept() {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url) === "/api/auth/me") return json(session);
    if (init?.method === "POST") { writes.push(JSON.parse(init.body)); throw new TypeError("lost response"); }
    return json({ error: "missing" }, 404);
  }));
  return writes;
}
async function send() {
  await userEvent.click(screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"));
  fireEvent.submit(screen.getByLabelText("最长持续秒数").closest("form")!);
}
it.each([
  ["最长持续秒数", "10.0000000000000000001", 30],
  ["最长持续秒数", "1e", 30], ["最长持续秒数", "", 30],
  ["最长持续秒数", "0", 30], ["最长持续秒数", "31", 30],
  ["最大载荷（KiB）", "1024.00000000000000001", 16384],
  ["最大载荷（KiB）", "1.5", 16384], ["最大载荷（KiB）", "16385", 16384],
  ["最大载荷（KiB）", "1e", 16384], ["最大载荷（KiB）", "", 16384],
])("retains invalid %s intent %s and sends no diagnostic", async (label, raw, max) => {
  const writes = intercept(); mount(); await prepare();
  const input = screen.getByLabelText(String(label)) as HTMLInputElement;
  fireEvent.change(input, { target: { value: raw } });
  await send();
  await screen.findByText(`请输入 1–${max} 之间的整数`);
  expect(input.value).toBe(raw);
  expect(writes).toEqual([]);
  expect(sessionStorage.getItem(key)).toBeNull();
});
it("requires fresh consent after incomplete numeric edits and repairs exact values", async () => {
  const writes = intercept(); mount(); await prepare();
  const consent = screen.getByLabelText("我确认目标与测试上限，提交后由节点执行");
  await userEvent.click(consent);
  fireEvent.change(screen.getByLabelText("最长持续秒数"), { target: { value: "1e" } });
  expect(consent.getAttribute("aria-checked")).toBe("false");
  fireEvent.change(screen.getByLabelText("最长持续秒数"), { target: { value: "3e1" } });
  fireEvent.change(screen.getByLabelText("最大载荷（KiB）"), { target: { value: "16384.000" } });
  await send();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ timeoutSeconds: 30, maxBytes: 16777216, kind: "download" });
});
it("ignores hidden payload for connectivity and restores its raw draft when shown again", async () => {
  const writes = intercept(); mount(); await prepare();
  fireEvent.change(screen.getByLabelText("最大载荷（KiB）"), { target: { value: "1e" } });
  await choose("测试方式", "连通性");
  await choose("测试方式", "下载测试");
  expect((screen.getByLabelText("最大载荷（KiB）") as HTMLInputElement).value).toBe("1e");
  await choose("测试方式", "连通性");
  await send();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ timeoutSeconds: 10, maxBytes: 0, kind: "connectivity" });
});

it.each([
  ["最长持续秒数", "10", "30"],
  ["最大载荷（KiB）", "1024", "16384"],
])("preserves %s spinbutton defaults, bounds and exact fractional keyboard correction", async (label, initial, max) => {
  const writes = intercept(); mount(); await prepare();
  const input = screen.getByRole("spinbutton", { name: label }) as HTMLInputElement;
  expect(input.value).toBe(initial);
  expect(input.getAttribute("min")).toBe("1");
  expect(input.getAttribute("max")).toBe(max);
  expect(input.getAttribute("step")).toBe("1");
  expect(input.getAttribute("aria-valuenow")).toBe(initial);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe(label === "最长持续秒数" ? "11" : "1025");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe(initial);
  for (const [raw, key, expected] of [
    ["", "ArrowUp", "1"], ["", "ArrowDown", "1"],
    ["1", "ArrowDown", "1"], [max, "ArrowUp", max],
    ["10.00000000000000000001", "ArrowDown", "10"],
    ["9.99999999999999999999", "ArrowUp", "10"],
  ]) {
    fireEvent.change(input, { target: { value: raw } });
    expect(input.value).toBe(raw);
    fireEvent.keyDown(input, { key });
    expect(input.value).toBe(expected);
    expect(input.getAttribute("aria-valuenow")).toBe(expected);
  }
  await send();
  await screen.findByRole("button", { name: "核对上次测试提交" });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject(label === "最长持续秒数"
    ? { timeoutSeconds: 10, maxBytes: 1048576 }
    : { timeoutSeconds: 10, maxBytes: 10240 });
});

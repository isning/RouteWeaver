// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { SessionBoundary } from "./SessionBoundary";
import { DiagnosticsPanel } from "./Diagnostics";
import type { DiagnosticJob } from "./diagnostics-model";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const host = { id: "host", name: "Tokyo", address: "example.test" };
const target = { id: "target", nodeId: "host", name: "Owned target", url: "https://example.test/probe", methods: ["connectivity" as const] };
const instance = { id: "core", hostId: "host", name: "Core", adapterId: "routeweaver/xray", version: "26.10.31" };
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function fixture(reconcile = false, reconciledStatus = "succeeded", initialListHangs = false) {
  const pendingRequest = { id: "probe-reconcile", targetId: "target", instanceId: "core", pathMode: "node_direct" as const, kind: "connectivity" as const, maxBytes: 0, timeoutSeconds: 10 };
  const makeReceipt = (request: typeof pendingRequest) => ({ ...request, requestedBy: "admin-a", status: "queued", scope: { nodeId: "host", instanceId: "core" }, target, requestedAt: "2026-11-10T00:00:00Z", expiresAt: "2026-11-10T00:02:00Z", direction: "node_to_target", estimatedMaxBytes: 0, costBasis: "application_payload" });
  let receipt: DiagnosticJob = makeReceipt(pendingRequest);
  if (reconcile) sessionStorage.setItem("routeweaver.diagnostic-request.v1.admin-a", JSON.stringify({ version: 1, actorId: "admin-a", request: pendingRequest }));
  let listReads = 0;
  let failList!: (value: Response) => void;
  let latest: () => Response = () => json([{ ...receipt, status: "succeeded" }]);
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (path === "/api/auth/me") return json({ user: { id: "admin-a", role: "admin", name: "Admin" }, csrfToken: "test" });
    if (path === "/api/admin/diagnostic-targets") return json([target]);
    if (path === "/api/admin/diagnostic-jobs/probe-reconcile") return json({ ...receipt, status: reconciledStatus });
    if (init?.method === "POST") {
      writes.push(path);
      if (path.endsWith("/cancel")) return json({ ...receipt, status: "cancel_requested" });
      receipt = makeReceipt(JSON.parse(init.body));
      return json(receipt);
    }
    if (path === "/api/admin/diagnostic-jobs") {
      listReads++;
      if (listReads === 1 && initialListHangs) return new Promise<Response>((resolve) => { failList = resolve; });
      if (listReads === 1) return json(reconcile ? [receipt] : []);
      if (listReads === 2 && !initialListHangs) return new Promise<Response>((resolve) => { failList = resolve; });
      return latest();
    }
    throw new Error(`Unexpected ${path}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><SessionBoundary login={() => <p>Login</p>}><ConfirmationProvider><DiagnosticsPanel host={host} instances={[instance]} /></ConfirmationProvider></SessionBoundary></QueryClientProvider>);
  return { writes, fail: () => failList(json({ error: "temporary" }, 503)), receipt: () => receipt, settle: (value: unknown) => failList(json(value)), latest: (fn: () => Response) => { latest = fn; } };
}
async function submit() {
  await userEvent.click(await screen.findByRole("button", { name: "新建测试" }));
  for (const [label, option] of [["执行实例", "Core"], ["授权目标", "Owned target"], ["测试方式", "连通性"]]) {
    fireEvent.click(await screen.findByLabelText(label));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }
  await userEvent.click(screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"));
  await userEvent.click(screen.getByRole("button", { name: "提交测试" }));
  return within(await screen.findByRole("dialog", { name: "测试详情" }));
}
it("keeps the accepted receipt through delayed and failed list refresh, then reads the matching result without resubmitting", async () => {
  const f = fixture();
  const details = await submit();
  expect(await details.findByText("等待节点执行")).toBeTruthy();
  expect(details.getByText("Owned target")).toBeTruthy();
  expect(details.getByText("正在核对最新测试状态。以下保留上次确认的记录。")).toBeTruthy();
  f.fail();
  expect(await details.findByText("测试状态刷新失败，以下保留上次确认的记录。")).toBeTruthy();
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  expect(await details.findByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual(["/api/admin/diagnostic-jobs"]);
});

it.each(["missing", "wrong-host", "wrong-target", "wrong-limits"])("keeps the confirmed target and cancellation scope when refresh is %s", async (change) => {
  const f = fixture();
  const details = await submit();
  await details.findByText("等待节点执行");
  f.fail();
  await details.findByText("测试状态刷新失败，以下保留上次确认的记录。");
  f.latest(() => {
    const changed = { ...f.receipt(), status: "succeeded" };
    if (change === "wrong-host") changed.scope = { ...changed.scope, nodeId: "other-host" };
    if (change === "wrong-target") changed.targetId = "other-target";
    if (change === "wrong-limits") changed.maxBytes = 1024;
    return json(change === "missing" ? [] : [changed]);
  });
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。");
  expect(details.getByText("等待节点执行")).toBeTruthy();
  expect(details.queryByText("测试完成")).toBeNull();
  await userEvent.click(details.getByRole("button", { name: "取消测试" }));
  const confirmation = within(await screen.findByRole("alertdialog"));
  expect(confirmation.getByText("取消对「Owned target」的连通性？")).toBeTruthy();
  await userEvent.click(confirmation.getByRole("button", { name: "请求取消" }));
  expect(f.writes).toEqual(["/api/admin/diagnostic-jobs", `/api/admin/diagnostic-jobs/${f.receipt().id}/cancel`]);
  expect(details.queryByText("已取消")).toBeNull();
});

it("retains the latest confirmed terminal result when a later list omits the job", async () => {
  const f = fixture();
  const details = await submit();
  await details.findByText("等待节点执行");
  f.fail();
  await details.findByText("测试状态刷新失败，以下保留上次确认的记录。");
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("测试完成");
  f.latest(() => json([]));
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。");
  expect(details.getByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual(["/api/admin/diagnostic-jobs"]);
});

it("can retry a hanging status read and ignores its late older response", async () => {
  const f = fixture();
  const details = await submit();
  await details.findByText("等待节点执行");
  const refresh = details.getByRole("button", { name: "刷新结果" });
  expect(refresh.getAttribute("aria-disabled")).not.toBe("true");
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(refresh);
  await details.findByText("测试完成");
  // The cancelled query's transport may still settle. It must not replace the
  // newer completed observation or restore a cancellation action.
  await act(async () => {
    f.settle([f.receipt()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(details.getByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(details.queryByText("测试状态刷新失败，以下保留上次确认的记录。")).toBeNull();
  expect(f.writes).toEqual(["/api/admin/diagnostic-jobs"]);
});


it("does not replace a reconciled terminal receipt with older cached or later active list rows", async () => {
  const f = fixture(true);
  await screen.findByText("等待节点执行");
  await userEvent.click(screen.getByRole("button", { name: "新建测试" }));
  await userEvent.click(await screen.findByRole("button", { name: "核对上次测试提交" }));
  const details = within(await screen.findByRole("dialog", { name: "测试详情" }));
  expect(await details.findByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  f.fail();
  await details.findByText("测试状态刷新失败，以下保留上次确认的记录。");
  expect(details.getByText("测试完成")).toBeTruthy();
  f.latest(() => json([{ ...f.receipt(), status: "running" }]));
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。");
  expect(details.getByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual([]);
});


it("keeps a reconciled running receipt newer than the cached queued row while the next read fails", async () => {
  const f = fixture(true, "running");
  await screen.findByText("等待节点执行");
  await userEvent.click(screen.getByRole("button", { name: "新建测试" }));
  await userEvent.click(await screen.findByRole("button", { name: "核对上次测试提交" }));
  const details = within(await screen.findByRole("dialog", { name: "测试详情" }));
  expect(await details.findByText("正在测试")).toBeTruthy();
  expect(details.queryByText("等待节点执行")).toBeNull();
  f.fail();
  await details.findByText("测试状态刷新失败，以下保留上次确认的记录。");
  expect(details.getByText("正在测试")).toBeTruthy();
  expect(f.writes).toEqual([]);
});


it("can recover an accepted job when the initial list read never completed", async () => {
  const f = fixture(false, "succeeded", true);
  const details = await submit();
  await details.findByText("等待节点执行");
  await userEvent.click(details.getByRole("button", { name: "刷新结果" }));
  await details.findByText("测试完成");
  await act(async () => {
    f.settle([f.receipt()]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(details.getByText("测试完成")).toBeTruthy();
  expect(details.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual(["/api/admin/diagnostic-jobs"]);
});

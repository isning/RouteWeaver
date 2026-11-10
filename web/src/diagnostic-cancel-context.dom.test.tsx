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
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmationProvider } from "@/ui-patterns/confirmations";
import { ServersPage } from "./Infrastructure";
import type { AgentState } from "./types";

// Real page/component wiring with controlled HTTP; no real node or cancellation.
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
  history.replaceState(null, "", "#servers");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((media) => ({
      matches: false,
      media,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    })),
  });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixture(
  options: { initial?: string; accepted?: string; rejectFirst?: boolean; refresh?: "failed" | "stale"; wrongReceipt?: boolean; delayCancel?: boolean } = {},
) {
  const target = {
    id: "target-selected",
    name: "Tokyo owned probe",
    nodeId: "host",
    url: "https://probe.example.test/owned",
    methods: ["download"],
  };
  const job = {
    id: "job-selected",
    instanceId: "core",
    targetId: target.id,
    kind: "download",
    maxBytes: 1048576,
    timeoutSeconds: 10,
    scope: { nodeId: "host", instanceId: "core" },
    target,
    requestedAt: "2026-11-02T04:00:00Z",
    expiresAt: "2026-11-02T04:02:00Z",
    direction: "target_to_node",
    estimatedMaxBytes: 1048576,
    costBasis: "application_payload_not_wire_or_provider_billing",
    status: options.initial || "running",
  };
  let releaseCancel!: () => void;
  const writes: string[] = [],
    unexpected: string[] = [];
  const reads: Record<string, unknown> = {
    "/api/hosts": [
      { id: "host", name: "Tokyo", address: "tokyo.example.test" },
    ],
    "/api/core-instances": [
      {
        id: "core",
        hostId: "host",
        name: "Tokyo core",
        adapterId: "routeweaver/xray",
        version: "26.10.31",
      },
    ],
    "/api/managed-endpoints": [],
    "/api/links": [],
    "/api/server-deployments": [],
    "/api/admin/diagnostic-targets": [target],
    "/api/admin/diagnostic-jobs": [job],
    "/api/admin/nodes/host/observability": { config: {} },
    "/api/agent/instances/core/state": {
      instanceId: "core", phase: "unregistered",
    } satisfies AgentState,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      if (method !== "GET") writes.push(`${method} ${path}`);
      if (
        method === "POST" &&
        path === "/api/admin/diagnostic-jobs/job-selected/cancel" &&
        options.accepted
      ) {
        if (options.rejectFirst && writes.length === 1)
          return json({ error: "Cancellation temporarily unavailable" }, 503);
        const acceptedJob = { ...job, status: options.accepted };
        if (options.delayCancel) {
          await new Promise<void>((resolve) => { releaseCancel = resolve; });
          return json(acceptedJob);
        }
        if (!options.refresh && !options.wrongReceipt) job.status = options.accepted;
        return json({ ...job, status: options.accepted, ...(options.wrongReceipt ? { targetId: "different-target" } : {}) });
      }
      if (method === "GET" && path === "/api/admin/diagnostic-jobs" && writes.length && options.refresh === "failed") return json({ error: "List unavailable" }, 503);
      if (method === "GET" && path in reads) return json(reads[path]);
      unexpected.push(`${method} ${path}`);
      return json(
        { error: "Unexpected diagnostic cancellation fixture request" },
        503,
      );
    }),
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        <ServersPage />
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
  return { writes, unexpected, releaseCancel: () => releaseCancel(), recover: (status: string) => { options.refresh = "stale"; job.status = status; } };
}
async function openResult(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Tokyo" }));
  const host = within(await screen.findByRole("region", { name: "Tokyo" }));
  await user.click(host.getByRole("tab", { name: "诊断" }));
  await user.click(host.getByRole("tab", { name: "连接诊断" }));
  await user.click(await host.findByRole("button", { name: "查看测试结果" }));
  return within(await screen.findByRole("dialog", { name: "测试详情" }));
}
it("names the selected diagnostic target and returns exact cancel focus after two no-write dismissals from its server", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const detail = await openResult(user);
  const opener = detail.getByRole("button", { name: "取消测试" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.click(opener);
    const decision = await screen.findByRole("alertdialog");
    expect(decision.textContent).toContain("Tokyo owned probe");
    expect(decision.textContent).toContain("取消请求不等于已停止");
    await user.click(
      within(decision).getByRole("button", { name: "继续测试" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(detail.getByRole("heading", { name: "下载测试 Tokyo owned probe" })).toBeTruthy();
    expect(detail.getByText("正在测试", { exact: true })).toBeTruthy();
    expect(f.writes).toEqual([]);
  }
  expect(f.unexpected).toEqual([]);
});

for (const scenario of [
  { initial: "running", accepted: "cancel_requested", label: "已请求取消" },
  { initial: "queued", accepted: "not_run", label: "未执行" },
]) {
  it(`shows authoritative ${scenario.accepted} after cancellation without inventing a different outcome`, async () => {
    const f = fixture(scenario),
      user = userEvent.setup();
    const detail = await openResult(user);
    await user.click(detail.getByRole("button", { name: "取消测试" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "请求取消",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(
      await detail.findByText(scenario.label, { exact: true }),
    ).toBeTruthy();
    expect(detail.getByRole("heading", { name: "下载测试 Tokyo owned probe" })).toBeTruthy();
    expect(detail.queryByRole("button", { name: "取消测试" })).toBeNull();
    expect(detail.queryByText("测试完成", { exact: true })).toBeNull();
    if (scenario.accepted === "cancel_requested")
      expect(detail.queryByText("已取消", { exact: true })).toBeNull();
    expect(f.writes).toEqual([
      "POST /api/admin/diagnostic-jobs/job-selected/cancel",
    ]);
    expect(f.unexpected).toEqual([]);
  });
}
it("retains the selected running job after rejected cancellation and explicitly retries that same job", async () => {
  const f = fixture({ accepted: "cancel_requested", rejectFirst: true }),
    user = userEvent.setup();
  const detail = await openResult(user);
  const requestCancel = async () => {
    await user.click(detail.getByRole("button", { name: "取消测试" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "请求取消",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  };
  await requestCancel();
  expect(
    await detail.findByText("Cancellation temporarily unavailable"),
  ).toBeTruthy();
  expect(detail.getByRole("heading", { name: "下载测试 Tokyo owned probe" })).toBeTruthy();
  expect(detail.getByText("正在测试", { exact: true })).toBeTruthy();
  expect(detail.queryByText("已取消", { exact: true })).toBeNull();
  await requestCancel();
  expect(await detail.findByText("已请求取消", { exact: true })).toBeTruthy();
  expect(detail.queryByText("Cancellation temporarily unavailable")).toBeNull();
  expect(f.writes).toEqual(
    Array(2).fill("POST /api/admin/diagnostic-jobs/job-selected/cancel"),
  );
  expect(f.unexpected).toEqual([]);
});

it.each([{ accepted: "cancel_requested", label: "已请求取消" }, { accepted: "cancelled", label: "已取消" }, { accepted: "not_run", label: "未执行" }])("retains $accepted when the follow-up list fails without offering another cancellation", async ({ accepted, label }) => {
  const f = fixture({ accepted, refresh: "failed" });
  const user = userEvent.setup();
  const detail = await openResult(user);
  await user.click(detail.getByRole("button", { name: "取消测试" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "请求取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await detail.findByText("测试状态刷新失败，以下保留上次确认的记录。");
  expect(detail.getByText(label, { exact: true })).toBeTruthy();
  expect(detail.queryByRole("button", { name: "取消测试" })).toBeNull();
  if (accepted === "cancel_requested") expect(detail.queryByText("已取消", { exact: true })).toBeNull();
  f.recover(accepted === "not_run" ? "not_run" : "cancelled");
  await user.click(detail.getByRole("button", { name: "刷新结果" }));
  await detail.findByText(accepted === "not_run" ? "未执行" : "已取消", { exact: true });
  expect(f.writes).toEqual(["POST /api/admin/diagnostic-jobs/job-selected/cancel"]);
});

it("keeps cancellation pending across stale reads and dismissal, then retains a completed result", async () => {
  const f = fixture({ accepted: "cancel_requested", refresh: "stale" });
  const user = userEvent.setup();
  let detail = await openResult(user);
  await user.click(detail.getByRole("button", { name: "取消测试" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "请求取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await detail.findByText("最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。");
  expect(detail.getByText("已请求取消", { exact: true })).toBeTruthy();
  expect(detail.queryByRole("button", { name: "取消测试" })).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "测试详情" })).toBeNull());
  await user.click(await screen.findByRole("button", { name: "查看测试结果" }));
  detail = within(await screen.findByRole("dialog", { name: "测试详情" }));
  expect(detail.getByText("已请求取消", { exact: true })).toBeTruthy();
  f.recover("succeeded");
  await user.click(detail.getByRole("button", { name: "刷新结果" }));
  await detail.findByText("测试完成", { exact: true });
  f.recover("running");
  await user.click(detail.getByRole("button", { name: "刷新结果" }));
  await detail.findByText("最新列表尚未确认该次测试的状态，以下保留上次确认的记录。请刷新结果核对。");
  expect(await detail.findByText("测试完成", { exact: true })).toBeTruthy();
  expect(detail.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual(["POST /api/admin/diagnostic-jobs/job-selected/cancel"]);
  expect(f.unexpected).toEqual([]);
});

it("does not adopt a cancellation response for a different diagnostic target", async () => {
  const f = fixture({ accepted: "cancelled", wrongReceipt: true });
  const user = userEvent.setup();
  const detail = await openResult(user);
  await user.click(detail.getByRole("button", { name: "取消测试" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "请求取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await detail.findByText("取消响应与当前测试不匹配。请刷新结果核对。");
  expect(detail.getByText("正在测试", { exact: true })).toBeTruthy();
  expect(detail.getByRole("heading", { name: "下载测试 Tokyo owned probe" })).toBeTruthy();
  expect(detail.queryByText("已取消", { exact: true })).toBeNull();
  expect(f.writes).toEqual(["POST /api/admin/diagnostic-jobs/job-selected/cancel"]);
});

it("does not replace an already observed final result with a delayed cancellation acknowledgement", async () => {
  const f = fixture({ accepted: "cancel_requested", refresh: "failed", delayCancel: true });
  const user = userEvent.setup();
  const detail = await openResult(user);
  await user.click(detail.getByRole("button", { name: "取消测试" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "请求取消" }));
  f.recover("succeeded");
  // A background status read can finish while the cancellation request is pending.
  await act(async () => { await client.refetchQueries({ queryKey: ["diagnostic-jobs"] }); });
  expect(await detail.findByText("测试完成", { exact: true })).toBeTruthy();
  f.recover("running");
  await act(async () => { f.releaseCancel(); });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await detail.findByText("测试完成", { exact: true })).toBeTruthy();
  expect(detail.queryByRole("button", { name: "取消测试" })).toBeNull();
  expect(f.writes).toEqual(["POST /api/admin/diagnostic-jobs/job-selected/cancel"]);
});

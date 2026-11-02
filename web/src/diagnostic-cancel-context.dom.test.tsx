// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
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

// Real page/component wiring with controlled HTTP; no real node or cancellation.
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let client: QueryClient;
beforeEach(() => {
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
  options: { initial?: string; accepted?: string; rejectFirst?: boolean } = {},
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
        job.status = options.accepted;
        return json(job);
      }
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
  return { writes, unexpected };
}
async function openResult(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Tokyo" }));
  const host = within(screen.getByRole("dialog", { name: "Tokyo" }));
  await user.click(host.getByRole("button", { name: "资源、额度与连接诊断" }));
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
    expect(detail.getByText("下载测试 · Tokyo owned probe")).toBeTruthy();
    expect(detail.getByText("正在测试", { exact: true })).toBeTruthy();
    expect(f.writes).toEqual([]);
  }
  expect(f.unexpected).toEqual([]);
});

for (const scenario of [
  { initial: "running", accepted: "cancel_requested", label: "已请求取消" },
  { initial: "queued", accepted: "cancelled", label: "已取消" },
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
    expect(detail.getByText("下载测试 · Tokyo owned probe")).toBeTruthy();
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
  expect(detail.getByText("下载测试 · Tokyo owned probe")).toBeTruthy();
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

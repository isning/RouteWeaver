// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstanceObservation } from "./Infrastructure";
import type { AgentState } from "./types";

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
function response(
  phase: string,
  code?: string,
  recoveryRequired = false,
): AgentState {
  return {
    instanceId: "core",
    phase,
    state: { phase, code, recoveryRequired, nativeChecked: false },
  };
}
function mount(initial: AgentState) {
  let current = initial;
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      requests.push({ url: String(url), method: init?.method || "GET" });
      return new Response(JSON.stringify(current), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InstanceObservation instanceId="core" />
    </QueryClientProvider>,
  );
  return {
    requests,
    update: (next: AgentState) => {
      current = next;
    },
  };
}
it("explains native validation failure and keeps codes in technical details only", async () => {
  mount(response("validation_failed", "native_validation_failed"));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("配置未通过节点检查")).toBeTruthy();
  expect(within(notice).getByText(/编辑转发路径/)).toBeTruthy();
  expect(screen.queryByText("native_validation_failed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "实例技术详情" }));
  expect(
    await screen.findByText(/"code": "native_validation_failed"/),
  ).toBeTruthy();
});
it("treats recoveryRequired as uncertain even when a failure code is retained", async () => {
  const { requests } = mount(
    response("apply_failed", "recovered_not_applied", true),
  );
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("应用结果尚未确认")).toBeTruthy();
  expect(within(notice).getByText(/也不能确认旧配置仍在运行/)).toBeTruthy();
  expect(within(notice).getByText(/结果明确前不要重复应用/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新实例状态" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests).toEqual([
    { url: "/api/agent/instances/core/state", method: "GET" },
    { url: "/api/agent/instances/core/state", method: "GET" },
  ]);
  expect(screen.queryByRole("button", { name: /重试|应用|启动/ })).toBeNull();
});
it.each(["recovered_not_applied", "activation_not_applied"])(
  "explains confirmed nonapplication (%s) without claiming the prior runtime is live",
  async (code) => {
    const data = response("apply_failed", code);
    data.state!.observed = {
      known: true,
      generation: "2",
      evidence: "native-process",
      observedAt: "2026-11-07T00:00:00Z",
    };
    mount(data);
    const notice = await screen.findByLabelText("实例处理建议");
    expect(within(notice).getByText("本次配置未应用")).toBeTruthy();
    expect(
      within(notice).getByText(
        "请返回对应的转发路径，核对配置与节点状态，重新检查并明确确认应用。",
      ),
    ).toBeTruthy();
    expect(notice.textContent).not.toMatch(/旧配置.*运行|回滚成功/);
  },
);
it("distinguishes reported runtime absence from an uncertain outcome", async () => {
  mount(response("apply_failed", "runtime_not_running"));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("节点报告核心未运行")).toBeTruthy();
  expect(within(notice).getByText(/检查并确认新的启动计划/)).toBeTruthy();
});
it("labels an older failure as historical while a newer configuration waits, then clears it on fresh success", async () => {
  const old = response("apply_failed", "recovered_not_applied");
  old.phase = "pending-new-generation";
  old.desired = {
    generation: "4",
    revisionId: "new",
    operationId: "next",
    digest: "new-digest",
  };
  const { update, requests } = mount(old);
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("上次尝试需要处理")).toBeTruthy();
  expect(
    within(notice).getByText("上次记录：节点核对后确认，上次配置未应用。"),
  ).toBeTruthy();
  expect(within(notice).getByText(/不代表这次应用失败/)).toBeTruthy();
  expect(within(notice).queryByText(/重新检查并明确确认应用/)).toBeNull();
  expect(screen.getByText("等待最新配置")).toBeTruthy();
  const fresh = response("observed_conformant");
  fresh.state!.observed = {
    known: true,
    generation: "4",
    evidence: "native-process",
    observedAt: "2026-11-07T01:00:00Z",
  };
  update(fresh);
  fireEvent.click(screen.getByRole("button", { name: "刷新实例状态" }));
  await screen.findByText("已确认生效");
  expect(screen.queryByLabelText("实例处理建议")).toBeNull();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
it("keeps unknown errors honest and directs users to details rather than inventing a cause", async () => {
  mount(response("apply_failed", "future_failure_reason"));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("实例结果需要核对")).toBeTruthy();
  expect(within(notice).getByText(/无法确认本次配置是否应用/)).toBeTruthy();
  expect(within(notice).getByText(/查看实例技术详情/)).toBeTruthy();
  expect(notice.textContent).not.toContain("future_failure_reason");
});
it.each([
  response("accepted", undefined, true),
  response("native_validated", undefined, true),
  response("applying", undefined, true),
  response("applied_unobserved", undefined, true),
  response("installed", "artifact_installed"),
  response("stopped", "local_session_stopped"),
])(
  "does not turn an in-progress or successful record into failure guidance ($phase)",
  async (data) => {
    mount(data);
    await screen.findByText("平台最近记录的实例状态");
    expect(screen.queryByLabelText("实例处理建议")).toBeNull();
  },
);

it("explains a confirmed access restriction without calling the outcome unknown", async () => {
  mount(response("blocked", "policy_restricted"));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("节点已执行访问限制")).toBeTruthy();
  expect(within(notice).getByText(/已确认该实例停止运行/)).toBeTruthy();
  expect(within(notice).getByText(/核对访问授权/)).toBeTruthy();
  expect(notice.textContent).not.toMatch(/尚未识别|无法确认本次配置/);
});
it("shows unresolved recovery even when no code is available", async () => {
  mount(response("unknown", undefined, true));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("应用结果尚未确认")).toBeTruthy();
  expect(within(notice).getByText(/结果明确前不要重复应用/)).toBeTruthy();
});

it("keeps a restriction outcome uncertain when recovery is still required", async () => {
  mount(response("blocked", "policy_restricted", true));
  const notice = await screen.findByLabelText("实例处理建议");
  expect(within(notice).getByText("应用结果尚未确认")).toBeTruthy();
  expect(within(notice).queryByText("节点已执行访问限制")).toBeNull();
});

it("keeps a saved unknown result distinct from refresh progress and refresh failure", async () => {
  const { requests } = mount(response("unknown", "activation_outcome_unknown", true));
  await screen.findByLabelText("实例处理建议");
  expect(screen.getByText("状态尚未确认", { selector: '[data-slot="badge"]' })).toBeTruthy();
  expect(screen.queryByText("正在确认状态")).toBeNull();
  let finishRefresh!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(async (url, init) => {
    requests.push({ url: String(url), method: init?.method || "GET" });
    return new Promise<Response>((resolve) => { finishRefresh = resolve; });
  });
  fireEvent.click(screen.getByRole("button", { name: "刷新实例状态" }));
  await screen.findByText("正在刷新，以下为上次读取的实例记录。");
  expect(screen.getByText("状态尚未确认", { selector: '[data-slot="badge"]' })).toBeTruthy();
  finishRefresh(new Response(JSON.stringify({ detail: "状态读取失败" }), {
    status: 503, headers: { "Content-Type": "application/json" },
  }));
  await screen.findByText("刷新失败，以下为上次读取的实例记录。");
  expect(screen.getByText("状态尚未确认", { selector: '[data-slot="badge"]' })).toBeTruthy();
  expect(screen.queryByText("正在确认状态")).toBeNull();
  expect(screen.queryByText("正在刷新，以下为上次读取的实例记录。")).toBeNull();
  const notice = screen.getByLabelText("实例处理建议");
  expect(within(notice).getByText("应用结果尚未确认")).toBeTruthy();
  expect(within(notice).getByText(/结果明确前不要重复应用/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "刷新实例状态" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /重试|应用|启动/ })).toBeNull();
  expect(requests).toEqual([
    { url: "/api/agent/instances/core/state", method: "GET" },
    { url: "/api/agent/instances/core/state", method: "GET" },
  ]);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { GroupPolicyEditor } from "./GroupPolicyEditor";
import { UIProviders } from "./ui-patterns/providers";
import { installSessionTransport, setCSRF, setToken } from "./api";
import { groupEditFixture } from "./test-support/group-edit-fixture";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { UserGroup } from "./access-policy-model";

const diagnostic = "resource changed; reload and retry";
const recovery = "草稿尚未保存，请核对最新版本。";
const group: UserGroup = { id: "team", name: "远程协作用户组", serviceId: "plan", priority: 10, memberIds: [] };
const plan = { id: "plan", name: "协作方案", quotaBytes: 0, routeIds: [], cycle: { mode: "none", timezone: "UTC+8" } };
const opened = groupEditFixture(group, "opened-team");
const latest = groupEditFixture({ ...group, priority: 11 }, "latest-team");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
const releases: (() => void)[] = [];
let owner: ReturnType<typeof ownedClickScenario>;

beforeEach((context) => {
  owner = ownedClickScenario(context);
  setToken(""); setCSRF("");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup(); releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  setToken(""); setCSRF("");
});

async function rejectedApply(status: number, body: unknown) {
  const writes: { path: string; body: unknown }[] = [];
  let applied = false;
  const closed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/access-policy/edit-context/group/team")
      return json(applied ? latest.context() : opened.context());
    const submitted = JSON.parse(String(init?.body));
    writes.push({ path: url, body: submitted });
    if (url === "/api/access-policy/preview")
      return json(opened.preview(submitted.change.group, { revision: "review-team", affected: [], blockers: [] }));
    if (url === "/api/access-policy/apply") {
      applied = true;
      return json(body, status);
    }
    throw new Error(`Unexpected synthetic policy request: ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<StrictMode><QueryClientProvider client={client}><UIProviders>
    <GroupPolicyEditor initial={group} users={[]} services={[plan]} routes={[]} onClose={closed} />
  </UIProviders></QueryClientProvider></StrictMode>);
  const name = await screen.findByLabelText("用户组名称") as HTMLInputElement;
  owner.change(() => name, { target: { value: "保留的用户组草稿" } });
  await owner.click(() => screen.getByRole("button", { name: "预览影响" }));
  const review = within(await screen.findByRole("dialog", { name: "确认授权变更" }));
  await owner.click(() => review.getByRole("checkbox", { name: "我已核对本次授权变更" }));
  await owner.click(() => review.getByRole("button", { name: "更新授权" }));
  return { writes, name, closed };
}

it("replaces only the known group stale-apply reload advice with one retained-draft recovery and an optional exact diagnostic", async () => {
  const t = await rejectedApply(409, { detail: diagnostic });
  const summary = await screen.findByRole("group", { name: "操作未完成", description: recovery });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
  expect(t.name.value).toBe("保留的用户组草稿");
  expect(screen.getAllByText(recovery)).toHaveLength(1);
  const details = within(summary).getByText("查看技术详情").closest("details")!;
  expect(details.open).toBe(false);
  expect(within(details).getByText(diagnostic).textContent).toBe(diagnostic);
  await owner.click(() => within(summary).getByText("查看技术详情"));
  expect(details.open).toBe(true);
  expect(t.closed).not.toHaveBeenCalled();
  expect(t.writes).toHaveLength(2);
  expect(t.writes[1]).toEqual({ path: "/api/access-policy/apply", body: {
    change: { group: { ...group, name: "保留的用户组草稿" } }, revision: "review-team",
  } });
  await owner.click(() => screen.getByRole("button", { name: "查看最新版本" }));
  const comparison = within(await screen.findByRole("table", { name: "已保存的用户组变化" }));
  expect(comparison.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["10", "11"]);
  expect(t.name.value).toBe("保留的用户组草稿");
  expect(t.writes).toHaveLength(2);
  owner.change(() => t.name, { target: { value: "继续修改草稿" } });
  expect(screen.queryByText("查看技术详情")).toBeNull();
  expect(screen.queryByText(diagnostic)).toBeNull();
  expect(screen.getAllByText(recovery)).toHaveLength(1);
  expect(t.writes).toHaveLength(2);
});

it.each([
  [401, { detail: diagnostic }, diagnostic],
  [403, { detail: diagnostic }, diagnostic],
  [400, { detail: diagnostic }, diagnostic],
  [503, { detail: diagnostic }, diagnostic],
  [409, { detail: "另一个冲突原因" }, "另一个冲突原因"],
  [409, { detail: `${diagnostic}; additional failure` }, `${diagnostic}; additional failure`],
  [409, { error: diagnostic }, diagnostic],
  [409, { detail: diagnostic, code: "OTHER_CONFLICT" }, diagnostic],
] as const)("keeps status %s and nonmatching error envelope %j visible without rewriting it", async (status, body, message) => {
  const authFailure = vi.fn();
  releases.push(installSessionTransport({ beforeRequest: () => ({ beforeSend() {}, waitForResponse: async () => {} }), failed: authFailure }));
  const t = await rejectedApply(status, body);
  const summary = await screen.findByRole("group", { name: "操作未完成", description: message });
  expect(within(summary).getByText(message)).toBeTruthy();
  expect(screen.queryByText("查看技术详情")).toBeNull();
  expect(t.name.value).toBe("保留的用户组草稿");
  expect(t.closed).not.toHaveBeenCalled();
  expect(t.writes).toHaveLength(2);
  if (status === 401 || status === 403)
    expect(authFailure).toHaveBeenCalledWith(expect.objectContaining({ status }));
  else await waitFor(() => expect(document.activeElement).toBe(summary));
});

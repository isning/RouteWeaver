// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServerRoutesPage } from "./ServerRoutes";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import type { ServerDeployment, Validation } from "./types";

const missingPrincipals =
  "MANAGED_PRINCIPALS_REQUIRED: authenticated VLESS principals required";
const clients: QueryClient[] = [];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#routes");
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  history.replaceState(null, "", "#routes");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup({
  diagnostics = [missingPrincipals],
  validation,
  change,
}: {
  diagnostics?: string[];
  validation?: Validation;
  change?: (deployment: ServerDeployment) => void;
} = {}) {
  const deployment: ServerDeployment = {
    id: "first-path",
    name: "首次配置转发路径",
    revisionToken: "first-path-revision",
    status: "draft",
    diagnostics,
    ir: {
      schemaVersion: "1.0",
      id: "first-path",
      topologyRevision: "first-topology",
      programs: [{
        instance: {
          id: "managed-core",
          hostId: "first-host",
          name: "首次配置受管核心",
          adapterId: "routeweaver/managed-xray",
          version: "26.3.27-rw1",
        },
        listener: {
          id: "first-listener",
          instanceId: "managed-core",
          name: "首次配置用户入口",
          authentication: "principals",
          connection: { protocol: "vless", host: "0.0.0.0", port: 1443 },
        },
        egress: [],
        rules: [],
        resources: [],
        defaultAction: { kind: "direct" },
      }],
    },
  };
  change?.(deployment);
  const mutations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
    const path = String(url);
    if (init?.method && init.method !== "GET") mutations.push(`${init.method} ${path}`);
    let data: unknown = [];
    if (path.endsWith("/hosts"))
      data = [{ id: "first-host", name: "首次配置服务器", address: "example.invalid" }];
    else if (path.endsWith("/core-instances"))
      data = deployment.ir.programs.map((program) => program.instance);
    else if (path.endsWith("/managed-endpoints"))
      data = deployment.ir.programs.map((program) => program.listener);
    else if (path.endsWith("/server-deployments")) data = [deployment];
    else if (path.endsWith("/first-path/validate")) data = validation;
    else if (path.endsWith("/state")) data = { instanceId: "managed-core", phase: "unregistered" };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><ServerRoutesPage /></UIProviders></QueryClientProvider>);
  return mutations;
}

it("guides a saved empty managed entry to public lines without editing or applying it", async (context) => {
  const owner = ownedClickScenario(context);
  const mutations = setup();
  await owner.click(() => screen.findByRole("button", { name: "首次配置转发路径", exact: true }));
  const detail = within(screen.getByRole("dialog", { name: "首次配置转发路径" }));
  expect(detail.getByText("草稿缺少可用用户入口", { exact: true })).toBeTruthy();
  expect(detail.getByText("草稿已保存，当前不能应用。", { exact: true })).toBeTruthy();
  expect(detail.getByText(/选择使用「首次配置转发路径」的公开线路/)).toBeTruthy();
  expect(detail.getByText(/核对「用户授权」和「独立入口与运行确认」/)).toBeTruthy();
  expect(detail.getByText(/返回重新检查/)).toBeTruthy();
  expect(detail.queryByRole("button", { name: "编辑并修复" })).toBeNull();
  expect(detail.queryByRole("button", { name: "确认并应用" })).toBeNull();
  expect(detail.queryByText(missingPrincipals)).toBeNull();
  await owner.click(() => detail.getByRole("button", { name: "技术详情" }));
  expect(detail.getByText(missingPrincipals)).toBeTruthy();
  const next = detail.getByRole("link", { name: "前往线路", exact: true });
  expect(next.getAttribute("href")).toBe("#published-routes");
  await owner.click(() => next);
  await waitFor(() => expect(location.hash).toBe("#published-routes"));
  owner.assertActive();
  expect(mutations).toEqual([]);
});

it("keeps a known line and user context when returning to inspect existing entries", async (context) => {
  const owner = ownedClickScenario(context);
  const href = "#published-routes?line=existing-line&user=alice";
  history.replaceState(null, "", "#routes?deployment=first-path&line=existing-line&user=alice");
  const mutations = setup();
  const detail = within(await screen.findByRole("dialog", { name: "首次配置转发路径" }));
  owner.assertActive();
  expect(detail.getByRole("link", { name: "前往线路", exact: true }).getAttribute("href")).toBe(href);
  expect(detail.queryByRole("button", { name: "创建用户入口" })).toBeNull();
  await owner.click(() => detail.getByRole("link", { name: "前往线路", exact: true }));
  await waitFor(() => expect(location.hash).toBe(href));
  owner.assertActive();
  expect(mutations).toEqual([]);
});

it("offers the same recovery after a fresh failed check without application consent", async (context) => {
  const owner = ownedClickScenario(context);
  const mutations = setup({
    diagnostics: [],
    validation: { valid: false, diagnostics: [missingPrincipals], artifacts: [] },
  });
  await owner.click(() => screen.findByRole("button", { name: "首次配置转发路径", exact: true }));
  await owner.click(() => screen.getByRole("button", { name: "查看修改并应用", exact: true }));
  const review = within(await screen.findByRole("dialog", { name: "应用转发路径修改" }));
  owner.assertActive();
  expect(review.getByText("草稿缺少可用用户入口", { exact: true })).toBeTruthy();
  expect(review.getByRole("link", { name: "前往线路", exact: true }).getAttribute("href")).toBe("#published-routes");
  expect(review.queryByRole("button", { name: "编辑并修复" })).toBeNull();
  expect(review.queryByRole("checkbox")).toBeNull();
  expect(review.queryByRole("button", { name: "确认并应用" })).toBeNull();
  expect(review.queryByText(missingPrincipals)).toBeNull();
  await owner.click(() => review.getByRole("button", { name: "技术详情" }));
  expect(review.getByText(missingPrincipals)).toBeTruthy();
  await owner.click(() => review.getByRole("button", { name: "返回", exact: true }));
  const detail = within(await screen.findByRole("dialog", { name: "首次配置转发路径" }));
  owner.assertActive();
  expect(detail.getByRole("link", { name: "前往线路", exact: true })).toBeTruthy();
  expect(mutations).toEqual(["POST /api/server-deployments/first-path/validate"]);
});

it("keeps repair priority and distinct failures when the missing entry is not the only diagnostic", async (context) => {
  const owner = ownedClickScenario(context);
  const tls = "programs[0].tls: TLS certificate and private key do not form a valid matching pair";
  const unknown = "SERVER_NEW_POLICY: additional configuration required";
  const mutations = setup({ diagnostics: [missingPrincipals, tls, unknown] });
  await owner.click(() => screen.findByRole("button", { name: "首次配置转发路径", exact: true }));
  const detail = within(screen.getByRole("dialog", { name: "首次配置转发路径" }));
  expect(detail.getByText("草稿需要调整", { exact: true })).toBeTruthy();
  expect(detail.getByText("草稿缺少可用用户入口。", { exact: true })).toBeTruthy();
  expect(detail.getByText(/的 TLS 设置未通过检查/)).toBeTruthy();
  expect(detail.getByText(unknown)).toBeTruthy();
  expect(detail.getByRole("button", { name: "编辑并修复", exact: true })).toBeTruthy();
  expect(detail.getByRole("link", { name: "前往线路", exact: true })).toBeTruthy();
  expect(detail.queryByText(missingPrincipals)).toBeNull();
  await owner.click(() => detail.getByRole("button", { name: "技术详情" }));
  expect(detail.getByText(missingPrincipals)).toBeTruthy();
  expect(detail.getByText(tls)).toBeTruthy();
  expect(mutations).toEqual([]);
});

const unknownCases: {
  name: string;
  diagnostics?: string[];
  change?: (deployment: ServerDeployment) => void;
}[] = [
  { name: "a similar code prefix", diagnostics: ["MANAGED_PRINCIPALS_REQUIRED_NEW: authenticated VLESS principals required"] },
  { name: "a different message for the same code", diagnostics: ["MANAGED_PRINCIPALS_REQUIRED: additional configuration required"] },
  { name: "an embedded known diagnostic", diagnostics: [`upstream validation failed: ${missingPrincipals}`] },
  { name: "a non-VLESS listener", change: (draft) => { draft.ir.programs[0].listener.connection.protocol = "socks"; } },
  { name: "a different adapter", change: (draft) => { draft.ir.programs[0].instance.adapterId = "routeweaver/xray"; } },
  { name: "an unrecognized managed version", change: (draft) => { draft.ir.programs[0].instance.version = "future-version"; } },
  { name: "a non-principal listener", change: (draft) => { delete draft.ir.programs[0].listener.authentication; } },
  { name: "an already populated principal snapshot", change: (draft) => {
    draft.ir.programs[0].principals = [{
      subjectId: "existing-subject", accountId: "alice", routeId: "existing-line",
      credentialVersion: "v1", credential: { uuid: "" }, action: { kind: "direct" },
    }];
  } },
  { name: "multiple programs without a known single-entry recovery", change: (draft) => {
    draft.ir.programs.push({
      ...draft.ir.programs[0],
      instance: { ...draft.ir.programs[0].instance, id: "second-core" },
      listener: { ...draft.ir.programs[0].listener, id: "second-listener", instanceId: "second-core" },
    });
  } },
];

it.for(unknownCases)("does not guess entry setup for $name", async ({ diagnostics, change }, context) => {
  const owner = ownedClickScenario(context);
  const expected = diagnostics || [missingPrincipals];
  const mutations = setup({ diagnostics: expected, change });
  await owner.click(() => screen.findByRole("button", { name: "首次配置转发路径", exact: true }));
  const detail = within(screen.getByRole("dialog", { name: "首次配置转发路径" }));
  expect(detail.getByText("草稿需要调整", { exact: true })).toBeTruthy();
  for (const diagnostic of expected) expect(detail.getByText(diagnostic)).toBeTruthy();
  expect(detail.queryByText("草稿缺少可用用户入口", { exact: true })).toBeNull();
  expect(detail.queryByRole("link", { name: "前往线路", exact: true })).toBeNull();
  expect(detail.getByRole("button", { name: "编辑并修复", exact: true })).toBeTruthy();
  expect(mutations).toEqual([]);
});

it("clears old entry guidance after a successful server recheck without applying", async (context) => {
  const owner = ownedClickScenario(context);
  const mutations = setup({ validation: { valid: true, diagnostics: [], artifacts: [], fingerprint: "checked-first-path" } });
  await owner.click(() => screen.findByRole("button", { name: "首次配置转发路径", exact: true }));
  await owner.click(() => screen.getByRole("button", { name: "重新检查", exact: true }));
  const review = within(await screen.findByRole("dialog", { name: "应用转发路径修改" }));
  owner.assertActive();
  expect(review.queryByText("草稿缺少可用用户入口", { exact: true })).toBeNull();
  expect(review.queryByRole("link", { name: "前往线路", exact: true })).toBeNull();
  expect(review.getByRole("checkbox", { name: "确认允许此转发路径提供访问" }).getAttribute("aria-checked")).toBe("false");
  expect((review.getByRole("button", { name: "确认并应用", exact: true }) as HTMLButtonElement).disabled).toBe(true);
  expect(mutations).toEqual(["POST /api/server-deployments/first-path/validate"]);
});

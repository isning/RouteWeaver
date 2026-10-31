import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { VerifiedPublicationRoutes } from "../tests/publication-owner.fixture";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import type { ServerDeployment, Validation } from "./types";

type ScenarioOwner = ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];

const tlsDiagnostic =
  "programs[0].tls: TLS listener needs server certificate or REALITY material";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  sessionStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const originalStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    originalStyle(element),
  );
});

afterEach(() => {
  sessionStorage.clear();
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(
  owner: ScenarioOwner,
  diagnostics: string[],
  validation?: Validation,
  onPublish?: (body: unknown) => Promise<Response>,
  includeOther = false,
) {
  owner.assertActive();
  const instance = {
    id: "core",
    hostId: "host",
    adapterId: "routeweaver/xray",
    version: "26.9.28",
  };
  const listener = {
    id: "entry",
    name: "Tokyo entry",
    instanceId: "core",
    connection: {
      protocol: "vless",
      host: "0.0.0.0",
      port: 443,
      tls: { enabled: true },
    },
  };
  const deployment: ServerDeployment = {
    revisionToken: "opened-office-revision",
    id: "office",
    name: "Office path",
    status: "draft",
    diagnostics,
    ir: {
      schemaVersion: "1.0",
      id: "office",
      topologyRevision: "v1",
      programs: [{ instance, listener, egress: [], rules: [], resources: [] }],
    },
  };
  const requests: string[] = [];
  owner.assertActive();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      requests.push(path);
      if (path.endsWith("/office/publish") && onPublish)
        return onPublish(JSON.parse(String(init?.body)));
      let data: unknown = [];
      if (path.endsWith("/hosts"))
        data = [{ id: "host", name: "Tokyo", address: "tokyo.example" }];
      else if (path.endsWith("/core-instances")) data = [instance];
      else if (path.endsWith("/managed-endpoints")) data = [listener];
      else if (path.endsWith("/server-deployments"))
        data = includeOther
          ? [deployment, { ...deployment, id: "other", name: "Other path" }]
          : [deployment];
      else if (path.endsWith("/office/reveal")) data = deployment;
      else if (path.endsWith("/office/validate")) data = validation;
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  owner.assertActive();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  owner.assertActive();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <VerifiedPublicationRoutes />
      </UIProviders>
    </QueryClientProvider>,
  );
  return requests;
}

it("guides a saved TLS-invalid draft to repair and keeps the exact diagnostic available", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const user = userEvent.setup();
  const requests = setup(owner, [tlsDiagnostic]);
  const pathName = await screen.findByRole("button", { name: "Office path" });
  owner.assertActive();
  expect(screen.queryByRole("button", { name: "查看转发路径" })).toBeNull();
  owner.assertActive();
  await user.click(pathName);
  owner.assertActive();
  const detail = screen.getByRole("dialog", { name: "Office path" });
  expect(
    within(detail).getByText(
      "第 1 段（Tokyo entry）的 TLS 设置未通过检查。请编辑转发路径，检查「TLS 证书与安全参数」。",
    ),
  ).toBeTruthy();
  expect(
    within(detail).queryByRole("button", { name: "查看修改并应用" }),
  ).toBeNull();
  expect(within(detail).queryByText(tlsDiagnostic)).toBeNull();
  owner.assertActive();
  await user.click(within(detail).getByRole("button", { name: "技术详情" }));
  owner.assertActive();
  expect(within(detail).getByText(tlsDiagnostic)).toBeTruthy();
  owner.assertActive();
  await user.click(within(detail).getByRole("button", { name: "编辑并修复" }));
  owner.assertActive();
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Office path",
  });
  owner.assertActive();
  expect(
    (
      within(editor).getByRole("textbox", {
        name: "转发路径名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Office path");
  expect(requests.some((path) => /\/(validate|publish)$/.test(path))).toBe(
    false,
  );
});

it("makes a fresh validation failure actionable without offering application consent", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const user = userEvent.setup();
  const diagnostic =
    "programs[0].tls: TLS certificate and private key do not form a valid matching pair";
  const requests = setup(owner, [], {
    valid: false,
    diagnostics: [diagnostic],
    artifacts: [],
  });
  const pathName = await screen.findByRole("button", { name: "Office path" });
  owner.assertActive();
  await user.click(pathName);
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "查看修改并应用" }));
  owner.assertActive();
  const reviewTitle = await screen.findByText("应用转发路径修改");
  owner.assertActive();
  const review = reviewTitle.closest('[role="dialog"]') as HTMLElement;
  expect(
    within(review).getByText(
      "第 1 段（Tokyo entry）的 TLS 设置未通过检查。请编辑转发路径，检查「TLS 证书与安全参数」。",
    ),
  ).toBeTruthy();
  expect(within(review).queryByRole("checkbox")).toBeNull();
  expect(
    within(review).queryByRole("button", { name: "确认并应用" }),
  ).toBeNull();
  owner.assertActive();
  await user.click(within(review).getByRole("button", { name: "技术详情" }));
  owner.assertActive();
  expect(within(review).getByText(diagnostic)).toBeTruthy();
  owner.assertActive();
  await user.click(within(review).getByRole("button", { name: "编辑并修复" }));
  owner.assertActive();
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Office path",
  });
  owner.assertActive();
  expect(editor).toBeTruthy();
  expect(requests.some((path) => path.endsWith("/office/validate"))).toBe(true);
  expect(requests.some((path) => path.endsWith("/publish"))).toBe(false);
});

it("keeps unknown failures and unmatched field paths visible instead of guessing their cause", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const diagnostics = [
    "SERVER_NEW_POLICY: programs[0].tls requires additional configuration",
    "programs[9].tls: listener not found",
    "Runtime validation service unavailable",
  ];
  setup(owner, diagnostics);
  const pathName = await screen.findByRole("button", { name: "Office path" });
  owner.assertActive();
  await userEvent.click(pathName);
  owner.assertActive();
  const detail = screen.getByRole("dialog", { name: "Office path" });
  for (const diagnostic of diagnostics)
    expect(within(detail).getByText(diagnostic)).toBeTruthy();
  expect(within(detail).queryByText(/的 TLS 设置未通过检查/)).toBeNull();
  expect(
    within(detail).getByRole("button", { name: "编辑并修复" }),
  ).toBeTruthy();
});

it("lets a successful server recheck clear stale diagnostics while preserving application consent and fingerprint", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const user = userEvent.setup();
  setup(owner, [tlsDiagnostic], {
    valid: true,
    diagnostics: [],
    artifacts: [],
    fingerprint: "d".repeat(64),
  });
  const pathName = await screen.findByRole("button", { name: "Office path" });
  owner.assertActive();
  await user.click(pathName);
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "重新检查" }));
  owner.assertActive();
  const reviewTitle = await screen.findByText("应用转发路径修改");
  owner.assertActive();
  const review = reviewTitle.closest('[role="dialog"]') as HTMLElement;
  expect(within(review).getByText("将更新 1 个核心实例")).toBeTruthy();
  expect(screen.queryByText("草稿需要调整")).toBeNull();
  const apply = within(review).getByRole("button", {
    name: "确认并应用",
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  owner.assertActive();
  await user.click(
    within(review).getByRole("checkbox", {
      name: "确认允许此转发路径提供访问",
    }),
  );
  owner.assertActive();
  expect(apply.disabled).toBe(true);
  owner.assertActive();
  await user.click(
    within(review).getByRole("checkbox", {
      name: "已确认目标实例可执行当前额度策略",
    }),
  );
  owner.assertActive();
  expect(apply.disabled).toBe(false);
  owner.assertActive();
  await user.click(apply);
  owner.assertActive();
  await waitFor(() => {
    const request = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith("/office/publish"));
    expect(request?.[1]?.method).toBe("POST");
    expect(JSON.parse(request?.[1]?.body as string)).toEqual({
      operationId: expect.stringMatching(/^publication_[a-z0-9]+$/),
      leaseSeconds: 300,
      accessAllowed: true,
      quotaCertain: true,
      expectedFingerprint: "d".repeat(64),
    });
  });
  owner.assertActive();
});

async function consentToPublication(owner: ScenarioOwner) {
  owner.assertActive();
  const user = userEvent.setup();
  const pathName = await screen.findByRole("button", { name: "Office path" });
  owner.assertActive();
  await user.click(pathName);
  owner.assertActive();
  await user.click(screen.getByRole("button", { name: "查看修改并应用" }));
  owner.assertActive();
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  owner.assertActive();
  await user.click(
    within(review).getByRole("checkbox", {
      name: "确认允许此转发路径提供访问",
    }),
  );
  owner.assertActive();
  await user.click(
    within(review).getByRole("checkbox", {
      name: "已确认目标实例可执行当前额度策略",
    }),
  );
  owner.assertActive();
  return {
    user,
    review,
    apply: within(review).getByRole("button", { name: "确认并应用" }),
  };
}
it("persists the exact command before first send and coalesces rapid activation into one unknown operation", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const sent: unknown[] = [];
  setup(
    owner,
    [],
    {
      valid: true,
      diagnostics: [],
      artifacts: [],
      fingerprint: "d".repeat(64),
    },
    async (body) => {
      const stored = JSON.parse(
        sessionStorage.getItem("routeweaver.publication-request.v1")!,
      );
      expect(body).toEqual({
        operationId: stored.operationId,
        ...stored.request,
      });
      sent.push(body);
      throw new TypeError("synthetic lost response");
    },
  );
  owner.assertActive();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const originalRects = HTMLElement.prototype.getClientRects;
  owner.assertActive();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute("aria-label") === "查询提交结果"
        ? ([new DOMRect(0, 0, 120, 44)] as unknown as DOMRectList)
        : originalRects.call(this);
    },
  );
  const { apply, user, review } = await consentToPublication(owner);
  owner.assertActive();
  fireEvent.click(apply);
  owner.assertActive();
  fireEvent.click(apply);
  await waitFor(() => expect(sent).toHaveLength(1));
  owner.assertActive();
  const unknownNotice = await within(review).findByText("提交结果待确认", {
    exact: true,
  });
  owner.assertActive();
  expect(unknownNotice).toBeTruthy();
  const frozen = sessionStorage.getItem("routeweaver.publication-request.v1");
  owner.assertActive();
  await user.click(within(review).getByRole("button", { name: "关闭" }));
  owner.assertActive();
  const recovery = await screen.findByRole("button", { name: "查询提交结果" });
  owner.assertActive();
  await waitFor(() => expect(document.activeElement).toBe(recovery));
  owner.assertActive();
  expect(sessionStorage.getItem("routeweaver.publication-request.v1")).toBe(
    frozen,
  );
  expect(sent).toHaveLength(1);
});
it("does not send when the first recovery-envelope write fails", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const requests = setup(owner, [], {
    valid: true,
    diagnostics: [],
    artifacts: [],
    fingerprint: "d".repeat(64),
  });
  const { apply, user } = await consentToPublication(owner);
  owner.assertActive();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  owner.assertActive();
  await user.click(apply);
  owner.assertActive();
  const storageNotice = await screen.findByText(
    "无法保存本页提交记录，尚未发送。请允许浏览器保存会话记录后重试。",
    { exact: true },
  );
  owner.assertActive();
  expect(storageNotice).toBeTruthy();
  expect(requests.filter((path) => path.endsWith("/publish"))).toHaveLength(0);
});

it("makes an adopted current receipt secondary and requires fresh review, without demoting another path", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const requests = setup(
    owner,
    [],
    {
      valid: true,
      diagnostics: [],
      artifacts: [],
      fingerprint: "d".repeat(64),
    },
    async (body) => {
      const command = body as { operationId: string };
      return new Response(
        JSON.stringify({
          operationId: command.operationId,
          deploymentId: "office",
          status: "publication-accepted",
          nativeChecked: false,
          instances: [
            {
              instanceId: "core",
              generation: "1",
              operationId: "agent-operation",
              revisionId: "revision",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
    true,
  );
  const { user, apply } = await consentToPublication(owner);
  owner.assertActive();
  await user.click(apply);
  owner.assertActive();
  const again = await screen.findByRole("button", { name: "再次检查并应用" });
  owner.assertActive();
  expect(again.getAttribute("data-variant")).toBe("outline");
  expect(screen.queryByRole("button", { name: "查看修改并应用" })).toBeNull();
  owner.assertActive();
  await user.click(again);
  owner.assertActive();
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  owner.assertActive();
  expect(
    requests.filter((path) => path.endsWith("/office/validate")),
  ).toHaveLength(2);
  expect(
    (
      within(review).getByRole("checkbox", {
        name: "确认允许此转发路径提供访问",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      within(review).getByRole("checkbox", {
        name: "已确认目标实例可执行当前额度策略",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    (
      within(review).getByRole("button", {
        name: "确认并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  owner.assertActive();
  await user.click(within(review).getByRole("button", { name: "关闭" }));
  owner.assertActive();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "应用转发路径修改" }),
    ).toBeNull(),
  );
  owner.assertActive();
  const detail = screen.getByRole("dialog", { name: "Office path" });
  owner.assertActive();
  await user.click(within(detail).getByRole("button", { name: "关闭" }));
  owner.assertActive();
  const otherPathName = await screen.findByRole("button", {
    name: "Other path",
  });
  owner.assertActive();
  await user.click(otherPathName);
  owner.assertActive();
  const other = screen.getByRole("dialog", { name: "Other path" });
  expect(
    within(other)
      .getByRole("button", { name: "查看修改并应用" })
      .getAttribute("data-variant"),
  ).toBe("default");
  expect(
    within(other).queryByRole("button", { name: "再次检查并应用" }),
  ).toBeNull();
});

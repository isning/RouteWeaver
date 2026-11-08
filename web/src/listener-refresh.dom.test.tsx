// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServerRoutesPage } from "./ServerRoutes";
import { VerifiedPublicationRoutes } from "../tests/publication-owner.fixture";
import type { ServerDeployment } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    original(element),
  );
});
afterEach(() => {
  cleanup();
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function updateListener(
  user: ReturnType<typeof userEvent.setup>,
  review: HTMLElement,
  owner?: ReturnType<typeof ownedClickScenario>,
) {
  owner?.assertActive();
  const button = within(review).getByRole("button", { name: "更新到草稿" });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  owner?.assertActive();
  await user.click(button);
  owner?.assertActive();
}

function setupRefresh(
  change?: (draft: ServerDeployment) => void,
  publicationDrift = false,
) {
  const hosts = ["fra", "uk"].map((id) => ({
    id,
    name: id.toUpperCase(),
    address: `${id}.example.invalid`,
  }));
  const instances = hosts.map((host) => ({
    id: `${host.id}-core`,
    hostId: host.id,
    name: `${host.name} core`,
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  }));
  const endpoints = instances.map((instance, i) => ({
    id: `${hosts[i].id}-listener`,
    instanceId: instance.id,
    name: `${hosts[i].name} listener`,
    connection: {
      protocol: "socks",
      host: "0.0.0.0",
      port: 1080,
      username: "fixture-user",
      password: "fixture-password",
    },
  }));
  const deployment: ServerDeployment = {
    revisionToken: "opened-listener-revision",
    id: "refresh",
    name: "FRA to UK",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "refresh",
      topologyRevision: "fixture-1",
      programs: instances.map((instance, index) => ({
        instance,
        listener: endpoints[index],
        egress: index
          ? []
          : [{ ...endpoints[1].connection, host: hosts[1].address }],
        rules: [],
        resources: [],
      })),
    },
  };
  change?.(deployment);
  let revealStatus = 0;
  let revealGate: Promise<void> | undefined;
  let current = structuredClone(endpoints[1]);
  current.connection.port = 2080;
  current.connection.password = "changed-fixture-password";
  const requests: string[] = [];
  const saved: ServerDeployment[] = [];
  const submissions: Record<string, unknown>[] = [];
  const checkedRevisions: (string | null)[] = [];
  const summary = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, child) =>
        ["username", "password", "uuid", "privateKey", "shortId"].includes(key)
          ? undefined
          : child,
      ),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      requests.push(`${method} ${path}`);
      let value: unknown = [];
      if (path.endsWith("/hosts")) value = hosts;
      else if (path.endsWith("/core-instances")) value = instances;
      else if (path.endsWith("/managed-endpoints"))
        value = summary([endpoints[0], current]);
      else if (path.endsWith("/server-deployments"))
        value = summary([deployment]);
      else if (path.endsWith("/refresh/reveal")) value = deployment;
      else if (path.endsWith("/uk-listener/reveal")) {
        if (revealGate) await revealGate;
        if (revealStatus)
          return new Response(JSON.stringify({ detail: "not available" }), {
            status: revealStatus,
            headers: { "Content-Type": "application/json" },
          });
        value = current;
      } else if (path.endsWith("/fra-listener/reveal")) value = endpoints[0];
      else if (publicationDrift && path.endsWith("/validate")) {
        const revision = new Headers(init?.headers).get("If-Match");
        checkedRevisions.push(revision);
        if (
          revision !==
          (saved.length ? "saved-listener-revision" : deployment.revisionToken)
        )
          return new Response(
            JSON.stringify({
              code: "SERVER_DRAFT_CHANGED",
              detail: "saved forwarding path changed",
            }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        value = {
          valid: true,
          fingerprint: (saved.length ? "b" : "a").repeat(64),
          artifacts: [],
          diagnostics: [],
        };
      } else if (publicationDrift && path.endsWith("/publish")) {
        const body = JSON.parse(String(init?.body));
        submissions.push(body);
        value = {
          operationId: body.operationId,
          deploymentId: deployment.id,
          status: "definitively-rejected",
          nativeChecked: false,
          code: "PUBLICATION_REJECTED",
          detail:
            "The instance or listener inventory changed; reload and review the current deployment.",
        };
      } else if (
        publicationDrift &&
        path.endsWith("/server-deployments/refresh") &&
        method === "GET"
      )
        value = summary(
          saved.length
            ? { ...saved.at(-1), revisionToken: "saved-listener-revision" }
            : deployment,
        );
      else if (path.endsWith("/validate") || path.endsWith("/publish"))
        return new Response(
          JSON.stringify({
            code: "SERVER_LISTENER_CHANGED",
            endpointId: "uk-listener",
            detail: "program listener must match registered endpoint inventory",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      else if (path.endsWith("/refresh") && method === "PUT") {
        const record = JSON.parse(String(init?.body));
        saved.push(record);
        value = {
          ...summary(record),
          revisionToken: "saved-listener-revision",
        };
      } else if (path.endsWith("/state")) value = { phase: "unregistered" };
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {publicationDrift ? (
          <VerifiedPublicationRoutes />
        ) : (
          <ServerRoutesPage />
        )}
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    requests,
    saved,
    submissions,
    checkedRevisions,
    deployment,
    current,
    pauseReveal: () => {
      let release!: () => void;
      revealGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        revealGate = undefined;
        release();
      };
    },
    setRevealStatus: (status: number) => {
      revealStatus = status;
    },
    setCurrent: (next: typeof current) => {
      current = next;
    },
  };
}

it("recovers a typed listener mismatch through reviewed local refresh, preserving secrets and updating only the proven incoming connection", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  const user = userEvent.setup();
  const state = setupRefresh();
  const routeButton = await screen.findByRole("button", { name: "FRA to UK" });
  owner.assertActive();
  await user.click(routeButton);
  owner.assertActive();
  let detail = screen.getByRole("dialog", { name: "FRA to UK" });
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  owner.assertActive();
  const refreshButton = await screen.findByRole("button", {
    name: "查看监听更新",
  });
  owner.assertActive();
  await user.click(refreshButton);
  owner.assertActive();
  let review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  owner.assertActive();
  expect(within(review).getByText("认证信息已变更")).toBeTruthy();
  expect(within(review).getByText(/uk.example.invalid:2080/)).toBeTruthy();
  expect(review.textContent?.includes("fixture-password")).toBe(false);
  expect(state.saved).toHaveLength(0);
  await user.click(within(review).getByRole("button", { name: "保留草稿" }));
  owner.assertActive();
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(within(editor).getByRole("button", { name: "监听快照与转发详情" }));
  expect(
    within(editor).getByText(/转发至 uk.example.invalid:1080/),
  ).toBeTruthy();
  expect(
    within(editor).getByText("UK listener（草稿）"),
  ).toBeTruthy();
  expect(within(editor).getByText("UK listener（草稿）").closest("[role=combobox]")?.textContent).toContain("socks:1080 xray");
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  owner.assertActive();
  review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  owner.assertActive();
  await updateListener(user, review, owner);
  owner.assertActive();
  expect(state.saved).toHaveLength(0);
  const refreshedForward = await within(editor).findByText(
    /转发至 uk.example.invalid:2080/,
  );
  owner.assertActive();
  expect(refreshedForward).toBeTruthy();
  expect(
    within(editor).getByText("socks:2080 xray"),
  ).toBeTruthy();
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  owner.assertActive();
  expect(state.saved).toHaveLength(1);
  const next = state.saved[0];
  expect(next.ir.programs[1].listener.connection.port).toBe(2080);
  expect(next.ir.programs[0].egress[0].port).toBe(2080);
  expect(
    next.ir.programs[1].listener.connection.password ===
      state.current.connection.password,
  ).toBe(true);
  expect(
    next.ir.programs[0].egress[0].password ===
      state.current.connection.password,
  ).toBe(true);
  expect(next.ir.programs.map((p) => p.instance)).toEqual(
    state.deployment.ir.programs.map((p) => p.instance),
  );
  expect(state.requests.some((path) => path.endsWith("/publish"))).toBe(false);
});

it("requires a new confirmation when the catalog changes after comparison", async () => {
  const user = userEvent.setup();
  const state = setupRefresh();
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 FRA to UK" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(within(editor).getByRole("button", { name: "监听快照与转发详情" }));
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  await within(review).findByText("认证信息已变更");
  state.setCurrent({
    ...state.current,
    connection: { ...state.current.connection, port: 3080 },
  });
  await updateListener(user, review);
  expect(
    await within(review).findByText("监听设置又有变化，请重新确认。"),
  ).toBeTruthy();
  expect(
    within(editor).getByText(/转发至 uk.example.invalid:1080/),
  ).toBeTruthy();
  expect(state.saved).toHaveLength(0);
  await updateListener(user, review);
  expect(
    await within(editor).findByText(/转发至 uk.example.invalid:3080/),
  ).toBeTruthy();
  expect(state.saved).toHaveLength(0);
});

it("keeps a denied or missing listener unknown rather than replacing the saved snapshot", async () => {
  const user = userEvent.setup();
  const state = setupRefresh();
  state.setRevealStatus(403);
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 FRA to UK" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(within(editor).getByRole("button", { name: "监听快照与转发详情" }));
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  expect(await within(review).findByText(/没有权限读取/)).toBeTruthy();
  expect(
    (
      within(review).getByRole("button", {
        name: "更新到草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  state.setRevealStatus(404);
  await user.click(within(review).getByRole("button", { name: "重新读取" }));
  expect(await within(review).findByText(/该监听端点已不存在/)).toBeTruthy();
  await user.click(within(review).getByRole("button", { name: "保留草稿" }));
  expect(
    within(editor).getByText(/转发至 uk.example.invalid:1080/),
  ).toBeTruthy();
  expect(state.saved).toHaveLength(0);
});

it("refreshes an independent listener without silently changing its connector policy", async () => {
  const user = userEvent.setup();
  const state = setupRefresh((draft) => {
    const first = draft.ir.programs[0];
    first.connectors = [{ id: "uk-out", connection: { ...first.egress[0] } }];
    first.egress = [];
    first.rules = [
      {
        id: "chatgpt",
        match: { op: "domain-suffix", value: "chatgpt.com" },
        action: { kind: "forward", ref: "uk-out" },
      },
    ];
    first.defaultAction = { kind: "direct" };
  });
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 FRA to UK" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  expect(await within(review).findByText("保留转发去向")).toBeTruthy();
  expect(
    within(review).getByText(/转发至 uk.example.invalid:1080/),
  ).toBeTruthy();
  await updateListener(user, review);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  expect(
    JSON.stringify(state.saved[0].ir.programs[0]) ===
      JSON.stringify(state.deployment.ir.programs[0]),
  ).toBe(true);
  expect(state.saved[0].ir.programs[1].listener.connection.port).toBe(2080);
});

it("ignores a late comparison after the user keeps the draft", async () => {
  const user = userEvent.setup();
  const state = setupRefresh();
  const release = state.pauseReveal();
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 FRA to UK" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(within(editor).getByRole("button", { name: "监听快照与转发详情" }));
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  expect(within(review).getByRole("status")).toBeTruthy();
  await user.click(within(review).getByRole("button", { name: "保留草稿" }));
  release();
  await user.click(
    within(editor).getByRole("textbox", { name: "转发路径名称" }),
  );
  expect(
    screen.queryByRole("dialog", { name: "更新 UK listener 的监听设置" }),
  ).toBeNull();
  expect(
    within(editor).getByText(/转发至 uk.example.invalid:1080/),
  ).toBeTruthy();
  expect(state.saved).toHaveLength(0);
});

it("cancels a pending confirmation before its delayed response can update the draft", async () => {
  const user = userEvent.setup();
  const state = setupRefresh();
  await user.click(
    await screen.findByRole("button", { name: "编辑转发路径 FRA to UK" }),
  );
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await user.click(within(editor).getByRole("button", { name: "监听快照与转发详情" }));
  await user.click(
    within(editor).getByRole("button", { name: "检查监听更新 UK listener" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  await within(review).findByText("认证信息已变更");
  const release = state.pauseReveal();
  await updateListener(user, review);
  expect(
    (
      within(review).getByRole("button", {
        name: "更新到草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(within(review).getByRole("button", { name: "保留草稿" }));
  release();
  await user.type(
    within(editor).getByRole("textbox", { name: "转发路径名称" }),
    " retained",
  );
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  expect(state.saved).toHaveLength(1);
  expect(state.saved[0].ir.programs[1].listener.connection.port).toBe(1080);
  expect(state.saved[0].ir.programs[0].egress[0].port).toBe(1080);
  expect(state.saved[0].name).toBe("FRA to UK retained");
});

it("recovers publication-time inventory drift without retaining stale approval or retrying apply", async () => {
  const user = userEvent.setup();
  sessionStorage.clear();
  const state = setupRefresh(undefined, true);
  await user.click(await screen.findByRole("button", { name: "FRA to UK" }));
  const detail = screen.getByRole("dialog", { name: "FRA to UK" });
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  await user.click(
    within(review).getByRole("checkbox", {
      name: "确认允许此转发路径提供访问",
    }),
  );
  await user.click(
    within(review).getByRole("checkbox", {
      name: "已确认目标实例可执行当前额度策略",
    }),
  );
  await user.click(within(review).getByRole("button", { name: "确认并应用" }));
  await within(detail).findByText("该次提交未被接收", { exact: true });
  expect(
    within(detail).getByText(
      "实例或监听端点已变化，请重新载入并核对当前转发路径。",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "应用转发路径修改" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "确认并应用" })).toBeNull();
  expect(
    (
      within(detail).getByRole("button", {
        name: "查看修改并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(state.saved).toHaveLength(0);
  expect(state.submissions).toEqual([
    {
      operationId: expect.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
      leaseSeconds: 300,
      accessAllowed: true,
      quotaCertain: true,
      expectedFingerprint: "a".repeat(64),
    },
  ]);
  const reload = within(detail).getByRole("button", {
    name: "重新载入转发路径",
  });
  await waitFor(() =>
    expect((reload as HTMLButtonElement).disabled).toBe(false),
  );
  await user.click(reload);
  await waitFor(() =>
    expect(
      within(screen.getByRole("dialog", { name: "FRA to UK" })).queryByText(
        "该次提交未被接收",
      ),
    ).toBeNull(),
  );
  expect(state.requests).toContain("GET /api/server-deployments/refresh");
  expect(state.saved).toHaveLength(0);
  await user.click(
    within(screen.getByRole("dialog", { name: "FRA to UK" })).getByRole(
      "button",
      { name: "编辑转发路径" },
    ),
  );
  const recoveryEditor = await screen.findByRole("dialog", {
    name: "编辑 FRA to UK",
  });
  await user.click(within(recoveryEditor).getByRole("button", { name: "监听快照与转发详情" }));
  await user.click(
    within(recoveryEditor).getByRole("button", {
      name: "检查监听更新 UK listener",
    }),
  );
  const comparison = await screen.findByRole("dialog", {
    name: "更新 UK listener 的监听设置",
  });
  expect(within(comparison).getByText(/uk.example.invalid:2080/)).toBeTruthy();
  expect(
    state.requests.filter((path) => path.endsWith("/publish")),
  ).toHaveLength(1);
  expect(state.saved).toHaveLength(0);
  await updateListener(user, comparison);
  const editor = screen.getByRole("dialog", { name: "编辑 FRA to UK" });
  await within(editor).findByText(/转发至 uk.example.invalid:2080/);
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  expect(state.saved).toHaveLength(1);
  expect(
    state.requests.filter((path) => path.endsWith("/validate")),
  ).toHaveLength(1);
  await user.click(
    within(screen.getByRole("dialog", { name: "FRA to UK" })).getByRole(
      "button",
      { name: "查看修改并应用" },
    ),
  );
  const freshReview = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(
    (
      within(freshReview).getByRole("button", {
        name: "确认并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(freshReview).getByRole("checkbox", {
        name: "确认允许此转发路径提供访问",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
    ).toBe("false");
  expect(
    state.requests.filter((path) => path.endsWith("/validate")),
  ).toHaveLength(2);
  expect(
    (
      within(freshReview).getByRole("checkbox", {
        name: "已确认目标实例可执行当前额度策略",
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
    ).toBe("false");
  expect(state.checkedRevisions).toEqual([
    "opened-listener-revision",
    "saved-listener-revision",
  ]);
  expect(
    state.requests.filter((path) => path.endsWith("/publish")),
  ).toHaveLength(1);
});


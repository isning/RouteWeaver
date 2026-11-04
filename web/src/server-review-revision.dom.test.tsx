import { VerifiedPublicationRoutes } from "../tests/publication-owner.fixture";
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
import type { ServerDeployment } from "./types";

beforeEach(() => {
  // Match the production-style unique IDs used by existing nested-dialog tests.
  vi.stubEnv("NODE_ENV", "development");
  sessionStorage.clear();
  setToken("");
  setCSRF("");
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
  sessionStorage.clear();
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function setup(withSession = false, lookupGate?: Promise<unknown>) {
  const instance = {
    id: "core",
    hostId: "host",
    adapterId: "routeweaver/xray",
    version: "26.9.28",
  };
  const listener = {
    id: "entry",
    name: "FRA listener",
    instanceId: "core",
    connection: { protocol: "socks", host: "0.0.0.0", port: 1080 },
  };
  const original: ServerDeployment = {
    id: "office",
    name: "Office path",
    revisionToken: "opened-a",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "office",
      topologyRevision: "v1",
      programs: [
        {
          instance,
          listener,
          egress: [],
          rules: [],
          resources: [],
          defaultAction: { kind: "direct" },
        },
      ],
    },
  };
  let saved = original;
  let account = "A";
  let checkGate: Promise<void> | undefined;
  const requests: { path: string; init?: RequestInit }[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      const path = String(url);
      requests.push({ path, init });
      if (path.endsWith("/auth/me"))
        return json({
          user: { id: account, name: `Account ${account}`, role: "admin" },
          csrfToken: `csrf-${account}`,
        });
      if (path.includes("/publication-requests/") && lookupGate)
        return json(await lookupGate);
      if (path.endsWith("/hosts"))
        return json([
          { id: "host", name: "FRA", address: "fra.example.invalid" },
        ]);
      if (path.endsWith("/core-instances")) return json([instance]);
      if (path.endsWith("/managed-endpoints")) return json([listener]);
      if (path.endsWith("/server-deployments")) return json([saved]);
      if (path.endsWith("/office/reveal")) return json(saved);
      if (path.endsWith("/server-deployments/office")) {
        if (init?.method === "PUT")
          saved = {
            ...JSON.parse(init.body as string),
            revisionToken: "edited-c",
          };
        return json(saved);
      }
      if (path.endsWith("/office/validate")) {
        if (new Headers(init?.headers).get("If-Match") !== saved.revisionToken)
          return json(
            {
              code: "SERVER_DRAFT_CHANGED",
              detail: "saved forwarding path changed",
            },
            409,
          );
        const checked = {
          valid: true,
          diagnostics: [],
          artifacts: [],
          fingerprint: (saved.revisionToken === "saved-b"
            ? "b"
            : saved.revisionToken === "edited-c"
              ? "c"
              : "a"
          ).repeat(64),
        };
        const gate = checkGate;
        checkGate = undefined;
        await gate;
        return json(checked);
      }
      if (path.endsWith("/office/publish")) {
        const body = JSON.parse(init?.body as string);
        if (
          body.expectedFingerprint !==
          (saved.revisionToken === "saved-b"
            ? "b"
            : saved.revisionToken === "edited-c"
              ? "c"
              : "a"
          ).repeat(64)
        )
          return json({
            operationId: body.operationId,
            deploymentId: "office",
            status: "definitively-rejected",
            nativeChecked: false,
            code: "SERVER_DRAFT_CHANGED",
            detail: "saved forwarding path changed",
          });
        return json({
          operationId: body.operationId,
          deploymentId: "office",
          status: "publication-accepted",
          nativeChecked: false,
          instances: [
            {
              instanceId: "core",
              generation: "1",
              operationId: "agent-operation",
              revisionId: "revision-one",
            },
          ],
        });
      }
      if (path.endsWith("/state"))
        return json({ instanceId: "core", phase: "unregistered" });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (withSession) history.replaceState(null, "", "#routes?deployment=office");
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {withSession ? <Workspace /> : <VerifiedPublicationRoutes />}
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    requests,
    switchAccount: () => {
      account = "B";
    },
    deferNextCheck: () => {
      let complete!: () => void;
      checkGate = new Promise<void>((resolve) => {
        complete = resolve;
      });
      return complete;
    },
    changeSaved: () => {
      saved = {
        ...original,
        revisionToken: "saved-b",
        ir: {
          ...original.ir,
          programs: [
            { ...original.ir.programs[0], defaultAction: { kind: "reject" } },
          ],
        },
      };
    },
  };
}

it("requires explicit reload and fresh consent when the saved path changes after opening", async () => {
  const user = userEvent.setup();
  const { requests, changeSaved } = setup();
  await user.click(
    await screen.findByRole(
      "button",
      { name: "Office path" },
      { timeout: INITIAL_PAGE_READY_TIMEOUT_MS },
    ),
  );
  let detail = screen.getByRole("dialog", { name: "Office path" });
  expect(within(detail).getByText("直连")).toBeTruthy();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  let review = await screen.findByRole("dialog", { name: "应用转发路径修改" });
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
  await user.click(within(review).getByRole("button", { name: /^返\s*回$/ }));
  changeSaved();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  const reload = await screen.findByRole("button", {
    name: "重新载入转发路径",
  });
  const checks = requests.filter(({ path }) => path.endsWith("/validate"));
  expect(new Headers(checks.at(-1)?.init?.headers).get("If-Match")).toBe(
    "opened-a",
  );
  expect(screen.queryByRole("button", { name: "确认并应用" })).toBeNull();
  expect(
    (
      within(detail).getByRole("button", {
        name: "查看修改并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(within(detail).getByText("直连")).toBeTruthy();
  expect(requests.some(({ path }) => path.endsWith("/publish"))).toBe(false);
  await user.click(reload);
  detail = await screen.findByRole("dialog", { name: "Office path" });
  await within(detail).findByText("拒绝连接");
  expect(within(detail).queryByText("直连")).toBeNull();
  expect(
    requests.filter(({ path }) => path.endsWith("/validate")),
  ).toHaveLength(2);
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  review = await screen.findByRole("dialog", { name: "应用转发路径修改" });
  expect(within(review).getByText("拒绝连接")).toBeTruthy();
  const apply = within(review).getByRole("button", {
    name: "确认并应用",
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
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
  await user.click(apply);
  await waitFor(() =>
    expect(
      requests.filter(({ path }) => path.endsWith("/publish")),
    ).toHaveLength(1),
  );
  expect(
    JSON.parse(
      requests.find(({ path }) => path.endsWith("/publish"))!.init!
        .body as string,
    ).expectedFingerprint,
  ).toBe("b".repeat(64));
});

it("invalidates consent when the draft changes after checking but before application", async () => {
  const user = userEvent.setup();
  const { requests, changeSaved } = setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }));
  const detail = screen.getByRole("dialog", { name: "Office path" });
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  for (const checkbox of within(review).getAllByRole("checkbox"))
    await user.click(checkbox);
  changeSaved();
  await user.click(within(review).getByRole("button", { name: "确认并应用" }));
  await within(detail).findByText("该次提交未被接收", { exact: true });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "应用转发路径修改" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("button", { name: "确认并应用" })).toBeNull();
  expect(within(detail).getByText("直连")).toBeTruthy();
  expect(
    (
      within(detail).getByRole("button", {
        name: "查看修改并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(
    await within(detail).findByRole("button", { name: "重新载入转发路径" }),
  );
  const reloaded = await screen.findByRole("dialog", { name: "Office path" });
  await within(reloaded).findByText("拒绝连接");
  expect(requests.filter(({ path }) => path.endsWith("/publish"))).toHaveLength(
    1,
  );
  expect(screen.queryByText("更新已发送给目标实例")).toBeNull();
  await user.click(
    within(reloaded).getByRole("button", { name: "查看修改并应用" }),
  );
  const newReview = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(
    (
      within(newReview).getByRole("button", {
        name: "确认并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("does not attach a late check to a newly saved revision of the same path", async () => {
  const user = userEvent.setup();
  const { requests, changeSaved, deferNextCheck } = setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }));
  const detail = screen.getByRole("dialog", { name: "Office path" });
  const complete = deferNextCheck();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  await waitFor(() =>
    expect(
      requests.filter(({ path }) => path.endsWith("/validate")),
    ).toHaveLength(1),
  );
  changeSaved();
  await user.click(
    within(detail).getByRole("button", { name: "编辑转发路径" }),
  );
  const editor = await screen.findByRole("dialog", {
    name: "编辑 Office path",
  });
  await user.clear(
    within(editor).getByRole("textbox", { name: "转发路径名称" }),
  );
  await user.type(
    within(editor).getByRole("textbox", { name: "转发路径名称" }),
    "Updated same path",
  );
  await user.click(within(editor).getByRole("button", { name: "保存草稿" }));
  const updated = await screen.findByRole("dialog", {
    name: "Updated same path",
  });
  await within(updated).findByText("拒绝连接");
  await act(async () => {
    complete();
  });
  expect(screen.queryByRole("dialog", { name: "应用转发路径修改" })).toBeNull();
  await user.click(
    within(updated).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(within(review).getByText("拒绝连接")).toBeTruthy();
  expect(
    (
      within(review).getByRole("button", {
        name: "确认并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    new Headers(
      requests.filter(({ path }) => path.endsWith("/validate")).at(-1)?.init
        ?.headers,
    ).get("If-Match"),
  ).toBe("edited-c");
  expect(requests.some(({ path }) => path.endsWith("/publish"))).toBe(false);
});

it("does not reveal the previous account's late check in the next account workspace", async () => {
  const user = userEvent.setup();
  const { requests, changeSaved, deferNextCheck, switchAccount } = setup(true);
  await screen.findByText("Account A");
  const detail = await screen.findByRole("dialog", { name: "Office path" });
  const complete = deferNextCheck();
  await user.click(
    within(detail).getByRole("button", { name: "查看修改并应用" }),
  );
  await waitFor(() =>
    expect(
      requests.filter(({ path }) => path.endsWith("/validate")),
    ).toHaveLength(1),
  );
  changeSaved();
  switchAccount();
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await screen.findByText("Account B");
  const next = await screen.findByRole("dialog", { name: "Office path" });
  await within(next).findByText("拒绝连接");
  await act(async () => {
    complete();
  });
  expect(screen.queryByRole("dialog", { name: "应用转发路径修改" })).toBeNull();
  await user.click(
    within(next).getByRole("button", { name: "查看修改并应用" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "应用转发路径修改",
  });
  expect(within(review).getByText("拒绝连接")).toBeTruthy();
  expect(
    (
      within(review).getByRole("button", {
        name: "确认并应用",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(requests.some(({ path }) => path.endsWith("/publish"))).toBe(false);
});

it("blocks staged application for the same unresolved direct request while leaving recovery available", async () => {
  sessionStorage.setItem(
    "routeweaver.publication-request.v1",
    JSON.stringify({
      version: 1,
      actorId: "test-admin",
      deploymentId: "office",
      operationId: "pending-office",
      request: {
        leaseSeconds: 300,
        accessAllowed: true,
        quotaCertain: true,
        expectedFingerprint: "a".repeat(64),
      },
    }),
  );
  const user = userEvent.setup();
  setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }));
  const detail = screen.getByRole("dialog", { name: "Office path" });
  expect(
    (
      within(detail).getByRole("button", {
        name: "分阶段应用修改",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(detail).getByRole("button", {
        name: "查询提交结果",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await user.click(within(detail).getByRole("button", { name: "实例操作" }));
  const configure = await screen.findByRole("menuitem", { name: "应用配置" });
  expect(configure.getAttribute("aria-disabled")).toBe("true");
  expect(
    screen
      .getByRole("menuitem", { name: "停止核心" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
});

it("retains a late receipt behind an allowed Stop planner until the result is actually foregrounded", async () => {
  const frozen = {
    version: 1,
    actorId: "test-admin",
    deploymentId: "office",
    operationId: "pending-office",
    request: {
      leaseSeconds: 300,
      accessAllowed: true,
      quotaCertain: true,
      expectedFingerprint: "a".repeat(64),
    },
  };
  sessionStorage.setItem(
    "routeweaver.publication-request.v1",
    JSON.stringify(frozen),
  );
  let finish!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  setup(false, gate);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }));
  let detail = screen.getByRole("dialog", { name: "Office path" });
  await user.click(
    within(detail).getByRole("button", { name: "查询提交结果" }),
  );
  await user.click(within(detail).getByRole("button", { name: "实例操作" }));
  await user.click(await screen.findByRole("menuitem", { name: "停止核心" }));
  const planner = await screen.findByRole("dialog", {
    name: "Office path · 停止核心",
  });
  await act(async () =>
    finish({
      request: frozen.request,
      result: {
        operationId: frozen.operationId,
        deploymentId: "office",
        status: "publication-accepted",
        nativeChecked: false,
        instances: [
          {
            instanceId: "core",
            generation: "1",
            operationId: "agent",
            revisionId: "revision",
          },
        ],
      },
    }),
  );
  expect(sessionStorage.getItem("routeweaver.publication-request.v1")).toBe(
    JSON.stringify(frozen),
  );
  expect(screen.queryByText("该次提交已接收", { exact: true })).toBeNull();
  await user.click(within(planner).getByRole("button", { name: "关闭" }));
  detail = await screen.findByRole("dialog", { name: "Office path" });
  expect(
    await within(detail).findByText("该次提交已接收", { exact: true }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(
      sessionStorage.getItem("routeweaver.publication-request.v1"),
    ).toBeNull(),
  );
});

it("keeps apply consequences and both consent gates beside the footer action while technical details expand", async () => {
  setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Office path" })).getByRole(
      "button",
      { name: "查看修改并应用" },
    ),
  );
  const review = within(
    await screen.findByRole("dialog", { name: "应用转发路径修改" }),
  );
  const apply = review.getByRole("button", {
    name: "确认并应用",
  }) as HTMLButtonElement;
  const footer = apply.closest('[data-slot="dialog-footer"]') as HTMLElement;
  expect(footer).toBeTruthy();
  expect(footer.textContent).toContain("已有连接可能中断");
  expect(footer.textContent).toContain("到期后需重新确认权限才能继续运行");
  const checks = within(footer).getAllByRole("checkbox");
  expect(checks).toHaveLength(2);
  expect(apply.disabled).toBe(true);
  await user.click(
    review.getByRole("button", { name: "断联时的有效期与生成文件" }),
  );
  const lease = review.getByLabelText("权限有效期（秒）");
  expect(footer.contains(lease)).toBe(false);
  fireEvent.change(lease, { target: { value: "120" } });
  expect(footer.textContent).toContain("权限有效期 120 秒");
  await user.click(checks[0]);
  expect(apply.disabled).toBe(true);
  await user.click(checks[1]);
  expect(apply.disabled).toBe(false);
  await user.click(within(footer).getByRole("button", { name: "返回" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "应用转发路径修改" }),
    ).toBeNull(),
  );
});

import { VerifiedPublicationRoutes } from "../tests/publication-owner.fixture";
import { INITIAL_PAGE_READY_TIMEOUT_MS } from "./test-support/functional-dom-contract";
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

async function openLeaseReview() {
  const result = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Office path" }, { timeout: INITIAL_PAGE_READY_TIMEOUT_MS }));
  await user.click(within(screen.getByRole("dialog", { name: "Office path" })).getByRole("button", { name: "查看修改并应用" }));
  const review = within(await screen.findByRole("dialog", { name: "应用转发路径修改" }));
  await user.click(review.getByRole("button", { name: "断联时的有效期与生成文件" }));
  return { ...result, user, review, lease: review.getByRole("spinbutton", { name: "权限有效期（秒）" }) };
}
async function approve(review: ReturnType<typeof within>) {
  const user = userEvent.setup();
  await user.click(review.getByRole("checkbox", { name: "确认允许此转发路径提供访问" }));
  await user.click(review.getByRole("checkbox", { name: "已确认目标实例可执行当前额度策略" }));
}
it.each(["", "0", "29", "3601", "30.5", "30.000000000000000001", "3599.999999999999999999", "1e", "-", "0x12c"])("retains invalid direct-publication lease %s without creating a request", async raw => {
  const { review, lease, user, requests } = await openLeaseReview();
  fireEvent.change(lease, { target: { value: raw } });
  fireEvent.blur(lease);
  expect((lease as HTMLInputElement).value).toBe(raw);
  await approve(review);
  await user.click(review.getByRole("button", { name: "确认并应用" }));
  await review.findByText("权限有效期须为 30–3600 的整数秒，且不能留空。");
  expect(requests.filter(r => r.path.endsWith("/publish"))).toHaveLength(0);
  expect(sessionStorage.getItem("routeweaver.publication-request.v1")).toBeNull();
});
it.each([["30", 30], ["3600", 3600], ["3e2", 300], ["300.0", 300]])("submits exact direct-publication lease %s", async (raw, expected) => {
  const { review, lease, user, requests } = await openLeaseReview();
  fireEvent.change(lease, { target: { value: raw } });
  await approve(review);
  await user.click(review.getByRole("button", { name: "确认并应用" }));
  await waitFor(() => {
    const submitted = requests.find(r => r.path.endsWith("/publish"));
    expect(submitted).toBeTruthy();
    expect(JSON.parse(String(submitted!.init?.body))).toMatchObject({ leaseSeconds: expected, accessAllowed: true, quotaCertain: true });
  });
});
it("requires renewed confirmation after every lease edit, including repair to its former value", async () => {
  const { review, lease } = await openLeaseReview();
  await approve(review);
  fireEvent.change(lease, { target: { value: "3e" } });
  fireEvent.change(lease, { target: { value: "300" } });
  expect((review.getByRole("button", { name: "确认并应用" }) as HTMLButtonElement).disabled).toBe(true);
  for (const checkbox of review.getAllByRole("checkbox"))
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
});

it("keeps the untouched direct-publication lease at 300 seconds", async () => {
  const { review, lease, user, requests } = await openLeaseReview();
  expect((lease as HTMLInputElement).value).toBe("300");
  await approve(review);
  await user.click(review.getByRole("button", { name: "确认并应用" }));
  await waitFor(() => expect(JSON.parse(String(requests.find(r => r.path.endsWith("/publish"))?.init?.body))).toMatchObject({ leaseSeconds: 300 }));
});

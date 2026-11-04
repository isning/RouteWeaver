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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccessSubscription } from "./Subscriptions";
import { UserEntries } from "./UserEntries";
import type { Output } from "./types";
import { setCSRF, setToken } from "./api";
import { emptyProfile } from "./model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const member = {
  id: "rotation-owner",
  name: "小林",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const line = {
  id: "managed-line",
  name: "伦敦线路",
  deploymentId: "managed-path",
  endpointIds: ["entry"],
  publicHost: "public.example.invalid",
  publicPort: 443,
  status: "effective",
  diagnostics: [],
};
const instance = {
  id: "core",
  hostId: "host",
  name: "入口实例",
  adapterId: "routeweaver/managed-xray",
  version: "26.3.27-rw1",
};
const listener = {
  id: "entry",
  name: "伦敦入口",
  instanceId: "core",
  connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
};
const deployment = {
  id: "managed-path",
  name: "伦敦转发",
  revisionToken: "synthetic-opened-revision",
  status: "draft",
  ir: {
    schemaVersion: "1.0",
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
const profile = { ...emptyProfile(), id: "shared-profile", name: "日常分流" };
// Deliberately differ from the shared Profile defaults: recovery must retain
// this existing client's target and output mode rather than silently replacing them.
const phone = {
  id: "phone",
  name: "Phone",
  profileId: profile.id,
  target: { adapterId: "sing-box", version: "1.14.3" },
  mode: "nodes-only",
  status: "published",
  revision: "phone-old",
};
const laptop = {
  ...phone,
  id: "laptop",
  name: "Laptop",
  revision: "laptop-old",
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setToken("");
  setCSRF("");
  sessionStorage.clear();
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      postMessage() {}
      close() {}
    },
  );
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computed(element),
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
  });
  clients.splice(0).forEach((client) => client.clear());
  sessionStorage.clear();
  history.replaceState(null, "", "#subscriptions");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixture(
  role: "admin" | "user" = "user",
  options: { legacyNameCollision?: boolean } = {},
) {
  let entryStatus = "effective";
  let readiness = "OUTPUT_ENTRY_UNCONFIRMED";
  let currentPhone = { ...phone };
  let retainPublicationRevision = false;
  let nextAccess: Promise<Response> | undefined;
  let nextPublish: Promise<Response> | undefined;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const accessReads: string[] = [];
  const requests: { path: string; phase: string; at: number }[] = [];
  const respond = async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/auth/me"))
      return json({
        user: {
          id: role === "admin" ? "administrator" : member.id,
          name: role === "admin" ? "Administrator" : member.name,
          role,
        },
        csrfToken: "synthetic-csrf",
      });
    if (init?.method && init.method !== "GET") {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      writes.push({ path, body });
      if (path === "/api/published-routes/managed-line/principals") {
        entryStatus = "pending-deployment";
        return json({ status: entryStatus, entryId: "managed-grant" }, 201);
      }
      if (path === `/api/me/profiles/${profile.id}/preview`)
        return json({
          valid: true,
          previewDigest: "e".repeat(64),
          publicationEffect: { version: 1, link: "preserve" },
          artifacts: [],
          diagnostics: [],
          previewScope: "output-update",
          outputId: phone.id,
        });
      if (path === "/api/me/outputs/phone/publish") {
        if (nextPublish) return nextPublish;
        currentPhone = {
          ...phone,
          revision: retainPublicationRevision
            ? phone.revision
            : "phone-updated",
        };
        readiness = "ready";
        return json(currentPhone);
      }
      throw new Error(`Unexpected write ${path}`);
    }
    if (path === "/api/state")
      return json({
        nodes: options.legacyNameCollision
          ? [
              {
                id: "legacy-node",
                name: "旧线路连接",
                host: "127.0.0.1",
                port: 1080,
                protocol: "socks",
              },
            ]
          : [],
        routes: options.legacyNameCollision
          ? [
              {
                id: line.id,
                name: "同 ID 的旧线路",
                engine: "xray",
                hops: ["legacy-node"],
                userIds: [member.id],
              },
            ]
          : [],
        users: [member],
        revisions: [],
        capabilities: [],
        deploymentAvailable: true,
        publishedRoutes: [line],
      });
    if (path === "/api/published-routes") return json([line]);
    if (path === "/api/published-routes/managed-line/resolve")
      return json(line);
    if (path === "/api/settings") return json({});
    if (
      path === "/api/services" ||
      path === "/api/user-groups" ||
      path === "/api/access-policy/groups" ||
      path === "/api/links"
    )
      return json([]);
    if (path === "/api/hosts")
      return json([
        { id: "host", name: "入口服务器", address: "public.example.invalid" },
      ]);
    if (path === "/api/core-instances") return json([instance]);
    if (path === "/api/managed-endpoints") return json([listener]);
    if (path === "/api/server-deployments") return json([deployment]);
    if (path === "/api/agent/instances/core/state")
      return json({ phase: "unregistered" });
    if (path === `/api/users/${member.id}/entries`)
      return json([
        {
          id: "managed-grant",
          name: "小林的入口",
          routeId: line.id,
          publishedRouteId: line.id,
          deploymentId: deployment.id,
          credentialVersion: "synthetic-version",
          status: entryStatus,
        },
      ]);
    if (path === `/api/users/${member.id}/entitlement`) return json({});
    if (path === `/api/users/${member.id}/effective-policy`)
      return json({
        routeIds: [line.id],
        status: "active",
        provenance: { routes: "direct" },
        entitlement: { cycle: { mode: "none" } },
      });
    if (path === "/api/me/overview")
      return json({
        user: member,
        routes: [],
        quotaBytes: 0,
        status: "active",
      });
    if (path === "/api/me/profiles") return json([profile]);
    if (path === "/api/me/outputs") return json([currentPhone, laptop]);
    if (path === "/api/me/outputs/phone/access") {
      accessReads.push(path);
      if (nextAccess) {
        const pending = nextAccess;
        nextAccess = undefined;
        return pending;
      }
      return readiness === "ready"
        ? json({ feedPath: "/feed/synthetic-existing-link", delivery: "feed" })
        : json(
            { code: readiness, detail: "Synthetic access is not deliverable" },
            409,
          );
    }
    if (path === "/api/me/outputs/phone/status")
      return json({ ...currentPhone, draftComparison: { state: "changed" } });
    if (path === "/api/me/outputs/laptop/status")
      return json({ ...laptop, draftComparison: { state: "changed" } });
    if (
      path.endsWith("/notifications") ||
      path.endsWith("/unread") ||
      path.endsWith("/entitlements") ||
      path.endsWith("/groups")
    )
      return json([]);
    throw new Error(`Unexpected read ${path}`);
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, phase: "start", at: performance.now() });
      const response = await respond(input, init);
      requests.push({ path, phase: "response", at: performance.now() });
      const readJSON = response.json.bind(response);
      response.json = async () => {
        const body = await readJSON();
        requests.push({ path, phase: "body", at: performance.now() });
        return body;
      };
      return response;
    }),
  );
  return {
    writes,
    accessReads,
    requests,
    keepPublicationRevision: () => {
      retainPublicationRevision = true;
    },
    setReadiness: (value: string) => {
      readiness = value;
    },
    holdNextPublish: () => {
      let complete!: (response: Response) => void;
      nextPublish = new Promise<Response>((resolve) => {
        complete = resolve;
      });
      return complete;
    },
    holdNextAccess: () => {
      let complete!: (response: Response) => void;
      nextAccess = new Promise<Response>((resolve) => {
        complete = resolve;
      });
      return complete;
    },
  };
}

// The original five full-workspace tracers are retained in the frozen RED
// source/evidence. Cold setup never reached their target; final public browser
// journeys plus these current exported seams supersede them, not pass them.
// Current exported component seam: does not invent recovery-only props or
// replace API parsing. The full browser task separately owns workspace/session.
function mountAccess(initial: Output | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  let output = initial;
  const tree = () => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <AccessSubscription
          output={output}
          onClose={() => {
            output = null;
            view.rerender(tree());
          }}
        />
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    setOutput: (value: Output | null) => {
      output = value;
      view.rerender(tree());
    },
  };
}

it("owns a fresh access read when the same output is closed and reopened before an old response", async () => {
  const f = fixture();
  const complete = f.holdNextAccess();
  try {
    const view = mountAccess(phone);
    await waitFor(() => expect(f.accessReads).toHaveLength(1));
    view.setOutput(null);
    f.setReadiness("ready");
    view.setOutput(phone);
    await waitFor(() => expect(f.accessReads).toHaveLength(2));
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    expect(
      (
        (await within(access).findByRole("textbox", {
          name: "订阅链接",
        })) as HTMLInputElement
      ).value,
    ).toContain("synthetic-existing-link");
    await act(async () => {
      complete(
        json(
          { code: "OUTPUT_REPUBLISH_REQUIRED", detail: "Late old task" },
          409,
        ),
      );
    });
    expect(within(access).queryByText("此订阅需要更新")).toBeNull();
    expect(
      within(access).getByRole("textbox", { name: "订阅链接" }),
    ).toBeTruthy();
    expect(f.writes).toHaveLength(0);
  } finally {
    complete(json({ code: "OUTPUT_ENTRY_UNCONFIRMED" }, 409));
  }
});

it("discards an old access response when the same ID has a newer visible publication revision", async () => {
  const f = fixture();
  const complete = f.holdNextAccess();
  try {
    const view = mountAccess(phone);
    await waitFor(() => expect(f.accessReads).toHaveLength(1));
    f.setReadiness("ready");
    view.setOutput({ ...phone, revision: "phone-new-publication" });
    await waitFor(() => expect(f.accessReads).toHaveLength(2));
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    await within(access).findByRole("textbox", { name: "订阅链接" });
    await act(async () => {
      complete(
        json(
          {
            code: "OUTPUT_REPUBLISH_REQUIRED",
            detail: "Late previous revision",
          },
          409,
        ),
      );
    });
    expect(within(access).queryByText("此订阅需要更新")).toBeNull();
    expect(
      within(access).getByRole("textbox", { name: "订阅链接" }),
    ).toBeTruthy();
    expect(f.writes).toHaveLength(0);
  } finally {
    complete(json({ code: "OUTPUT_ENTRY_UNCONFIRMED" }, 409));
  }
});

it("keeps the existing access task through explicit original-output repair and cancel", async (context) => {
  const scenario = ownedClickScenario(context);
  const f = fixture();
  mountAccess(phone);
  let access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(access).findByText("平台入口尚未确认可用");
  expect(within(access).queryByRole("textbox")).toBeNull();
  expect(within(access).queryByRole("link")).toBeNull();
  f.setReadiness("OUTPUT_REPUBLISH_REQUIRED");
  await scenario.click(() =>
    within(access).getByRole("button", { name: "重新核对" }),
  );
  await within(access).findByText("此订阅需要更新");
  expect(document.activeElement).toBe(
    within(access).getByRole("region", { name: "订阅获取状态" }),
  );
  await scenario.click(() =>
    within(access).getByRole("button", { name: "检查更新" }),
  );
  let review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Phone」",
  });
  const first = await within(review).findByRole("button", {
    name: "确认更新「Phone」",
  });
  await waitFor(() => expect(first.hasAttribute("disabled")).toBe(false));
  expect(f.writes).toEqual([
    {
      path: `/api/me/profiles/${profile.id}/preview`,
      body: { outputId: phone.id, target: phone.target, mode: phone.mode },
    },
  ]);
  const readsBeforeCancel = f.accessReads.length;
  const writesBeforeCancel = f.writes.length;
  await scenario.click(() =>
    within(review).getByRole("button", { name: /取\s*消/ }),
  );
  access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  const repair = await within(access).findByRole("button", {
    name: "检查更新",
  });
  // Cancel focus belongs to the mandatory built normal/reduced-motion tasks;
  // jsdom motion:false does not model the Modal close/open animation ordering.
  // Keep the public task/identity/no-side-effect contract at this seam.
  expect(within(access).getByText("此订阅需要更新")).toBeTruthy();
  expect(f.accessReads).toHaveLength(readsBeforeCancel);
  expect(f.writes).toHaveLength(writesBeforeCancel);
  expect(f.writes.some((write) => write.path.endsWith("/publish"))).toBe(false);
  await scenario.click(() => repair);
  review = await screen.findByRole("dialog", { name: "检查订阅更新「Phone」" });
  const confirm = await within(review).findByRole("button", {
    name: "确认更新「Phone」",
  });
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  await scenario.click(() => confirm);
  access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(access).findByRole("textbox", { name: "订阅链接" });
  expect(f.writes.filter((w) => w.path.endsWith("/publish"))).toEqual([
    {
      path: "/api/me/outputs/phone/publish",
      body: { previewDigest: "e".repeat(64) },
    },
  ]);
  expect(
    f.writes.some(
      (w) =>
        /\/(rotate|revoke|principals)$/.test(w.path) ||
        w.path === "/api/me/outputs",
    ),
  ).toBe(false);
});

it("offers only localized retry for an unknown access conflict", async () => {
  const f = fixture();
  f.setReadiness("UNRELATED_CONFLICT");
  mountAccess(phone);
  const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(access).findByText("暂时无法获取此订阅，请稍后重试。");
  expect(within(access).queryByRole("button", { name: "检查更新" })).toBeNull();
  expect(within(access).queryByRole("textbox")).toBeNull();
  expect(within(access).queryByRole("link")).toBeNull();
  expect(
    within(access).queryByText("Synthetic access is not deliverable"),
  ).toBeNull();
  expect(f.writes).toHaveLength(0);
});

it("does not steal newer Close focus when a background access recheck finishes after review cancel", async (context) => {
  const scenario = ownedClickScenario(context),
    f = fixture();
  f.setReadiness("OUTPUT_REPUBLISH_REQUIRED");
  const view = mountAccess(phone);
  const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await scenario.click(() =>
    within(access).findByRole("button", { name: "检查更新" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Phone」",
  });
  const complete = f.holdNextAccess();
  try {
    // Session recovery may invalidate all mounted owner queries while the
    // access modal is hidden; this is public QueryClient behavior, not a
    // fabricated component callback or replacement query implementation.
    act(() => {
      void view.client.invalidateQueries({ queryKey: ["output-access"] });
    });
    await waitFor(() => expect(f.accessReads).toHaveLength(2));
    await scenario.click(() =>
      within(review).getByRole("button", { name: /取\s*消/ }),
    );
    const returned = await screen.findByRole("dialog", {
      name: "获取「Phone」",
    });
    const close = within(returned).getByRole("button", { name: "关闭" });
    fireEvent.keyDown(close, { key: "Tab" });
    close.focus();
    await act(async () => {
      complete(
        json(
          {
            code: "OUTPUT_REPUBLISH_REQUIRED",
            detail: "Checked current access",
          },
          409,
        ),
      );
    });
    await within(returned).findByRole("button", { name: "检查更新" });
    expect(document.activeElement).toBe(close);
  } finally {
    complete(json({ code: "OUTPUT_REPUBLISH_REQUIRED" }, 409));
  }
});

function mountEntries(count = 1) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const reads: string[] = [],
    writes: { path: string; body: unknown }[] = [];
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST" || init?.method === "DELETE") {
        writes.push({
          path,
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
        return pending;
      }
      reads.push(path);
      if (path.endsWith("/entitlement")) return json({});
      if (path.endsWith("/entries"))
        return json(
          Array.from({ length: count }, (_, i) => ({
            id: `grant-${i}`,
            name: `入口 ${i + 1}`,
            routeId: line.id,
            publishedRouteId: line.id,
            deploymentId: line.deploymentId,
            status: "pending-deployment",
          })),
        );
      throw new Error(`Unexpected entry request ${path}`);
    }),
  );
  let user: typeof member | null = member;
  const tree = () => (
    <QueryClientProvider client={client}>
      <UIProviders>
        <UserEntries
          user={user}
          routes={[
            {
              id: line.id,
              name: "同 ID 的旧线路",
              engine: "xray",
              hops: [],
              userIds: [member.id],
            },
          ]}
          publishedRoutes={[line]}
          services={[]}
          onClose={() => {
            user = null;
            view.rerender(tree());
          }}
        />
      </UIProviders>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    reads,
    writes,
    finish,
    setUser: (value: typeof member | null) => {
      user = value;
      view.rerender(tree());
    },
  };
}

for (const status of [200, 503])
  it(`keeps delayed entry operation ${status} owned by A after the drawer changes to B`, async (context) => {
    const scenario = ownedClickScenario(context),
      f = mountEntries(2);
    try {
      const drawer = await screen.findByRole("dialog", {
        name: "小林 的平台入口",
      });
      const row = await within(drawer).findByRole("listitem", {
        name: "入口 1",
      });
      const pathAction = within(row).getByRole("link", {
        name: "检查并应用路径",
      });
      await scenario.click(() =>
        within(row).getByRole("button", { name: "轮换凭据" }),
      );
      await scenario.click(() =>
        screen.findByRole("button", { name: "准备新凭据" }),
      );
      await waitFor(() => expect(f.writes).toHaveLength(1));
      expect(f.writes[0]).toMatchObject({
        path: "/api/published-routes/managed-line/principals",
        body: { accountId: member.id, entryId: "grant-0" },
      });
      expect(
        within(row)
          .getByRole("button", { name: "停止交付" })
          .hasAttribute("disabled"),
      ).toBe(true);
      const rotating = within(row).getByRole("button", {
        name: "轮换凭据",
      });
      expect(rotating.getAttribute("aria-busy")).toBe("true");
      const otherEntry = within(drawer).getByRole("listitem", {
        name: "入口 2",
      });
      expect(
        within(otherEntry)
          .getByRole("button", { name: "轮换凭据" })
          .getAttribute("aria-busy"),
      ).not.toBe("true");
      expect(pathAction.getAttribute("aria-disabled")).toBe("true");
      expect(pathAction.getAttribute("href")).toBeNull();
      f.setUser({ ...member, id: "other-owner", name: "小周" });
      const other = await screen.findByRole("dialog", {
        name: "小周 的平台入口",
      });
      await within(other).findByRole("listitem", { name: "入口 1" });
      const before = f.reads.filter(
        (path) => path === "/api/users/other-owner/entries",
      ).length;
      await act(async () => {
        f.finish(
          json(
            status === 200
              ? { status: "pending-deployment" }
              : { detail: "A-only delayed failure" },
            status,
          ),
        );
      });
      expect(within(other).queryByText("A-only delayed failure")).toBeNull();
      expect(screen.queryByText("新凭据已准备")).toBeNull();
      expect(
        f.reads.filter((path) => path === "/api/users/other-owner/entries"),
      ).toHaveLength(before);
      expect(f.writes).toHaveLength(1);
    } finally {
      f.finish(json({}, 200));
    }
  });

it("does not restore a dismissed entry task when its pending rotation finishes", async (context) => {
  const scenario = ownedClickScenario(context),
    f = mountEntries();
  try {
    const drawer = await screen.findByRole("dialog", {
      name: "小林 的平台入口",
    });
    const row = await within(drawer).findByRole("listitem", { name: "入口 1" });
    await scenario.click(() =>
      within(row).getByRole("button", { name: "轮换凭据" }),
    );
    await scenario.click(() =>
      screen.findByRole("button", { name: "准备新凭据" }),
    );
    await waitFor(() => expect(f.writes).toHaveLength(1));
    await scenario.click(() =>
      within(drawer).getByRole("button", { name: "关闭" }),
    );
    await act(async () => {
      f.finish(json({ status: "pending-deployment" }));
    });
    expect(
      screen.queryByRole("dialog", { name: "小林 的平台入口" }),
    ).toBeNull();
    expect(screen.queryByText("新凭据已准备")).toBeNull();
  } finally {
    f.finish(json({}, 200));
  }
});

it("keeps large entry lists paginated and resets ownership on another user", async (context) => {
  const scenario = ownedClickScenario(context),
    f = mountEntries(11);
  const drawer = await screen.findByRole("dialog", { name: "小林 的平台入口" });
  await within(drawer).findByRole("listitem", { name: "入口 1" });
  expect(
    within(drawer).queryByRole("listitem", { name: "入口 11" }),
  ).toBeNull();
  await scenario.click(() =>
    within(drawer).getByRole("button", { name: "下一页" }),
  );
  await within(drawer).findByRole("listitem", { name: "入口 11" });
  expect(within(drawer).queryByRole("listitem", { name: "入口 1" })).toBeNull();
  f.setUser({ ...member, id: "other-owner", name: "小周" });
  const other = await screen.findByRole("dialog", { name: "小周 的平台入口" });
  await within(other).findByRole("listitem", { name: "入口 1" });
  expect(within(other).queryByRole("listitem", { name: "入口 11" })).toBeNull();
});

it("uses the managed namespace for an entry name when a legacy route shares its ID", async () => {
  mountEntries();
  const drawer = await screen.findByRole("dialog", { name: "小林 的平台入口" });
  const row = await within(drawer).findByRole("listitem", { name: "入口 1" });
  expect(within(row).getByText("伦敦线路")).toBeTruthy();
  expect(within(row).queryByText("同 ID 的旧线路")).toBeNull();
  expect(within(row).queryByText("managed-line")).toBeNull();
});

it("checks access again after explicit publication even when its revision string is unchanged", async (context) => {
  const scenario = ownedClickScenario(context),
    f = fixture();
  f.setReadiness("OUTPUT_REPUBLISH_REQUIRED");
  f.keepPublicationRevision();
  mountAccess(phone);
  const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await scenario.click(() =>
    within(access).findByRole("button", { name: "检查更新" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Phone」",
  });
  const confirm = await within(review).findByRole("button", {
    name: "确认更新「Phone」",
  });
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  await scenario.click(() => confirm);
  const restored = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(restored).findByRole("textbox", { name: "订阅链接" });
  expect(f.accessReads).toHaveLength(2);
  expect(f.writes.filter((w) => w.path.endsWith("/publish"))).toHaveLength(1);
});

it("keeps a delayed revocation failure with its original owner after switching users", async (context) => {
  const scenario = ownedClickScenario(context),
    f = mountEntries();
  try {
    const drawer = await screen.findByRole("dialog", {
      name: "小林 的平台入口",
    });
    const row = await within(drawer).findByRole("listitem", { name: "入口 1" });
    await scenario.click(() =>
      within(row).getByRole("button", { name: "停止交付" }),
    );
    await scenario.click(() =>
      screen.findByRole("button", { name: "停止交付" }),
    );
    await waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.writes[0].path).toBe("/api/users/rotation-owner/entries/grant-0");
    expect(
      within(row)
        .getByRole("button", { name: "轮换凭据" })
        .hasAttribute("disabled"),
    ).toBe(true);
    f.setUser({ ...member, id: "other-owner", name: "小周" });
    const other = await screen.findByRole("dialog", {
      name: "小周 的平台入口",
    });
    await within(other).findByRole("listitem", { name: "入口 1" });
    await act(async () => {
      f.finish(json({ detail: "A-only revoke failure" }, 503));
    });
    expect(within(other).queryByText("A-only revoke failure")).toBeNull();
    expect(screen.queryByText("已停止此入口的订阅交付")).toBeNull();
    expect(f.writes).toHaveLength(1);
  } finally {
    f.finish(json({}, 200));
  }
});

it("keeps a completed publication from notifying or reopening a departed access task", async (context) => {
  const scenario = ownedClickScenario(context),
    f = fixture();
  f.setReadiness("OUTPUT_REPUBLISH_REQUIRED");
  const finish = f.holdNextPublish(),
    view = mountAccess(phone);
  try {
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    await scenario.click(() =>
      within(access).findByRole("button", { name: "检查更新" }),
    );
    const review = await screen.findByRole("dialog", {
      name: "检查订阅更新「Phone」",
    });
    const confirm = await within(review).findByRole("button", {
      name: "确认更新「Phone」",
    });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
    await scenario.click(() => confirm);
    await waitFor(() =>
      expect(f.writes.filter((w) => w.path.endsWith("/publish"))).toHaveLength(
        1,
      ),
    );
    view.setOutput(null);
    await act(async () => {
      finish(json({ ...phone, revision: "phone-updated" }));
    });
    await waitFor(() =>
      expect(view.client.getMutationCache().getAll().at(-1)?.state.status).toBe(
        "success",
      ),
    );
    expect(
      screen.queryByText("「Phone」已更新，其他客户端订阅保留原版本"),
    ).toBeNull();
    expect(screen.queryByRole("dialog", { name: "获取「Phone」" })).toBeNull();
    expect(f.accessReads).toHaveLength(1);
  } finally {
    finish(json(phone));
  }
});

for (const outcome of ["resolved", "rejected"] as const)
  it(`does not notify a departed access task when clipboard ${outcome}`, async (context) => {
    const scenario = ownedClickScenario(context),
      f = fixture();
    f.setReadiness("ready");
    let complete!: () => void, reject!: (error: Error) => void;
    const pending = new Promise<void>((resolve, fail) => {
      complete = resolve;
      reject = fail;
    });
    const writeText = vi.fn(() => pending);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const view = mountAccess(phone);
    try {
      const access = await screen.findByRole("dialog", {
        name: "获取「Phone」",
      });
      await within(access).findByRole("textbox", { name: "订阅链接" });
      await scenario.click(() =>
        within(access).getAllByRole("button", { name: "复制订阅链接" }).at(-1)!,
      );
      expect(writeText).toHaveBeenCalledTimes(1);
      view.setOutput(null);
      await act(async () => {
        if (outcome === "resolved") complete();
        else reject(new Error("Synthetic clipboard rejection"));
        await pending.catch(() => undefined);
      });
      expect(screen.queryByText("订阅链接已复制")).toBeNull();
      expect(
        screen.queryByText("自动复制未成功，请在下方选中链接手动复制。"),
      ).toBeNull();
      expect(f.writes).toHaveLength(0);
    } finally {
      complete();
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

it("keeps explicit recheck focus inside its persistent status without stealing a newer focus", async (context) => {
  const scenario = ownedClickScenario(context),
    f = fixture();
  mountAccess(phone);
  const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(access).findByText("平台入口尚未确认可用");
  const finish = f.holdNextAccess();
  try {
    await scenario.click(() =>
      within(access).getByRole("button", { name: "重新核对" }),
    );
    const status = within(access).getByRole("region", { name: "订阅获取状态" });
    expect(document.activeElement).toBe(status);
    expect(status.getAttribute("aria-busy")).toBe("true");
    const close = within(access).getByRole("button", { name: "关闭" });
    close.focus();
    await act(async () => {
      finish(
        json(
          {
            code: "OUTPUT_REPUBLISH_REQUIRED",
            detail: "Synthetic stale output",
          },
          409,
        ),
      );
    });
    await within(access).findByRole("button", { name: "检查更新" });
    expect(document.activeElement).toBe(close);
    expect(status.getAttribute("aria-busy")).not.toBe("true");
    expect(within(access).getByRole("status").textContent).toContain(
      "此订阅需要更新",
    );
    expect(f.writes).toHaveLength(0);
  } finally {
    finish(json({ code: "OUTPUT_ENTRY_UNCONFIRMED" }, 409));
  }
});

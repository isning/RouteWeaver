// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { useState, type ReactNode } from "react";
import Workspace from "./App";
import { StepsEditor } from "./Pipeline";
import type { PipelineStep } from "./types";
import { SourcesPage } from "./Sources";
import { sourceRowAction } from "./test-support/source-row-actions";
import { ProfilesPage } from "./Profiles";
import { BackupSettings } from "./Backup";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("real component user tasks (DOM, not browser rendering)", () => {
  it("retains a failed source form and retries the same source identity with corrected input", async () => {
    const bodies: Record<string, unknown>[] = [];
    let saved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method === "POST") {
          bodies.push(JSON.parse(init.body));
          if (bodies.length === 1)
            return json({ error: "Unsupported source fixture" }, 422);
          saved = true;
          return json({ ...bodies[1], snapshot: { endpoints: [] } }, 201);
        }
        return json(
          saved ? [{ ...bodies[1], snapshot: { endpoints: [] } }] : [],
        );
      }),
    );
    mount(<SourcesPage />);
    const user = userEvent.setup();
    await user.click(
      (await screen.findAllByRole("button", { name: "添加来源" }))[0],
    );
    await user.type(screen.getByLabelText("来源名称"), "My source");
    await user.click(screen.getByLabelText("节点链接或配置内容"));
    await user.paste("bad-node");
    await user.click(screen.getByRole("button", { name: "导入来源" }));
    await screen.findByText("Unsupported source fixture");
    expect((screen.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
      "My source",
    );
    expect(
      (screen.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toBe("bad-node");
    await user.clear(screen.getByLabelText("节点链接或配置内容"));
    // Subscription/share links are normally pasted, not typed character by character.
    // Keep the actual paste/input events and all identity/error/retry assertions.
    await user.paste("socks5://proxy.example.com:1080");
    await user.click(screen.getByRole("button", { name: "导入来源" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].id).toBe(bodies[0].id);
    expect(bodies[1].content).toBe("socks5://proxy.example.com:1080");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("explicit editing fetches credentials only from the authorized reveal endpoint", async () => {
    const source = {
      id: "src-edit",
      name: "Existing source",
      kind: "text",
      enabled: true,
    };
    const calls: string[] = [];
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push(String(url));
        if (init?.method === "PUT") {
          body = JSON.parse(init.body);
          return json(body);
        }
        if (String(url).endsWith("/reveal"))
          return json({
            ...source,
            content: "socks5://fixture:secret@example.com:1080",
          });
        if (String(url) === "/api/me/sources/src-edit") return json(source);
        return json([source]);
      }),
    );
    mount(<SourcesPage />);
    const user = userEvent.setup();
    await user.click(await sourceRowAction("编辑", "Existing source"));
    expect(calls).toContain("/api/me/sources/src-edit/reveal");
    expect(calls).toContain("/api/me/sources/src-edit");
    expect(
      (screen.getByLabelText("节点链接或配置内容") as HTMLTextAreaElement)
        .value,
    ).toContain("fixture:secret");
    await user.clear(screen.getByLabelText("来源名称"));
    await user.type(screen.getByLabelText("来源名称"), "Renamed");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(body?.content).toBe("socks5://fixture:secret@example.com:1080"),
    );
  });
  it("does not display a late profile preview for a newer draft", async () => {
    let resolve!: (v: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).endsWith("/profiles/preview")
          ? new Promise<Response>((r) => {
              resolve = r;
            })
          : json([]),
      ),
    );
    mount(<ProfilesPage />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "新建分流配置" }),
    );
    await user.type(await screen.findByLabelText("配置名称"), "Before");
    await user.click(screen.getByRole("tab", { name: "检查与预览" }));
    await user.click(screen.getByRole("button", { name: "预览配置" }));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await user.clear(screen.getByLabelText("配置名称"));
    await user.type(screen.getByLabelText("配置名称"), "After");
    resolve(json({ valid: true, content: "old-preview-marker" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "预览配置" }).className,
      ).not.toContain("loading"),
    );
    expect(screen.queryByText("old-preview-marker")).toBeNull();
    expect((screen.getByLabelText("配置名称") as HTMLInputElement).value).toBe(
      "After",
    );
  });
  it("invalidates an in-flight backup preview when the passphrase changes", async () => {
    let resolve!: (v: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    mount(<BackupSettings />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText("选择加密备份"),
      new File(["encrypted-fixture"], "test.age", {
        type: "application/octet-stream",
      }),
    );
    await user.type(screen.getByLabelText("备份密码"), "fixture-password");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "校验备份并查看影响",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      screen.getByRole("button", { name: "校验备份并查看影响" }),
    );
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await user.type(screen.getByLabelText("备份密码"), "changed");
    resolve(
      json({
        manifest: { schemaVersion: 2, createdAt: "2026-10-01T00:00:00Z" },
        digest: "stale",
        counts: { records: 1 },
        restoreAvailable: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "校验备份并查看影响" }).className,
      ).not.toContain("loading"),
    );
    expect(screen.queryByText("文件校验通过", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复到新数据库" })).toBeNull();
  });
});

it("protects unsaved profile changes when navigating by keyboard", async () => {
  history.replaceState(null, "", "#profiles");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/auth/me")
        ? json({
            user: { id: "u", name: "User", role: "user" },
            csrfToken: "test-csrf",
          })
        : json([]),
    ),
  );
  mount(<Workspace />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建分流配置" }));
  await user.type(await screen.findByLabelText("配置名称"), "Keep this draft");
  await user.click(screen.getByText("订阅素材"));
  const target = screen.getByRole("button", { name: "订阅来源" });
  for (let attempt = 0; attempt < 2; attempt++) {
    target.focus();
    await user.keyboard("{Enter}");
    const keep = await screen.findByRole("button", { name: "继续编辑" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect((screen.getByLabelText("配置名称") as HTMLInputElement).value).toBe(
      "Keep this draft",
    );
    expect(location.hash).toBe("#profiles");
  }
});
it("reorders processing steps using the keyboard without changing their identities", async () => {
  function Editor() {
    const [steps, setSteps] = useState<PipelineStep[]>([
      { id: "first", enabled: true, kind: "rename", template: "First {name}" },
      {
        id: "second",
        enabled: true,
        kind: "rename",
        template: "Second {name}",
      },
    ]);
    return (
      <>
        <StepsEditor value={steps} onChange={setSteps} />
        <output aria-label="step identities">
          {steps.map((s) => s.id).join(",")}
        </output>
      </>
    );
  }
  mount(<Editor />);
  const user = userEvent.setup();
  screen.getByRole("button", { name: "下移步骤 1" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("step identities").textContent).toBe(
    "second,first",
  );
  expect(
    (screen.getByLabelText("步骤 1 命名模板") as HTMLInputElement).value,
  ).toBe("Second {name}");
});
it("keeps the existing reset anchor and hidden service limits when saving ordinary service fields", async () => {
  const { AdminPage } = await import("./Admin");
  const service = {
    id: "plan",
    name: "Existing plan",
    quotaBytes: 1073741824,
    routeIds: [],
    cycle: {
      mode: "anniversary",
      anchor: "2024-01-31T03:00:00Z",
      timezone: "UTC+8",
    },
    onlineIpLimit: 3,
    connectionLimit: 0,
    entryRateBps: 12345,
  };
  const fixture = serviceEditFixture(service);
  let saved: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/access-policy/edit-context/service/plan")
        return json(fixture.context());
      if (String(url).endsWith("/access-policy/preview")) {
        const body = JSON.parse(init.body);
        expect(body.precondition).toEqual({
          exists: true,
          revision: "opened-service",
        });
        return json(
          fixture.preview(body.change.service, {
            revision: "preserve-service",
            affected: [],
            blockers: [],
          }),
        );
      }
      if (String(url).endsWith("/access-policy/apply")) {
        saved = JSON.parse(init.body).change.service;
        return json({
          revision: "preserve-service",
          affected: [],
          blockers: [],
        });
      }
      if (url === "/api/state")
        return json({
          nodes: [],
          users: [],
          routes: [],
          revisions: [],
          capabilities: [],
        });
      if (url === "/api/services") return json([service]);
      if (url === "/api/settings")
        return json({
          name: "Test",
          timezone: "UTC+8",
          registration: "invite",
        });
      return json([]);
    }),
  );
  mount(<AdminPage page="services" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /编\s*辑/ }));
  await user.click(await screen.findByRole("button", { name: "预览影响" }));
  await screen.findByText("确认授权变更");
  await user.click(screen.getByRole("checkbox", { name: /我已核对/ }));
  await user.click(screen.getByRole("button", { name: "更新授权" }));
  await waitFor(() => expect(saved?.cycle.anchor).toBe(service.cycle.anchor));
  expect(saved.onlineIpLimit).toBe(3);
  expect(saved.entryRateBps).toBe(12345);
});
it("does not discard saved channel settings or send notifications when saving ordinary reminder fields", async () => {
  const { NotificationsAdminPage } = await import("./Notifications");
  const settings = {
    revision: 3,
    inApp: true,
    quotaPercent: [80, 100],
    expiryHours: [24],
    providerRemainingPercent: [10],
    repeatHours: 24,
    email: {
      enabled: false,
      automatic: false,
      host: "smtp.example.com",
      port: 587,
      tlsMode: "starttls",
      username: "fixture",
      from: "ops@example.com",
      to: ["ops@example.com"],
    },
    webhook: { enabled: false, automatic: false, url: "" },
    smtpPasswordSet: true,
    webhookSecretSet: false,
  };
  let saved: any;
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      requests.push(`${init?.method || "GET"} ${url}`);
      if (init?.method === "PUT") {
        saved = JSON.parse(init.body);
        return json({ ...settings, ...saved, revision: 4 });
      }
      if (url === "/api/admin/notification-settings") return json(settings);
      if (url === "/api/state")
        return json({ users: [], nodes: [], routes: [] });
      return json([]);
    }),
  );
  mount(<NotificationsAdminPage />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "提醒与渠道" }));
  await user.click(await screen.findByRole("button", { name: "保存通知设置" }));
  await waitFor(() => expect(saved?.email).toEqual(settings.email));
  expect(saved.webhook).toEqual(settings.webhook);
  expect(saved.smtpPassword).toBeUndefined();
  expect(requests.some((r) => r.includes("/notifications/test"))).toBe(false);
});
it("keyboard skip-to-content does not change the active page", async () => {
  history.replaceState(null, "", "#profiles");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      url === "/api/auth/me"
        ? json({
            user: { id: "u", name: "User", role: "member" },
            csrfToken: "csrf",
          })
        : json([]),
    ),
  );
  mount(<Workspace />);
  const user = userEvent.setup();
  const skip = await screen.findByRole("link", { name: "跳至主要内容" });
  skip.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement?.id).toBe("main");
  expect(location.hash).toBe("#profiles");
});
it("rotates a managed entry through its public route without opening the legacy credential editor", async () => {
  const { UserEntries } = await import("./UserEntries");
  const posts: { url: string; body: any }[] = [];
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      fetched.push(String(url));
      if (init?.method === "POST") {
        posts.push({ url: String(url), body: JSON.parse(init.body) });
        return json({ status: "pending-deployment" });
      }
      if (String(url).endsWith("/entries"))
        return json([
          {
            id: "managed-entry",
            name: "Private entry",
            routeId: "public-route",
            publishedRouteId: "public-route",
            status: "pending-deployment",
            credentialVersion: "v1",
          },
        ]);
      return json({});
    }),
  );
  mount(
    <UserEntries
      user={{
        id: "u",
        name: "Member",
        enabled: true,
        quotaBytes: 0,
        usedBytes: 0,
      }}
      routes={[]}
      services={[]}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByText("尚未确认生效")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^编\s*辑$/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "轮换凭据" }));
  await user.click(await screen.findByRole("button", { name: "准备新凭据" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0].url).toBe("/api/published-routes/public-route/principals");
  expect(posts[0].body).toMatchObject({
    accountId: "u",
    entryId: "managed-entry",
  });
  expect(posts[0].body.credentialVersion).not.toBe("v1");
  expect(fetched.some((url) => url.endsWith("/reveal"))).toBe(false);
});
it("shows a failed source request as a retryable error rather than an empty collection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      url === "/api/me/sources"
        ? json({ error: "Source list unavailable" }, 503)
        : json([]),
    ),
  );
  mount(<ProfilesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建分流配置" }));
  expect(await screen.findByText("Source list unavailable")).toBeTruthy();
  expect(screen.queryByText(/还没有私有来源/)).toBeNull();
  expect(screen.getByRole("button", { name: "重新加载来源" })).toBeTruthy();
});
it("reveals a server deployment only on edit and preserves its hidden TLS material on save", async () => {
  const { ServerRoutesPage } = await import("./ServerRoutes");
  const core = {
    id: "core",
    hostId: "host",
    adapterId: "routeweaver/xray",
    version: "26.3.27",
  };
  const endpoint = {
    id: "entry",
    instanceId: "core",
    name: "Entry",
    connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
  };
  const summary = {
    id: "deployment",
    name: "Private path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "r1",
      programs: [
        {
          instance: core,
          listener: endpoint,
          egress: [],
          rules: [],
          resources: [],
        },
      ],
    },
  };
  const full = {
    ...summary,
    ir: {
      ...summary.ir,
      programs: [
        {
          ...summary.ir.programs[0],
          listener: {
            ...endpoint,
            connection: { ...endpoint.connection, uuid: "synthetic-uuid" },
          },
          tls: {
            certificatePem: "synthetic-cert",
            privateKeyPem: "synthetic-private-key",
          },
        },
      ],
    },
  };
  let revealed = false;
  let saved: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "PUT") {
        saved = JSON.parse(init.body);
        return json(summary);
      }
      if (url === "/api/server-deployments/deployment/reveal") {
        revealed = true;
        return json(full);
      }
      if (url === "/api/server-deployments") return json([summary]);
      if (url === "/api/managed-endpoints") return json([endpoint]);
      if (url === "/api/core-instances") return json([core]);
      if (url === "/api/hosts")
        return json([{ id: "host", name: "Host", address: "example.com" }]);
      return json([]);
    }),
  );
  mount(<ServerRoutesPage />);
  const user = userEvent.setup();
  const edit = await screen.findByRole("button", {
    name: "编辑转发路径 Private path",
  });
  expect(revealed).toBe(false);
  await user.click(edit);
  await screen.findByLabelText("转发路径名称");
  expect(revealed).toBe(true);
  expect(screen.queryByDisplayValue("synthetic-private-key")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(saved?.ir.programs[0].tls.privateKeyPem).toBe(
      "synthetic-private-key",
    ),
  );
  expect(saved.ir.programs[0].listener.connection.uuid).toBe("synthetic-uuid");
});

async function templateUpdateFixture(
  mode: "pinned" | "follow",
  platform = false,
) {
  const { TemplatesPage } = await import("./Templates");
  const v1 = {
    id: "library",
    name: "Routing library",
    kind: "client-profile",
    version: 1,
    spec: {
      endpointSlots: [
        { id: "keep", name: "Shared slot" },
        { id: "retired", name: "Version one slot" },
      ],
    },
  };
  const v2 = {
    ...v1,
    version: 2,
    spec: { endpointSlots: [{ id: "keep", name: "Shared slot" }] },
  };
  const binding = {
    id: "profiles_profile",
    templateId: "library",
    targetKind: "profiles",
    targetId: "profile",
    mode,
    appliedVersion: 1,
    bindings: { endpoints: { keep: "owned", retired: "obsolete" } },
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return json({
          candidateVersion: mode === "pinned" ? 1 : 2,
          currentVersion: 1,
          compatible: true,
          hasUpdate: mode === "follow",
          diagnostics: [],
          changes: ["groups"],
          preservedLocalEdits: [],
          previewDigest: "digest",
          artifacts: [],
        });
      }
      if (url === "/api/templates") return json([v2]);
      if (url === "/api/templates/library/versions") return json([v2, v1]);
      if (url === "/api/me/template-bindings") return json([binding]);
      if (url === "/api/me/platform-entries")
        return json(
          platform
            ? [
                { id: "owned", name: "Selected platform entry" },
                { id: "not-selected", name: "Unselected platform entry" },
              ]
            : [],
        );
      if (url === "/api/me/profiles")
        return json([
          {
            id: "profile",
            name: "My profile",
            platformEntryIds: platform ? ["owned"] : [],
            ir: { endpoints: [], groups: [], rules: [], resources: [] },
          },
        ]);
      return json([]);
    }),
  );
  mount(<TemplatesPage />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "我的引用" }));
  await user.click(
    await screen.findByRole("button", {
      name: `${mode === "pinned" ? "查看固定版本" : "检查更新"} My profile`,
    }),
  );
  return { requests, user };
}
it("shows and previews the exact pinned template version rather than the latest spec", async () => {
  const { requests } = await templateUpdateFixture("pinned");
  expect(await screen.findByText("Version one slot")).toBeTruthy();
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].body.version).toBe(1);
  expect(requests[0].body.bindings.endpoints).toEqual({
    keep: "owned",
    retired: "obsolete",
  });
});
it("drops removed template slots and submits the same exact version and bindings on preview and apply", async () => {
  const { requests, user } = await templateUpdateFixture("follow");
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].body).toMatchObject({
    version: 2,
    bindings: { endpoints: { keep: "owned" } },
  });
  expect(requests[0].body.bindings.endpoints.retired).toBeUndefined();
  await user.click(await screen.findByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1].body).toEqual({
    ...requests[0].body,
    previewDigest: "digest",
  });
});
it("explains that announcements are in-app only, not automatic external messages", async () => {
  const { NotificationsAdminPage } = await import("./Notifications");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      url === "/api/state"
        ? json({ users: [], nodes: [], routes: [] })
        : json([]),
    ),
  );
  mount(<NotificationsAdminPage />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "创建公告" }));
  expect(screen.getByText(/公告仅在站内/)).toBeTruthy();
  expect(screen.queryByText(/外部通知按已启用/)).toBeNull();
});

function observationFixture() {
  const now = new Date().toISOString();
  return {
    nodeId: "host",
    config: {
      revision: 1,
      observerInstanceId: "core",
      billedInterfaces: ["eth0"],
      provider: {
        name: "Example provider",
        mode: "limited",
        allowance: 2,
        unit: "TB",
        cycleId: "cycle",
        cycleStart: new Date(Date.now() - 3600000).toISOString(),
        cycleEnd: new Date(Date.now() + 3600000).toISOString(),
        notificationSource: "nic_estimate",
        exhaustionAction: "advisory",
      },
    },
    latest: {
      digest: "sample-one",
      observedAt: now,
      receivedAt: now,
      source: "linux_procfs",
      continuity: "initial",
      cpuPercent: null,
      receiveBytesPerSecond: null,
      transmitBytesPerSecond: null,
      metrics: {
        memoryTotalBytes: 4096,
        memoryAvailableBytes: 2048,
        load1: 0.2,
        load5: 0.1,
        load15: 0.1,
        interfaces: [{ name: "eth0", receiveBytes: 1000, transmitBytes: 2000 }],
      },
    },
    provider: {
      source: "nic_estimate",
      coverage: "partial",
      statusReason: "initial_observation_requires_baseline",
      fresh: true,
      observedAt: now,
      observedSince: now,
      observedNicBytes: 0,
      totalBytes: 2000000000000,
      usedBytes: null,
      remainingBytes: null,
      exhaustionAction: "advisory",
      notificationEligible: false,
    },
  };
}
it("does not display unknown provider usage or initial CPU as zero", async () => {
  const { NodeObservation } = await import("./NodeObservation");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(observationFixture())),
  );
  mount(
    <NodeObservation
      host={{ id: "host", name: "Host", address: "example.com" }}
      instances={[]}
    />,
  );
  expect(await screen.findByText("等待下一次采样")).toBeTruthy();
  expect(screen.getAllByText("未确定")).toHaveLength(2);
  expect(screen.queryByLabelText("供应商周期额度使用比例")).toBeNull();
  expect(screen.queryByText("0.0%")).toBeNull();
});
it("keeps a rejected provider reconciliation input and requires an explicit fresh sample before retry", async () => {
  const { ProviderMeasurementForm } = await import("./ObservationForms");
  const fixture = observationFixture();
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body));
        return bodies.length === 1
          ? json({ error: "Latest report changed; review again" }, 409)
          : json(fixture);
      }
      return json({
        ...fixture,
        latest: { ...fixture.latest, digest: "sample-two" },
      });
    }),
  );
  const closed = vi.fn();
  mount(
    <ProviderMeasurementForm
      initial={fixture as any}
      kind="baseline"
      onClose={closed}
    />,
  );
  const user = userEvent.setup();
  expect(
    (screen.getByLabelText("本周期实际已用") as HTMLInputElement).value,
  ).toBe("");
  await user.type(screen.getByLabelText("本周期实际已用"), "5");
  await user.type(
    screen.getByLabelText("核对依据与说明"),
    "Checked the provider console at the sampled time",
  );
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "保存核对结果" }));
  expect(
    await screen.findByText("Latest report changed; review again"),
  ).toBeTruthy();
  expect(bodies[0]).toMatchObject({
    reportDigest: "sample-one",
    usedBytes: 5000000000,
  });
  expect(
    (screen.getByLabelText("本周期实际已用") as HTMLInputElement).value,
  ).toBe("5");
  await user.click(
    screen.getByRole("button", { name: "读取最新采样用于核对" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(
    (screen.getByRole("button", { name: "保存核对结果" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "保存核对结果" }));
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(bodies[1]).toMatchObject({
    reportDigest: "sample-two",
    usedBytes: 5000000000,
  });
});
it("preserves explicit provider cycle identity while editing ordinary observation settings", async () => {
  const { ObservationConfigForm } = await import("./ObservationForms");
  const fixture = observationFixture();
  Object.assign(fixture.config.provider, {
    cycleStart: "2026-10-01T08:00:27.125+08:00",
    cycleEnd: "2026-11-01T08:00:42.875+08:00",
    expiresAt: "2026-12-01T08:30:19.500+08:00",
  });
  let saved: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      saved = JSON.parse(init.body);
      return json(fixture);
    }),
  );
  mount(
    <ObservationConfigForm
      initial={fixture as any}
      instances={[]}
      onClose={() => {}}
    />,
  );
  for (const label of ["主机采集实例", "供应商计费网卡"]) {
    const input = screen.getByRole("combobox", { name: label });
    const description = input.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    expect(
      document.getElementById(description!)?.textContent?.length,
    ).toBeGreaterThan(10);
  }
  fireEvent.change(screen.getByLabelText("周期额度"), {
    target: { value: "3" },
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "保存采集与额度设置" }));
  await waitFor(() => expect(saved?.provider.cycleId).toBe("cycle"));
  expect(saved.provider).toMatchObject({
    allowance: 3,
    cycleStart: "2026-10-01T08:00:27.125+08:00",
    cycleEnd: "2026-11-01T08:00:42.875+08:00",
    expiresAt: "2026-12-01T08:30:19.500+08:00",
  });
  expect(saved.revision).toBe(1);
  expect(saved.billedInterfaces).toEqual(["eth0"]);
});
it("saves an explicitly edited provider date and removes a cleared expiry", async () => {
  const { ObservationConfigForm } = await import("./ObservationForms");
  const fixture = observationFixture();
  Object.assign(fixture.config.provider, {
    cycleStart: "2026-10-01T08:00:27.125+08:00",
    cycleEnd: "2026-11-01T08:00:42.875+08:00",
    expiresAt: "2026-12-01T08:30:19.500+08:00",
  });
  let saved: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      saved = JSON.parse(init.body);
      return json(fixture);
    }),
  );
  mount(
    <ObservationConfigForm
      initial={fixture as any}
      instances={[]}
      onClose={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("周期结束（浏览器当地时间）"), {
    target: { value: "2026-11-02T08:45" },
  });
  fireEvent.change(screen.getByLabelText("服务到期时间（可选）"), {
    target: { value: "" },
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "保存采集与额度设置" }));
  await waitFor(() => expect(saved).toBeTruthy());
  expect(saved.provider.cycleStart).toBe("2026-10-01T08:00:27.125+08:00");
  expect(saved.provider.cycleEnd).toBe(
    new Date(2026, 10, 2, 8, 45).toISOString(),
  );
  expect(saved.provider.expiresAt).toBeUndefined();
});

it("saves unlimited provider service without inventing a cycle or allowance", async () => {
  const { ObservationConfigForm } = await import("./ObservationForms");
  const fixture = observationFixture();
  const provider = {
    ...fixture.config.provider,
    mode: "unlimited",
    allowance: 0,
    cycleId: "",
    cycleStart: "",
    cycleEnd: "",
    notificationSource: "none",
  };
  let saved: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      saved = JSON.parse(init.body);
      return json(fixture);
    }),
  );
  mount(
    <ObservationConfigForm
      initial={{ ...fixture, config: { ...fixture.config, provider } } as any}
      instances={[]}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByLabelText("周期开始（浏览器当地时间）")).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "保存采集与额度设置" }));
  await waitFor(() => expect(saved?.provider.mode).toBe("unlimited"));
  expect(saved.provider).toMatchObject({
    allowance: 0,
    notificationSource: "none",
  });
  expect(saved.provider.cycleStart).toBeUndefined();
  expect(saved.provider.cycleEnd).toBeUndefined();
  expect(saved.provider.cycleId).toBeUndefined();
});

it("keeps malformed native client text after a rejected preview and saves the exact draft", async () => {
  let saved: Record<string, any> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/profiles/preview"))
        return json({ error: "Native override JSON is incomplete" }, 422);
      if (String(url).endsWith("/profiles") && init?.method === "POST") {
        saved = JSON.parse(init.body);
        return json(
          {
            ...saved,
            status: "draft",
            diagnostics: ["Native override JSON is incomplete"],
          },
          201,
        );
      }
      return json([]);
    }),
  );
  mount(<ProfilesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建分流配置" }));
  await user.type(screen.getByLabelText("配置名称"), "Native draft");
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByText("高级：目标原生覆盖"));
  await user.click(screen.getByRole("button", { name: "添加原生覆盖" }));
  fireEvent.change(screen.getByLabelText("原生配置文本"), {
    target: { value: '{"dns":' },
  });
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("Native override JSON is incomplete");
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByText("高级：目标原生覆盖"));
  expect(
    (screen.getByLabelText("原生配置文本") as HTMLTextAreaElement).value,
  ).toBe('{"dns":');
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(saved?.ir.nativeOverride).toEqual({
      schemaVersion: "1",
      namespace: "routeweaver/native-client",
      target: { adapterId: "mihomo", version: "1.19.32" },
      format: "json",
      ruleMode: "prepend",
      content: '{"dns":',
    }),
  );
});

it("keeps native text and its original binding when the profile client changes", async () => {
  let submitted: Record<string, any> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/profiles/preview")) {
        submitted = JSON.parse(init.body);
        return json({ error: "NATIVE_TARGET_MISMATCH" }, 422);
      }
      return json([]);
    }),
  );
  mount(<ProfilesPage />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "新建分流配置" }));
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByText("高级：目标原生覆盖"));
  await user.click(screen.getByRole("button", { name: "添加原生覆盖" }));
  const content = '{"dns":{"enhanced-mode":"fake-ip"}}';
  fireEvent.change(screen.getByLabelText("原生配置文本"), {
    target: { value: content },
  });
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("combobox", { name: "预览客户端" }));
  await user.click(
    await screen.findByText("sing-box", {
      selector: "[cmdk-item] span",
    }),
  );
  expect(await screen.findByText("原生覆盖的客户端绑定需要调整")).toBeTruthy();
  expect(
    screen.getByText(
      "原文和原绑定已保留；到运行设置中检查，不能按当前草稿客户端直接发布。",
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "检查运行设置" }));
  await user.click(screen.getByText("高级：目标原生覆盖"));
  expect(
    await screen.findByText("原生覆盖与当前客户端版本不一致"),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText("原生配置文本") as HTMLTextAreaElement).value,
  ).toBe(content);
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("NATIVE_TARGET_MISMATCH");
  expect(submitted?.target).toEqual({
    adapterId: "sing-box",
    version: "1.14.3",
  });
  expect(submitted?.ir.nativeOverride.target).toEqual({
    adapterId: "mihomo",
    version: "1.19.32",
  });
  expect(submitted?.ir.nativeOverride.content).toBe(content);
});

it("shows an unconfirmed diagnostic outcome without inventing zero traffic or throughput", async () => {
  const { DiagnosticsPanel } = await import("./Diagnostics");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/diagnostic-targets")
        ? json([])
        : json([
            {
              id: "job",
              instanceId: "core",
              targetId: "target",
              kind: "download",
              maxBytes: 1048576,
              timeoutSeconds: 10,
              scope: { nodeId: "host", instanceId: "core" },
              target: {
                id: "target",
                name: "My probe",
                nodeId: "host",
                url: "https://example.com/test",
                methods: ["download"],
              },
              requestedAt: "2026-10-19T19:00:00Z",
              expiresAt: "2026-10-19T19:02:00Z",
              direction: "target_to_node",
              estimatedMaxBytes: 1048576,
              costBasis: "application_payload_not_wire_or_provider_billing",
              status: "unknown",
            },
          ]),
    ),
  );
  mount(
    <DiagnosticsPanel
      host={{ id: "host", name: "Host", address: "example.com" }}
      instances={[]}
    />,
  );
  await screen.findByText("结果未确认");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "查看测试结果" }));
  expect(
    await screen.findByText("未收到完整计量，不能认定没有产生流量。"),
  ).toBeTruthy();
  expect(screen.queryByText("0 B/s")).toBeNull();
  expect(screen.queryByText("0 B")).toBeNull();
});

it("requires explicit diagnostic confirmation and preserves the same request identity after a rejected submission", async () => {
  const { DiagnosticStartForm } = await import("./Diagnostics");
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return json({ error: "Node enrollment is unavailable" }, 422);
    }),
  );
  mount(
    <DiagnosticStartForm
      targets={[
        {
          id: "target",
          nodeId: "host",
          name: "Owned test target",
          url: "https://example.com/probe",
          methods: ["connectivity"],
        },
      ]}
      instances={[
        {
          id: "core",
          hostId: "host",
          name: "Test core",
          adapterId: "routeweaver/xray",
          version: "26.3.27",
          enabled: true,
        } as any,
      ]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const user = userEvent.setup();
  for (const [label, option] of [
    ["执行实例", "Test core"],
    ["授权目标", "Owned test target"],
    ["测试方式", "连通性"],
  ]) {
    fireEvent.click(screen.getByLabelText(label));
    await user.click(
      await screen.findByText(option, {
        selector: "[cmdk-item] span",
      }),
    );
  }
  await user.click(screen.getByRole("button", { name: "提交测试" }));
  await screen.findByText("请确认测试目标与流量上限");
  expect(bodies).toHaveLength(0);
  await user.click(
    screen.getByLabelText("我确认目标与测试上限，提交后由节点执行"),
  );
  await user.click(screen.getByRole("button", { name: "提交测试" }));
  await screen.findByText("Node enrollment is unavailable");
  await user.click(screen.getByRole("button", { name: "提交测试" }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    targetId: "target",
    instanceId: "core",
    kind: "connectivity",
    maxBytes: 0,
    timeoutSeconds: 10,
  });
});

it("shows the last effective public address separately from pending draft changes", async () => {
  const { PublishedRoutesPage } = await import("./PublishedRoutes");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/published-routes")
        ? json([
            {
              id: "route",
              name: "Public route",
              deploymentId: "deployment",
              endpointIds: [],
              publicHost: "draft.example.com",
              publicPort: 23456,
              status: "effective",
              pendingChanges: true,
              effective: {
                publicHost: "active.example.com",
                publicPort: 443,
                endpointIds: [],
                fingerprint: "applied",
              },
              diagnostics: [],
            },
          ])
        : json([]),
    ),
  );
  mount(<PublishedRoutesPage />);
  expect(await screen.findByText("草稿待应用")).toBeTruthy();
  expect(screen.getByText("active.example.com:443")).toBeTruthy();
  expect(screen.queryByText("draft.example.com:23456")).toBeNull();
});

it("retries only explicitly selected known-failed fleet targets and never repeats a successful target", async () => {
  const { FleetBatchDetail } = await import("./Fleet");
  const targets = [
    {
      instanceId: "success",
      nodeId: "host1",
      name: "Completed core",
      stage: 0,
      status: "succeeded",
      supported: true,
      affectedRouteIds: [],
      affectedUsers: 0,
      changes: [],
      diagnostics: [],
      attempts: [],
    },
    {
      instanceId: "failed",
      nodeId: "host2",
      name: "Failed core",
      stage: 0,
      status: "failed",
      supported: true,
      affectedRouteIds: [],
      affectedUsers: 0,
      changes: [],
      diagnostics: [],
      attempts: [],
    },
    {
      instanceId: "future",
      nodeId: "host3",
      name: "Next stage core",
      stage: 1,
      status: "planned",
      supported: true,
      affectedRouteIds: [],
      affectedUsers: 0,
      changes: [],
      diagnostics: [],
      attempts: [],
    },
  ];
  const batch = {
    id: "batch",
    action: "configure",
    deploymentId: "deployment",
    targets,
    status: "partial_failure",
    affectedUsers: 0,
    supported: true,
    diagnostics: [],
    createdAt: "2026-10-19T19:00:00Z",
    leaseSeconds: 300,
  };
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "POST") sent = JSON.parse(init.body);
      return json(batch);
    }),
  );
  mount(<FleetBatchDetail id="batch" onClose={() => {}} />);
  const user = userEvent.setup();
  await screen.findByText("Failed core");
  expect(
    (screen.getByRole("button", { name: "执行第 2 阶段" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByLabelText("选择重试 Failed core"));
  await user.click(screen.getByRole("button", { name: "重试所选失败目标" }));
  await user.click(await screen.findByRole("button", { name: "确认重试" }));
  await waitFor(() => expect(sent?.targetIds).toEqual(["failed"]));
  expect(sent.requestId).toBeTruthy();
});

it("discards an older fleet impact preview when the planned operation changes", async () => {
  const { FleetPlanForm } = await import("./Fleet");
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) =>
      String(url).endsWith("/preview")
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : json([]),
    ),
  );
  mount(
    <FleetPlanForm
      inventory={
        {
          hosts: [{ id: "host", name: "Host", address: "example.com" }],
          instances: [
            {
              id: "core",
              hostId: "host",
              name: "Core",
              adapterId: "routeweaver/xray",
              version: "26.3.27",
            },
          ],
          endpoints: [],
          links: [],
          deployments: [
            {
              id: "deployment",
              name: "Path fixture",
              ir: { programs: [{ instance: { id: "core" } }] },
            },
          ],
        } as any
      }
      history={[]}
      onClose={() => {}}
      onCreated={() => {}}
    />,
  );
  const user = userEvent.setup();
  fireEvent.click(screen.getByLabelText("批量变更转发路径"));
  await user.click(
    await screen.findByText("Path fixture", {
      selector: "[cmdk-item] span",
    }),
  );
  await user.click(screen.getByLabelText("选择实例 Core"));
  await user.click(screen.getByRole("button", { name: "预览影响与差异" }));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  fireEvent.click(screen.getByLabelText("批量操作"));
  await user.click(
    await screen.findByText("停止核心", {
      selector: "[cmdk-item] span",
    }),
  );
  resolve(
    json({
      fingerprint: "stale-review",
      targets: [],
      affectedUsers: 0,
      supported: true,
      diagnostics: [],
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "预览影响与差异" }).className,
    ).not.toContain("loading"),
  );
  expect(screen.queryByRole("button", { name: "创建待执行批次" })).toBeNull();
});

it("uploads an encrypted backup as ordered multipart file data without a JSON content-type or base64 copy", async () => {
  let body: unknown, headers: Headers | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      body = init.body;
      headers = init.headers;
      return json(
        { error: "Synthetic archive rejected without changing live data" },
        422,
      );
    }),
  );
  mount(<BackupSettings />);
  const user = userEvent.setup(),
    archive = new File(["synthetic encrypted bytes"], "backup.age", {
      type: "application/octet-stream",
    });
  await user.upload(screen.getByLabelText("选择加密备份"), archive);
  await user.type(
    screen.getByLabelText("备份密码"),
    "synthetic-long-passphrase",
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "校验备份并查看影响",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "校验备份并查看影响" }));
  await screen.findByText(
    "Synthetic archive rejected without changing live data",
  );
  expect(body).toBeInstanceOf(FormData);
  const parts = [...(body as FormData).entries()];
  expect(parts.map(([name]) => name)).toEqual(["metadata", "archive"]);
  expect(JSON.parse(String(parts[0][1]))).toEqual({
    password: "synthetic-long-passphrase",
  });
  expect((parts[1][1] as File).name).toBe("backup.age");
  expect(headers?.has("Content-Type")).toBe(false);
});

it("keeps the profile's selected platform entries available when reviewing template updates", async () => {
  await templateUpdateFixture("follow", true);
  expect(await screen.findByText("Selected platform entry")).toBeTruthy();
  expect(screen.queryByText("Unselected platform entry")).toBeNull();
});

it("reviews an existing output with its exact output identity before republishing it", async () => {
  const { UpdateOutput } = await import("./Subscriptions");
  const calls: { url: string; body: any }[] = [];
  const output = {
    id: "existing-output",
    profileId: "saved-profile",
    name: "Existing subscription",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    status: "published",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return json(
        String(url).endsWith("/preview")
          ? {
              valid: true,
              previewDigest: "a".repeat(64),
              outputId: output.id,
              previewScope: "output-update",
              publicationEffect: { version: 1, link: "preserve" },
              artifacts: [
                { path: "config.yaml", content: "stable-output-specific-name" },
              ],
            }
          : output,
      );
    }),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  const user = userEvent.setup();
  expect(
    (
      screen.getByRole("button", {
        name: "确认更新「Existing subscription」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await user.click(
    await screen.findByRole("button", { name: "查看待发布技术配置" }),
  );
  await screen.findByText("stable-output-specific-name");
  expect(calls[0]).toEqual({
    url: "/api/me/profiles/saved-profile/preview",
    body: { outputId: "existing-output", target: output.target, mode: "full" },
  });
  await user.click(
    screen.getByRole("button", { name: "确认更新「Existing subscription」" }),
  );
  await waitFor(() =>
    expect(calls[1]?.url).toBe("/api/me/outputs/existing-output/publish"),
  );
  expect(calls[1].body).toEqual({ previewDigest: "a".repeat(64) });
});

it("requires a fresh subscription review after a stale-digest rejection", async () => {
  const { UpdateOutput } = await import("./Subscriptions");
  let previews = 0;
  const publishes: any[] = [];
  const output = {
    id: "output",
    profileId: "profile",
    name: "Subscription",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    status: "published",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: (++previews).toString(16).repeat(64),
          outputId: output.id,
          previewScope: "output-update",
          publicationEffect: { version: 1, link: "preserve" },
          artifacts: [],
        });
      publishes.push(JSON.parse(init.body));
      return publishes.length === 1
        ? json({ error: "Subscription changed; preview again" }, 409)
        : json(output);
    }),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "确认更新「Subscription」",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole("button", { name: "确认更新「Subscription」" }),
  );
  await screen.findByText("Subscription changed; preview again");
  expect(
    (
      screen.getByRole("button", {
        name: "确认更新「Subscription」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "确认更新「Subscription」",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(
    screen.getByRole("button", { name: "确认更新「Subscription」" }),
  );
  await waitFor(() => expect(publishes).toHaveLength(2));
  expect(publishes).toEqual([
    { previewDigest: "1".repeat(64) },
    { previewDigest: "2".repeat(64) },
  ]);
});

it("shows a neutral empty state and keeps add-step selection ready for another action", async () => {
  function Editor() {
    const [steps, setSteps] = useState<PipelineStep[]>([]);
    return <StepsEditor value={steps} onChange={setSteps} />;
  }
  mount(<Editor />);
  const user = userEvent.setup();
  expect(screen.getByText("未添加处理步骤")).toBeTruthy();
  expect(screen.queryByText(/保留所有节点|添加步骤，开始整理/)).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "添加处理步骤" }));
  await user.click(
    await screen.findByText("重新命名", {
      selector: "[cmdk-item] span",
    }),
  );
  expect(screen.queryByText("未添加处理步骤")).toBeNull();
  expect(
    screen.getByText("添加处理步骤", { selector: "[role=combobox] span" }),
  ).toBeTruthy();
  const sourceNameHelp = screen.getByText("来源名称");
  expect(
    within(sourceNameHelp).getByText("{source}", { selector: "code" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: "添加处理步骤" }));
  await user.click(
    await screen.findByText("重新命名", {
      selector: "[cmdk-item] span",
    }),
  );
  expect(screen.getByLabelText("步骤 2 命名模板")).toBeTruthy();
});

// @vitest-environment jsdom
// Reconstructed after workspace reset: synthetic public HTTP reads only.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
import { AdminPage } from "./Admin";
import { AccountSecurityPage } from "./AccountSecurity";
import { ServerRoutesPage } from "./ServerRoutes";
import { BasicRouting } from "./BasicRouting";
import { RateSettings } from "./Rates";
import { UserGroups } from "./AccessPolicy";
import { NodeObservation } from "./NodeObservation";
import { InstanceObservation } from "./Infrastructure";
import { SubscriptionOriginSettings } from "./SubscriptionOriginSettings";
import { DiagnosticsPanel, DiagnosticStartForm } from "./Diagnostics";
import { FleetBatchDetail, FleetPlanForm } from "./Fleet";
import { UserEntries } from "./UserEntries";
import { emptyProfile } from "./model";
import type { Infrastructure, Session } from "./types";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const session: Session = {
  user: { id: "admin-reader", name: "Administrator", role: "admin" },
  csrfToken: "unused-synthetic",
};
const state = {
  users: [],
  nodes: [],
  routes: [],
  revisions: [],
  capabilities: [],
  services: [],
  settings: {},
  publishedRoutes: [],
};
const settings = {
  revision: 1,
  inApp: true,
  quotaPercent: [80],
  expiryHours: [24],
  providerRemainingPercent: [10],
  repeatHours: 24,
  email: {
    enabled: false,
    automatic: false,
    host: "",
    port: 587,
    tlsMode: "starttls",
    username: "",
    from: "",
    to: [],
  },
  webhook: { enabled: false, automatic: false, url: "" },
  smtpPasswordSet: false,
  webhookSecretSet: false,
};
const instance = {
  id: "core",
  hostId: "host",
  name: "Core",
  adapterId: "routeweaver/xray",
  version: "26.10.31",
};
const listener = {
  id: "listener",
  name: "Listener",
  instanceId: instance.id,
  connection: { protocol: "socks", host: "127.0.0.1", port: 1080 },
};
const inventory: Infrastructure = {
  hosts: [{ id: "host", name: "Host", address: "host.example.invalid" }],
  instances: [instance],
  endpoints: [listener],
  links: [],
  deployments: [
    {
      id: "draft",
      name: "备用路径",
      status: "draft",
      diagnostics: [],
      ir: {
        schemaVersion: "1.0",
        id: "draft",
        topologyRevision: "1",
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
    },
  ],
};
const cases = [
  {
    kind: "announcements",
    key: "announcements",
    endpoint: "/api/admin/announcements",
    empty: "暂无公告",
    layout: "table",
  },
  {
    kind: "settings",
    key: "notification-settings",
    endpoint: "/api/admin/notification-settings",
    empty: "",
    layout: "form",
  },
  {
    kind: "outbox",
    key: "notification-outbox",
    endpoint: "/api/admin/notifications/outbox",
    empty: "暂无发送记录",
    layout: "table",
  },
  {
    kind: "audit",
    key: "audit",
    endpoint: "/api/audit",
    empty: "暂无管理操作记录",
    layout: "table",
  },
  {
    kind: "accounts",
    key: "security-accounts",
    endpoint: "/api/admin/accounts",
    empty: "没有账号记录。",
    layout: "table",
  },
  {
    kind: "planning",
    key: "fleet-batches",
    endpoint: "/api/admin/fleet-batches",
    empty: "",
    layout: "table",
  },
] as const;
it.each(cases)(
  "keeps $kind offline, pending, error and recovered reads distinct without replacing cached content",
  async ({ kind, key, endpoint, empty, layout }) => {
    const user = userEvent.setup();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    onlineManager.setOnline(false);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    client.setQueryData(["admin-state"], state);
    client.setQueryData(["announcement-users"], state);
    if (key !== "announcements") client.setQueryData(["announcements"], []);
    client.setQueryData(["account-sessions", session.user.id], []);
    client.setQueryData(["infrastructure"], inventory);
    let release!: (response: Response) => void;
    let reads = 0;
    const unexpected: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== endpoint || (init?.method && init.method !== "GET")) {
          unexpected.push(`${init?.method || "GET"} ${url}`);
          throw new Error("Unexpected request");
        }
        reads++;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }),
    );
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          {kind === "audit" ? (
            <AdminPage page="activity" />
          ) : kind === "accounts" ? (
            <AccountSecurityPage
              session={session}
              onSessionChanged={() => {}}
              onSignedOut={() => {}}
            />
          ) : kind === "planning" ? (
            <ServerRoutesPage />
          ) : (
            <NotificationsAdminPage />
          )}
        </UIProviders>
      </QueryClientProvider>,
    );
    if (kind === "settings")
      await user.click(screen.getByRole("tab", { name: "提醒与渠道" }));
    if (kind === "outbox")
      await user.click(screen.getByRole("tab", { name: "发送记录" }));
    if (kind === "planning") {
      expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
      expect(screen.queryByText("等待网络连接")).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "更多转发路径操作 备用路径" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "批量操作" }),
      );
    }
    expect(screen.getByText("等待网络连接")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
    if (empty) expect(screen.queryByText(empty)).toBeNull();
    expect(reads).toBe(0);
    await act(async () => onlineManager.setOnline(true));
    const pending = await screen.findByRole("status", { name: "正在加载" });
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(
      pending.querySelector(
        layout === "form" ? ".sm\\:grid-cols-2" : ".min-h-16",
      ),
    ).toBeTruthy();
    if (empty) expect(screen.queryByText(empty)).toBeNull();
    await act(async () => release(json({ message: "本次读取失败" }, 503)));
    await screen.findByText("本次读取失败");
    expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
    if (empty) expect(screen.queryByText(empty)).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("status", { name: "正在加载" });
    const result = kind === "settings" ? settings : [];
    await act(async () => release(json(result)));
    const loaded = async () =>
      empty
        ? screen.findByText(empty)
        : kind === "settings"
          ? screen.findByRole("button", { name: "保存通知设置" })
          : screen.findByRole("dialog", { name: "备用路径 · 计划变更" });
    await loaded();
    expect(screen.queryByText("本次读取失败")).toBeNull();
    expect(reads).toBe(2);
    let refresh!: Promise<void>;
    act(() => {
      refresh = client.refetchQueries({ queryKey: [key], exact: true });
    });
    await waitFor(() => expect(reads).toBe(3));
    await loaded();
    expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
    await act(async () => {
      release(json(result));
      await refresh;
    });
    expect(unexpected).toEqual([]);
  },
);
const basicProps = {
  onClose() {},
  onPublished() {},
  onAdvanced() {},
  onSources() {},
};
const observedUser = {
  id: "observed-user",
  name: "User",
  enabled: true,
  quotaBytes: 0,
  usedBytes: 0,
};
const activePanels = [
  ["rates", () => <RateSettings routes={[]} />],
  ["user groups", () => <UserGroups users={[]} services={[]} routes={[]} />],
  [
    "node observations",
    () => <NodeObservation host={inventory.hosts[0]} instances={[instance]} />,
  ],
  [
    "instance observations",
    () => <InstanceObservation instanceId={instance.id} />,
  ],
  ["subscription origin", () => <SubscriptionOriginSettings />],
  [
    "diagnostic inventory",
    () => <DiagnosticsPanel host={inventory.hosts[0]} instances={[instance]} />,
  ],
  ["fleet detail", () => <FleetBatchDetail id="batch" onClose={() => {}} />],
  [
    "user entries",
    () => (
      <UserEntries
        user={observedUser}
        services={[]}
        routes={[]}
        onClose={() => {}}
      />
    ),
  ],
  ["basic selection directories", () => <BasicRouting {...basicProps} />],
  [
    "basic profile reveal",
    () => (
      <BasicRouting
        {...basicProps}
        output={{
          id: "client",
          name: "Client",
          profileId: "profile",
          status: "published",
          target: emptyProfile().target,
          mode: "full",
        }}
      />
    ),
  ],
] as const;
it.each(activePanels)(
  "does not render an offline %s read as empty or unknown content",
  async (_name, panel) => {
    onlineManager.setOnline(false);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>{panel()}</UIProviders>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("等待网络连接")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "keeps a disabled basic-profile reveal out of loading (supplied initial=%s)",
  (supplied) => {
    onlineManager.setOnline(false);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    clients.push(client);
    client.setQueryData(["platform-entries"], []);
    client.setQueryData(["sources"], []);
    client.setQueryData(["overview"], { routes: [] });
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <BasicRouting
            {...basicProps}
            initial={supplied ? emptyProfile() : undefined}
          />
        </UIProviders>
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("heading", { name: supplied ? "调整分流" : "设置订阅" }),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
    expect(screen.queryByText("等待网络连接")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("only shows the diagnostic path read when managed-route mode is selected", async () => {
  const user = userEvent.setup();
  onlineManager.setOnline(false);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <DiagnosticStartForm
          targets={[]}
          instances={[instance]}
          onClose={() => {}}
          onCreated={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("combobox", { name: "执行实例" })).toBeTruthy();
  expect(screen.queryByText("等待网络连接")).toBeNull();
  expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "测试路径方式" }));
  await user.click(
    screen.getByRole("option", { name: "已应用线路的中转与出口" }),
  );
  expect(screen.getByText("等待网络连接")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "已应用线路" })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not show a release-catalog loader for a configure plan", () => {
  onlineManager.setOnline(false);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <FleetPlanForm
          inventory={inventory}
          history={[]}
          initialAction="configure"
          initialDeploymentId="draft"
          onClose={() => {}}
          onCreated={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("status", { name: "正在加载" })).toBeNull();
  expect(screen.queryByText("等待网络连接")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

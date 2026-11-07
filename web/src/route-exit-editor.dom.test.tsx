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
import { RouteExitEditor } from "./RouteExitEditor";
import type {
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
} from "./types";
import { PublishedRoutesPage, type PublishedRoute } from "./PublishedRoutes";
import { getNavigationWarning, hasUnsavedChanges } from "./navigation";
import { saveRecord } from "./api";
import { ServerRoutesPage } from "./ServerRoutes";
import { useDiscardConfirmation } from "./useDiscardConfirmation";

const clients: QueryClient[] = [];
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
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function fixture() {
  const hosts = ["fra", "old", "new"].map((id) => ({
    id,
    name: id === "new" ? "英国二号" : id.toUpperCase(),
    address: `${id}.example.invalid`,
  }));
  const instances = hosts.map((host) => ({
    id: `${host.id}-core`,
    hostId: host.id,
    adapterId:
      host.id === "fra" ? "routeweaver/managed-xray" : "routeweaver/xray",
    version: "26.3.27",
  }));
  const endpoints: ManagedEndpoint[] = instances.map((instance, i) => ({
    id: `${hosts[i].id}-endpoint`,
    instanceId: instance.id,
    name: hosts[i].name,
    connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
  }));
  const deployment: ServerDeployment = {
    id: "deployment",
    name: "服务器路径",
    revisionToken: "deployment-before",
    status: "draft",
    diagnostics: [],
    ir: {
      id: "deployment",
      schemaVersion: "1.0",
      topologyRevision: "topology",
      programs: instances.slice(0, 2).map((instance, i) => ({
        instance,
        listener: endpoints[i],
        egress: [],
        rules: [],
        resources: [],
      })),
    },
  };
  const route: PublishedRoute = {
    id: "line",
    name: "英国线路",
    revisionToken: "route-before",
    deploymentId: deployment.id,
    endpointIds: [endpoints[0].id, endpoints[1].id],
    publicHost: "fra.example.invalid",
    publicPort: 443,
    status: "effective",
    diagnostics: [],
  };
  const inventory: Infrastructure = {
    hosts,
    instances,
    endpoints,
    deployments: [deployment],
    links: [],
  };
  return { route, deployment, inventory };
}
const review = {
  routeId: "line",
  routeName: "英国线路",
  reviewToken: "review-bound",
  before: {
    endpointId: "old-endpoint",
    name: "OLD",
    host: "old.example.invalid",
    port: 443,
    protocol: "vless",
    security: "none",
    transport: "tcp",
  },
  after: {
    endpointId: "new-endpoint",
    name: "英国二号",
    host: "new.example.invalid",
    port: 443,
    protocol: "vless",
    security: "none",
    transport: "tcp",
  },
  affectedUsers: 2,
  addedProgram: true,
  isolatedConnector: true,
  legacyNormalized: true,
  nativeChecked: false,
  publicEntryPreserved: true,
  credentialsPreserved: true,
  oldProgramRetained: true,
  applicationReadiness: { state: "requires-apply-check" },
};
function mount(
  options: {
    fetch?: (path: string, init?: RequestInit) => Promise<Response>;
    tls?: boolean;
    additionalTLS?: boolean;
  } = {},
) {
  const data = fixture();
  if (options.tls)
    data.inventory.endpoints[2].connection = {
      ...data.inventory.endpoints[2].connection,
      tls: { enabled: true, serverName: "new.example.invalid" },
    } as (typeof data.inventory.endpoints)[2]["connection"];
  if (options.additionalTLS) {
    data.inventory.hosts.push({
      id: "third",
      name: "英国三号",
      address: "third.example.invalid",
    });
    data.inventory.instances.push({
      id: "third-core",
      hostId: "third",
      adapterId: "routeweaver/xray",
      version: "26.3.27",
    });
    data.inventory.endpoints.push({
      id: "third-endpoint",
      instanceId: "third-core",
      name: "英国三号",
      connection: {
        protocol: "vless",
        host: "0.0.0.0",
        port: 443,
        tls: { enabled: true, serverName: "third.example.invalid" },
      },
    });
  }
  const calls: {
    path: string;
    body: Record<string, unknown>;
    init?: RequestInit;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : {},
        init,
      });
      if (options.fetch) return options.fetch(path, init);
      if (path.endsWith("/preview")) return response(review);
      if (path.endsWith("/retarget"))
        return response({
          operationId: calls.at(-1)?.body.operationId,
          routeId: "line",
          status: "draft-saved",
          routeRevision: "route-after",
          deploymentRevision: "deployment-after",
        });
      throw new Error(`Unexpected ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const onSaved = vi.fn(),
    onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <RouteExitEditor {...data} onSaved={onSaved} onClose={onClose} />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { ...data, calls, onSaved, onClose, user: userEvent.setup() };
}
async function selectVisibleOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  text: string,
) {
  const control = screen.getByRole("combobox", { name: label });
  await user.click(control);
  const list = document.getElementById(
    control.getAttribute("aria-controls") || "",
  );
  const popup = list?.closest<HTMLElement>("[data-slot=popover-content]");
  expect(popup).toBeTruthy();
  await user.click(
    await within(popup!).findByText(text, {
      selector: "[cmdk-item] span",
    }),
  );
}
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await selectVisibleOption(user, "新出口服务器", "英国二号");
  await selectVisibleOption(user, "新出口端点", "英国二号");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "检查变更" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

it("reviews the actual selected endpoint and saves only the exact reviewed draft without reveal or apply", async () => {
  const { user, calls, onSaved } = mount();
  await choose(user);
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText("影响此线路的 2 位关联用户");
  expect(calls[0].body).toEqual({
    replacementEndpointId: "new-endpoint",
    expectedRouteRevision: "route-before",
    expectedDeploymentRevision: "deployment-before",
  });
  await user.click(screen.getByRole("button", { name: "保存出口草稿" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(calls[1].body).toMatchObject({
    ...calls[0].body,
    reviewToken: "review-bound",
  });
  expect(calls[1].body.operationId).toEqual(expect.any(String));
  expect(calls.map((c) => c.path)).toEqual([
    "/api/published-routes/line/retarget/preview",
    "/api/published-routes/line/retarget",
  ]);
});
it("retries an uncertain commit with the identical reviewed request rather than changing operation identity", async () => {
  let attempts = 0;
  const { user, calls, onSaved } = mount({
    fetch: async (path, init) => {
      if (path.endsWith("/preview")) return response(review);
      if (++attempts === 1) throw new Error("lost response");
      return response({
        operationId: JSON.parse(String(init?.body)).operationId,
        routeId: "line",
        status: "draft-saved",
        routeRevision: "route-after",
        deploymentRevision: "deployment-after",
      });
    },
  });
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "保存出口草稿" }));
  const replay = await screen.findByRole("button", { name: "核对保存结果" });
  expect(
    (screen.getByRole("button", { name: "继续选择出口" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("combobox", { name: "新出口端点" })).toBeNull();
  expect(screen.getByRole("button", { name: "返回线路" })).toBeTruthy();
  await user.click(replay);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(calls[2].body).toEqual(calls[1].body);
});
it("keeps a rejected endpoint choice and requires a new check, never offering a stale save", async () => {
  const { user, calls } = mount({
    fetch: async (path, init) =>
      path.endsWith("/preview")
        ? response(review)
        : response({
            operationId: JSON.parse(String(init?.body)).operationId,
            routeId: "line",
            status: "draft-rejected",
            code: "EXIT_DRAFT_REJECTED",
            detail: "路径已变更，请重新检查。",
          }),
  });
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "保存出口草稿" }));
  await screen.findByRole("button", { name: "检查最新变更" });
  expect(screen.queryByRole("button", { name: "保存出口草稿" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "新出口端点" })).toBeTruthy();
  expect(calls).toHaveLength(2);
});
it("offers existing TLS material for a new program without downgrading the selected endpoint", async () => {
  const { user, calls } = mount({ tls: true });
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "证书路径" }),
    "tls/new.crt",
  );
  await user.type(
    screen.getByRole("textbox", { name: "私钥路径" }),
    "tls/new.key",
  );
  await user.type(
    screen.getByRole("textbox", { name: "证书 PEM" }),
    "synthetic-certificate",
  );
  await user.click(screen.getByRole("button", { name: "编辑私钥 PEM" }));
  await user.type(
    screen.getByRole("textbox", { name: "私钥 PEM" }),
    "synthetic-key",
  );
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByRole("button", { name: "保存出口草稿" });
  expect(calls[0].body.tls).toEqual({
    certificatePath: "tls/new.crt",
    keyPath: "tls/new.key",
    certificatePem: "synthetic-certificate",
    privateKeyPem: "synthetic-key",
  });
});
it("sends an existing managed record revision only as If-Match while preserving ordinary record requests", async () => {
  const sent: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path, init: RequestInit) => {
      sent.push(init);
      return response({ id: "deployment" });
    }),
  );
  await saveRecord("server-deployments", {
    id: "deployment",
    name: "Name",
    revisionToken: "opaque-revision",
  });
  expect(new Headers(sent[0].headers).get("If-Match")).toBe("opaque-revision");
  expect(JSON.parse(String(sent[0].body))).toEqual({
    id: "deployment",
    name: "Name",
  });
  await saveRecord("sources", { id: "source", name: "Source" });
  expect(new Headers(sent[1].headers).has("If-Match")).toBe(false);
});
it("cancels a selected but unchecked exit without any write", async () => {
  const { user, calls, onClose } = mount();
  await choose(user);
  const drawer = screen.getByRole("dialog", { name: "更换「英国线路」的出口" });
  await user.click(
    drawer.querySelector<HTMLButtonElement>("[aria-label=关闭]")!,
  );
  await user.click(await screen.findByRole("button", { name: "放弃修改" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(calls).toHaveLength(0);
});
it("withdraws a review when the user returns to choose another endpoint", async () => {
  const { user, calls } = mount();
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "继续选择出口" }));
  expect(screen.queryByRole("button", { name: "保存出口草稿" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "新出口端点" })).toBeTruthy();
  expect(calls).toHaveLength(1);
});

it("opens exit replacement from the existing route and restores that context on cancel without revealing intent", async () => {
  const data = fixture();
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith("/published-routes")) return response([data.route]);
      if (path.endsWith("/resolve")) return response(data.route);
      if (path.endsWith("/hosts")) return response(data.inventory.hosts);
      if (path.endsWith("/core-instances"))
        return response(data.inventory.instances);
      if (path.endsWith("/managed-endpoints"))
        return response(data.inventory.endpoints);
      if (path.endsWith("/server-deployments"))
        return response([data.deployment]);
      if (path.endsWith("/links")) return response([]);
      if (path.endsWith("/state"))
        return response({ users: [], routes: [], services: [] });
      throw new Error(`Unexpected ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishedRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "英国线路" }));
  const trigger = await screen.findByRole("button", { name: "更换出口" });
  await user.click(trigger);
  const editor = await screen.findByRole("dialog", {
    name: "更换「英国线路」的出口",
  });
  await user.click(
    editor.querySelector<HTMLButtonElement>("[aria-label=关闭]")!,
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "更换「英国线路」的出口" }),
    ).toBeNull(),
  );
  expect(screen.getAllByRole("dialog", { name: "英国线路" })).toHaveLength(1);
  expect(trigger.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(
    paths.some(
      (path) => path.endsWith("/reveal") || path.includes("/retarget"),
    ),
  ).toBe(false);
});

it("keeps TLS material scoped to its selected endpoint without copying it when another exit is chosen", async () => {
  const { user, calls } = mount({ tls: true, additionalTLS: true });
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "证书路径" }),
    "tls/second.crt",
  );
  await user.type(
    screen.getByRole("textbox", { name: "私钥路径" }),
    "tls/second.key",
  );
  await selectVisibleOption(user, "新出口服务器", "英国三号");
  await selectVisibleOption(user, "新出口端点", "英国三号");
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: "证书路径" }) as HTMLInputElement)
        .value,
    ).toBe(""),
  );
  expect(
    (screen.getByRole("textbox", { name: "私钥路径" }) as HTMLInputElement)
      .value,
  ).toBe("");
  await choose(user);
  expect(
    (screen.getByRole("textbox", { name: "证书路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/second.crt");
  expect(
    (screen.getByRole("textbox", { name: "私钥路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/second.key");
  expect(calls).toHaveLength(0);
});

it("keeps a path-only TLS draft explicit and returns to that endpoint's material fields", async () => {
  const { user, calls } = mount({
    tls: true,
    fetch: async () =>
      response({
        ...review,
        after: { ...review.after, security: "tls", tlsMaterial: "paths-only" },
        applicationReadiness: {
          state: "blocked",
          code: "tls-material-required",
          endpointIds: ["new-endpoint"],
        },
      }),
  });
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "证书路径" }),
    "tls/new.crt",
  );
  await user.type(
    screen.getByRole("textbox", { name: "私钥路径" }),
    "tls/new.key",
  );
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByText("仅保存证书路径，尚不能应用。请补充证书和私钥 PEM。");
  expect(
    (screen.getByRole("button", { name: "保存出口草稿" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "补充 TLS 材料" }));
  expect(
    (screen.getByRole("textbox", { name: "证书路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/new.crt");
  expect(
    (screen.getByRole("textbox", { name: "私钥路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/new.key");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "证书 PEM" }),
  );
  expect(calls).toHaveLength(1);
});
it("dismisses an unresolved save and reopens the same page-owned operation after authoritative reads", async () => {
  const data = fixture();
  const commits: Record<string, unknown>[] = [];
  let previews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/retarget/preview")) {
        previews++;
        return response(review);
      }
      if (path.endsWith("/retarget")) {
        const body = JSON.parse(String(init?.body));
        commits.push(body);
        if (commits.length === 1) {
          data.route.revisionToken = "route-already-committed";
          data.deployment.revisionToken = "deployment-already-committed";
          throw new Error("response lost after commit");
        }
        return response({
          operationId: body.operationId,
          routeId: "line",
          status: "draft-saved",
          routeRevision: "route-already-committed",
          deploymentRevision: "deployment-already-committed",
        });
      }
      if (path.endsWith("/published-routes")) return response([data.route]);
      if (path.endsWith("/resolve")) return response(data.route);
      if (path.endsWith("/hosts")) return response(data.inventory.hosts);
      if (path.endsWith("/core-instances"))
        return response(data.inventory.instances);
      if (path.endsWith("/managed-endpoints"))
        return response(data.inventory.endpoints);
      if (path.endsWith("/server-deployments"))
        return response([data.deployment]);
      if (path.endsWith("/links")) return response([]);
      if (path.endsWith("/state"))
        return response({ users: [], routes: [], services: [] });
      throw new Error(`Unexpected ${path}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishedRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "英国线路" }));
  await user.click(await screen.findByRole("button", { name: "更换出口" }));
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "保存出口草稿" }));
  await screen.findByRole("button", { name: "核对保存结果" });
  await user.click(screen.getByRole("button", { name: "返回线路" }));
  await screen.findByText("「英国线路」的出口变更保存结果尚未确认");
  // The sheet is closed, but the page still owns the unresolved operation.
  expect(hasUnsavedChanges()).toBe(true);
  expect(getNavigationWarning()).toContain("出口变更可能已保存");
  expect(getNavigationWarning()).toContain("离开不会取消保存");
  expect(getNavigationWarning()).toContain("核对信息");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "继续「英国线路」出口变更" }),
  );
  await user.click(await screen.findByRole("button", { name: "核对保存结果" }));
  await waitFor(() =>
    expect(
      screen.queryByText("「英国线路」的出口变更保存结果尚未确认"),
    ).toBeNull(),
  );
  expect(commits).toHaveLength(2);
  expect(commits[1]).toEqual(commits[0]);
  expect(commits[1].expectedRouteRevision).toBe("route-before");
  expect(previews).toBe(1);
  await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
});

it("shows TLS removal explicitly and does not display raw security values", async () => {
  const { user } = mount({
    fetch: async () =>
      response({
        ...review,
        securityChanges: ["tls-disabled", "server-name-changed"],
      }),
  });
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  expect(
    await screen.findByText("新出口将停用 TLS；TLS 服务端名称将变更"),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "保存出口草稿" })).toBeTruthy();
});

for (const kind of ["route", "deployment"] as const) {
  it(`${kind} full editor preserves the stale draft without a second PUT or token upgrade`, async () => {
    const data = fixture();
    const writes: { body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === "PUT") {
          writes.push({
            body: JSON.parse(String(init.body)),
            headers: new Headers(init.headers),
          });
          return response({ message: "changed elsewhere" }, 409);
        }
        if (path.endsWith("/published-routes/preview"))
          return response(data.route);
        if (path.endsWith("/published-routes")) return response([data.route]);
        if (path.endsWith("/resolve")) return response(data.route);
        if (path.endsWith("/hosts")) return response(data.inventory.hosts);
        if (path.endsWith("/core-instances"))
          return response(data.inventory.instances);
        if (path.endsWith("/managed-endpoints"))
          return response(data.inventory.endpoints);
        if (path.endsWith("/server-deployments"))
          return response([data.deployment]);
        if (path.endsWith("/reveal")) return response(data.deployment);
        if (path.endsWith("/links")) return response([]);
        if (path.endsWith("/state"))
          return response({ users: [], routes: [], services: [] });
        throw new Error(`Unexpected ${path}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          {kind === "route" ? <PublishedRoutesPage /> : <ServerRoutesPage />}
        </UIProviders>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: kind === "route" ? "编辑" : "编辑转发路径 服务器路径",
      }),
    );
    const field = await screen.findByRole("textbox", {
      name: kind === "route" ? "线路名称" : "转发路径名称",
    });
    await user.clear(field);
    await user.type(field, "我的未保存修改");
    if (kind === "route")
      await user.click(screen.getByRole("button", { name: "检查公开线路" }));
    const saveName = kind === "route" ? "保存公开线路" : "保存草稿";
    await user.click(await screen.findByRole("button", { name: saveName }));
    const discard = await screen.findByRole("button", {
      name: "放弃修改并返回",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].headers.get("If-Match")).toBe(
      kind === "route" ? "route-before" : "deployment-before",
    );
    expect(writes[0].body).not.toHaveProperty("revisionToken");
    expect((field as HTMLInputElement).value).toBe("我的未保存修改");
    expect(
      (screen.getByRole("button", { name: saveName }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(discard);
    const confirm = await screen.findByRole("alertdialog", {
      name: "放弃当前修改并返回？",
    });
    const keep = within(confirm).getByRole("button", { name: "保留当前输入" });
    expect(document.activeElement).toBe(keep);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "放弃当前修改并返回？" }),
      ).toBeNull(),
    );
    expect((field as HTMLInputElement).value).toBe("我的未保存修改");
    expect(document.activeElement).toBe(discard);
    await user.click(discard);
    const confirmed = await screen.findByRole("alertdialog", {
      name: "放弃当前修改并返回？",
    });
    const accept = within(confirmed).getByRole("button", {
      name: "放弃修改并返回",
    });
    accept.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", {
          name: kind === "route" ? "线路名称" : "转发路径名称",
        }),
      ).toBeNull(),
    );
    expect(writes).toHaveLength(1);
  });
}
it("disposes a discard confirmation when its owner is replaced or unmounted", async () => {
  const discarded = vi.fn();
  function Owner({ id }: { id: string }) {
    const { confirm } = useDiscardConfirmation(id);
    return (
      <button
        onClick={() =>
          confirm(
            {
              title: `放弃 ${id}？`,
              description: "尚未保存",
              confirmLabel: "放弃",
              cancelLabel: "保留",
            },
            () => discarded(id),
          )
        }
      >
        关闭 {id}
      </button>
    );
  }
  const wrap = (id: string) => (
    <UIProviders>
      <Owner id={id} />
    </UIProviders>
  );
  const mounted = render(wrap("A"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "关闭 A" }));
  await screen.findByRole("alertdialog", { name: "放弃 A？" });
  mounted.rerender(wrap("B"));
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog", { name: "放弃 A？" })).toBeNull(),
  );
  expect(discarded).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "关闭 B" }));
  await screen.findByRole("alertdialog", { name: "放弃 B？" });
  mounted.unmount();
  expect(discarded).not.toHaveBeenCalled();
});

it("does not let a late TLS file read replace an unresolved reviewed operation", async () => {
  let finishRead!: (text: string) => void;
  const pendingRead = new Promise<string>((resolve) => {
    finishRead = resolve;
  });
  let attempts = 0;
  const { user, calls, onSaved } = mount({
    tls: true,
    fetch: async (path, init) => {
      if (path.endsWith("/preview"))
        return response({
          ...review,
          after: {
            ...review.after,
            security: "tls",
            tlsMaterial: "paths-only",
          },
          applicationReadiness: {
            state: "blocked",
            code: "tls-material-required",
            endpointIds: ["new-endpoint"],
          },
        });
      if (++attempts === 1) throw new Error("lost response");
      return response({
        operationId: JSON.parse(String(init?.body)).operationId,
        routeId: "line",
        status: "draft-saved",
        routeRevision: "route-after",
        deploymentRevision: "deployment-after",
      });
    },
  });
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "证书路径" }),
    "tls/alternate.crt",
  );
  await user.type(
    screen.getByRole("textbox", { name: "私钥路径" }),
    "tls/alternate.key",
  );
  const file = new File(["synthetic"], "certificate.pem", {
    type: "application/x-pem-file",
  });
  Object.defineProperty(file, "text", { value: () => pendingRead });
  await user.upload(screen.getByLabelText("读取 TLS 证书"), file);
  expect(screen.getByRole("button", { name: "检查变更" }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  expect(calls).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "取消读取" }));
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "保存出口草稿" }));
  await screen.findByRole("button", { name: "核对保存结果" });
  await act(async () => finishRead("late synthetic PEM"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "核对保存结果" })).toBeTruthy(),
  );
  await user.click(screen.getByRole("button", { name: "核对保存结果" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(calls[2].body).toEqual(calls[1].body);
  expect(calls[1].body.tls).not.toHaveProperty("certificatePem");
});

it("resolves only a matching durable rejection and preserves the target TLS draft without success", async () => {
  let commits = 0;
  const { user, onSaved, calls } = mount({
    tls: true,
    fetch: async (path, init) => {
      if (path.endsWith("/preview")) return response(review);
      if (++commits === 1) throw new Error("lost rejection response");
      return response({
        operationId: JSON.parse(String(init?.body)).operationId,
        routeId: "line",
        status: "draft-rejected",
        code: "EXIT_DRAFT_REJECTED",
        detail: "端点已变更，请重新检查。",
      });
    },
  });
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "证书路径" }),
    "tls/keep.crt",
  );
  await user.type(
    screen.getByRole("textbox", { name: "私钥路径" }),
    "tls/keep.key",
  );
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await user.click(await screen.findByRole("button", { name: "保存出口草稿" }));
  await user.click(await screen.findByRole("button", { name: "核对保存结果" }));
  await screen.findByText("本次修改未保存：端点已变更，请重新检查。");
  expect(onSaved).not.toHaveBeenCalled();
  expect(calls[2].body).toEqual(calls[1].body);
  expect(
    (screen.getByRole("textbox", { name: "证书路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/keep.crt");
  expect(
    (screen.getByRole("textbox", { name: "私钥路径" }) as HTMLInputElement)
      .value,
  ).toBe("tls/keep.key");
  expect(screen.getByRole("button", { name: "检查最新变更" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保存出口草稿" })).toBeNull();
});
for (const malformed of [
  "operation",
  "route",
  "status",
  "code",
  "detail",
  "http409",
]) {
  it(`keeps malformed or generic ${malformed} outcome unresolved`, async () => {
    const { user, onSaved } = mount({
      fetch: async (path, init) => {
        if (path.endsWith("/preview")) return response(review);
        if (malformed === "http409")
          return response({ message: "changed" }, 409);
        return response({
          operationId:
            malformed === "operation"
              ? "other-operation"
              : JSON.parse(String(init?.body)).operationId,
          routeId: malformed === "route" ? "other-route" : "line",
          status: malformed === "status" ? "rejected" : "draft-rejected",
          code: malformed === "code" ? "UNKNOWN" : "EXIT_DRAFT_REJECTED",
          detail: malformed === "detail" ? "" : "已拒绝",
        });
      },
    });
    await choose(user);
    await user.click(screen.getByRole("button", { name: "检查变更" }));
    await user.click(
      await screen.findByRole("button", { name: "保存出口草稿" }),
    );
    await screen.findByRole("button", { name: "核对保存结果" });
    expect(screen.queryByRole("combobox", { name: "新出口服务器" })).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });
}
it("same-turn repeated save activation sends one owned operation", async () => {
  let finish!: (result: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { user, calls, onSaved } = mount({
    fetch: async (path) =>
      path.endsWith("/preview") ? response(review) : pending,
  });
  await choose(user);
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  const save = await screen.findByRole("button", { name: "保存出口草稿" });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(calls).toHaveLength(2));
  finish(
    response({
      operationId: calls[1].body.operationId,
      routeId: "line",
      status: "draft-saved",
      routeRevision: "route-after",
      deploymentRevision: "deployment-after",
    }),
  );
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(calls.filter((call) => call.path.endsWith("/retarget"))).toHaveLength(
    1,
  );
});


it("includes both completed PEM reads and newer paths in the exit preview", async () => {
  const { user, calls } = mount({ tls: true });
  await choose(user);
  let certificateDone!: (text: string) => void;
  let keyDone!: (text: string) => void;
  const certificate = new File(["fixture"], "cert.pem");
  const key = new File(["fixture"], "key.pem");
  const certificateRead = new Promise<string>((done) => { certificateDone = done; });
  const keyRead = new Promise<string>((done) => { keyDone = done; });
  Object.defineProperty(certificate, "text", { value: () => certificateRead });
  Object.defineProperty(key, "text", { value: () => keyRead });
  await user.upload(screen.getByLabelText("读取 TLS 证书"), certificate);
  await user.upload(screen.getByLabelText("读取 TLS 私钥"), key);
  await user.type(screen.getByRole("textbox", { name: "证书路径" }), "custom/cert.pem");
  await user.type(screen.getByRole("textbox", { name: "私钥路径" }), "custom/key.pem");
  await act(async () => certificateDone("synthetic certificate"));
  expect(screen.getByRole("button", { name: "检查变更" }).hasAttribute("disabled")).toBe(true);
  await act(async () => keyDone("synthetic private key"));
  await user.click(screen.getByRole("button", { name: "检查变更" }));
  await screen.findByRole("button", { name: "保存出口草稿" });
  expect(calls[0].body.tls).toEqual({
    certificatePath: "custom/cert.pem", keyPath: "custom/key.pem",
    certificatePem: "synthetic certificate", privateKeyPem: "synthetic private key",
  });
});

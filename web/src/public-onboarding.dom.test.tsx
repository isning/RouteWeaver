// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import {
  createWorkspaceHistory,
  type WorkspaceHistory,
} from "./workspace-history";
import { hasUnsavedChanges } from "./navigation";
import { ServerRoutesPage } from "./ServerRoutes";
import { PublishedRoutesPage } from "./PublishedRoutes";
import type { ReactNode } from "react";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
const historyControllers: WorkspaceHistory[] = [];
const clients: QueryClient[] = [];
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 15000 },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
beforeEach(() => {
  // Use unique production-style IDs for nested Ant drawers and modals.
  vi.stubEnv("NODE_ENV", "development");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
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
  clients.splice(0).forEach((client) => client.clear());
  historyControllers.splice(0).forEach((controller) => controller.dispose());
  location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const route = {
  id: "public",
  name: "Office",
  deploymentId: "deploy-office",
  endpointIds: ["entry"],
  publicHost: "public.example",
  publicPort: 443,
  status: "draft",
  diagnostics: [],
};
function setup(
  adapterId = "routeweaver/sing-box",
  version = "1.14.3",
  renderPage = true,
) {
  const instance = { id: "core", hostId: "host", adapterId, version };
  const listener = {
    id: "entry",
    name: "Office entry",
    instanceId: "core",
    connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
  };
  const deployment = {
    revisionToken: "opened-onboarding-revision",
    id: "deploy-office",
    name: "Office transfer",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deploy-office",
      topologyRevision: "v1",
      programs: [{ instance, listener, egress: [], rules: [], resources: [] }],
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/principals"))
        return json({ entryId: "grant", status: "pending-deployment" });
      if (path.endsWith("/state"))
        return json({ users: [{ id: "user", name: "Alice" }] });
      if (path.endsWith("/hosts"))
        return json([
          { id: "host", name: "Office server", address: "public.example" },
        ]);
      if (path.endsWith("/core-instances")) return json([instance]);
      if (path.endsWith("/managed-endpoints")) return json([listener]);
      if (path.endsWith("/server-deployments")) return json([deployment]);
      if (path.endsWith("/published-routes")) return json([route]);
      if (path.endsWith("/preview") || path.endsWith("/resolve"))
        return json(route);
      if (path.endsWith("/effective-policy"))
        return json({
          userId: "user",
          routeIds: ["public"],
          status: "active",
          provenance: { routes: "service:office" },
          entitlement: { cycle: { mode: "none" } },
        });
      return json([]);
    }),
  );
  if (renderPage) mount(<PublishedRoutesPage />);
}
it("explains unsupported public entry before assignment while preserving legacy route editing", async () => {
  setup();
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const drawer = await screen.findByRole("dialog", { name: "编辑 Office" });
  expect(
    within(drawer).getByLabelText("公开线路转发路径").textContent,
  ).toContain("Office entry");
  expect(
    within(drawer).queryByRole("button", { name: "上移公开路径第 1 跳" }),
  ).toBeNull();
  await userEvent.click(
    within(drawer).getByText("调整公开范围（仅当需要使用路径的一部分）"),
  );
  expect(
    await within(drawer).findByRole("button", { name: "恢复完整路径" }),
  ).toBeTruthy();
  expect(
    await within(drawer).findByText("此入口暂不能分配独立用户"),
  ).toBeTruthy();
  expect(
    within(drawer)
      .getByRole("link", { name: "配置服务器入口" })
      .getAttribute("href"),
  ).toBe("#servers");
  expect(
    within(drawer).getByRole("textbox", { name: "线路名称" }),
  ).toBeTruthy();
  await userEvent.click(
    within(drawer).getByRole("button", { name: "检查公开线路" }),
  );
  expect(await within(drawer).findByText("路径检查完成")).toBeTruthy();
  await userEvent.click(
    within(drawer).getByRole("button", { name: /取\s*消/ }),
  );
  await userEvent.click(screen.getByRole("button", { name: "配置用户入口" }));
  const modal = await screen.findByRole("dialog", {
    name: "配置「Office」的用户入口",
  });
  expect(
    await within(modal).findByText("此入口暂不能分配独立用户"),
  ).toBeTruthy();
  expect(
    (
      within(modal).getByRole("button", {
        name: "创建用户入口",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it.each(["later", "continue", "close", "mask"])(
  "offers exact deployment continuation and safely dismisses success via %s",
  async (dismiss) => {
    setup("routeweaver/managed-xray", "26.3.27-rw1");
    await userEvent.click(
      await screen.findByRole("button", { name: "配置用户入口" }),
    );
    const modal = await screen.findByRole("dialog", {
      name: "配置「Office」的用户入口",
    });
    await userEvent.click(within(modal).getByText("凭据与版本设置"));
    await waitFor(() =>
      expect(
        (
          within(modal).getByRole("textbox", {
            name: "凭据版本",
          }) as HTMLInputElement
        ).value,
      ).not.toBe(""),
    );
    await userEvent.click(within(modal).getByRole("combobox", { name: "用户" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Alice" }),
    );
    await userEvent.click(
      within(modal).getByRole("button", { name: "创建用户入口" }),
    );
    const action = await within(modal).findByRole("link", {
      name: "检查并应用「Office transfer」",
    });
    expect(action.getAttribute("href")).toBe(
      "#routes?deployment=deploy-office&line=public&user=user",
    );
    expect(within(modal).getByText(/尚未提交部署/)).toBeTruthy();
    expect(within(modal).queryByText("已确认生效")).toBeNull();
    if (dismiss === "continue") await userEvent.click(action);
    else if (dismiss === "later")
      await userEvent.click(
        within(modal).getByRole("button", { name: "稍后处理" }),
      );
    else if (dismiss === "close")
      await userEvent.click(
        within(modal).getByRole("button", { name: "关闭" }),
      );
    else {
      const mask = document.querySelector('[data-slot="dialog-overlay"]')!;
      await userEvent.click(mask);
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "配置「Office」的用户入口" }),
      ).toBeNull(),
    );
    const retainedDetail = screen.queryByRole("dialog", { name: "Office" });
    if (retainedDetail) await userEvent.click(within(retainedDetail).getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "配置用户入口" })).toBeTruthy();
    if (dismiss === "continue")
      await waitFor(() =>
        expect(location.hash).toBe(
          "#routes?deployment=deploy-office&line=public&user=user",
        ),
      );
  },
);

it("opens the exact deployment detail from the public-route continuation link", async () => {
  const { default: Workspace } = await import("./App");
  location.hash = "routes?deployment=deploy-office";
  setup("routeweaver/managed-xray", "26.3.27-rw1", false);
  const fetchInventory = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/auth/me"))
        return json({
          user: { id: "admin", name: "Admin", role: "admin" },
          csrfToken: "test",
        });
      return fetchInventory(url, init);
    }),
  );
  mount(<Workspace />);
  const drawer = await screen.findByRole("dialog", { name: "Office transfer" });
  expect(
    within(drawer).getByRole("button", { name: "查看修改并应用" }),
  ).toBeTruthy();
  await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog", { name: "Office transfer" })).toBeNull();
  expect(location.hash).toBe("#routes");
  location.hash = "routes?deployment=deploy-office";
  expect(
    await screen.findByRole("dialog", { name: "Office transfer" }),
  ).toBeTruthy();
  location.hash = "";
});

it("refreshes available users when assignment is reopened without waiting for the shared cache window", async () => {
  setup("routeweaver/managed-xray", "26.3.27-rw1");
  let name = "Alice";
  const inventoryFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).endsWith("/state")
        ? json({ users: [{ id: "user", name }] })
        : inventoryFetch(url, init),
    ),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "配置用户入口" }),
  );
  let modal = await screen.findByRole("dialog", {
    name: "配置「Office」的用户入口",
  });
  await userEvent.click(within(modal).getByRole("combobox", { name: "用户" }));
  expect(
    await screen.findByRole("option", { name: "Alice" }),
  ).toBeTruthy();
  await userEvent.click(within(modal).getByRole("button", { name: /取\s*消/ }));
  name = "Alice updated";
  const retainedDetail = screen.queryByRole("dialog", { name: "Office" });
  if (retainedDetail) await userEvent.click(within(retainedDetail).getByRole("button", { name: "关闭" }));
  await userEvent.click(screen.getByRole("button", { name: "配置用户入口" }));
  modal = await screen.findByRole("dialog", {
    name: "配置「Office」的用户入口",
  });
  await userEvent.click(within(modal).getByRole("combobox", { name: "用户" }));
  expect(
    await screen.findByRole("option", { name: "Alice updated" }),
  ).toBeTruthy();
});

it.each(["direct", "back", "forward"])(
  "preserves the route draft when true-unknown same-page %s navigation is declined",
  async (navigation) => {
    const { default: Workspace } = await import("./App");
    const original = "#routes?line=public&user=user";
    const destination =
      "#routes?deployment=deploy-office&line=public&user=user";
    // Deliberately foreign same-document entries: no app lineage/position proof.
    // Cancellation must disclose its new-entry/Forward cost, not rewrite these targets.
    if (navigation === "back") {
      history.replaceState(null, "", destination);
      history.pushState(null, "", original);
    } else if (navigation === "forward") {
      history.replaceState(null, "", original);
      history.pushState(null, "", destination);
      history.back();
      await waitFor(() => expect(location.hash).toBe(original));
    } else {
      history.replaceState(null, "", original);
    }
    setup("routeweaver/managed-xray", "26.3.27-rw1", false);
    const fetchInventory = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/auth/me"))
          return json({
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "test",
          });
        return fetchInventory(url, init);
      }),
    );
    mount(<Workspace />);
    await userEvent.click(
      await screen.findByRole("button", { name: "新建转发路径" }),
    );
    const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
    const name = within(editor).getByRole("textbox", { name: "转发路径名称" });
    await userEvent.type(name, "Unsaved route");
    const acceptedProof = history.state.routeweaverEntry;
    let destinationState: unknown = null;
    if (navigation === "back") history.back();
    else if (navigation === "forward") history.forward();
    else {
      location.hash = destination;
      destinationState = history.state;
    }
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？",
    });
    expect(location.hash).toBe(destination);
    expect(history.state).toBe(destinationState);
    expect(
      within(confirmation).getByText(
        "继续编辑会建立新的历史记录，并清除浏览器的前进记录。",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Office transfer" }),
    ).toBeNull();
    expect((name as HTMLInputElement).value).toBe("Unsaved route");
    const continueNavigation = within(confirmation).getByRole("button", {
      name: "继续编辑",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(continueNavigation),
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
      ).toBeNull(),
    );
    expect(location.hash).toBe(original);
    expect(screen.getByRole("dialog", { name: "新建转发路径" })).toBe(editor);
    expect((name as HTMLInputElement).value).toBe("Unsaved route");
    expect(history.state.routeweaverEntry).toBeTruthy();
    expect(history.state.routeweaverEntry).not.toBe(acceptedProof);

    // Closing the editor has its own discard decision. Rejecting the earlier
    // navigation must not queue that destination behind this later close.
    await userEvent.click(
      within(editor).getByRole("button", { name: "关闭" }),
    );
    const continueEditing = await screen.findByRole("button", {
      name: "继续编辑",
    });
    await waitFor(() => expect(document.activeElement).toBe(continueEditing));
    await userEvent.keyboard("{Enter}");
    expect((name as HTMLInputElement).value).toBe("Unsaved route");
    await userEvent.click(
      within(editor).getByRole("button", { name: "关闭" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃修改" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull(),
    );
    expect(
      screen.queryByRole("dialog", { name: "Office transfer" }),
    ).toBeNull();
    expect(location.hash).toBe(original);

    if (navigation === "direct") {
      // Cancel kept the destination intact behind the explicitly new return entry.
      // Once the editor is deliberately closed, Back/Forward can visit both exactly.
      history.back();
      expect(
        await screen.findByRole("dialog", { name: "Office transfer" }),
      ).toBeTruthy();
      expect(location.hash).toBe(destination);
      expect(
        screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
      ).toBeNull();
      history.forward();
      await waitFor(() => expect(location.hash).toBe(original));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Office transfer" }),
        ).toBeNull(),
      );
      expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
      expect(
        screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
      ).toBeNull();
    }

    // A fresh, now-authorized same-page request opens exactly the selected path.
    location.hash = destination;
    expect(
      await screen.findByRole("dialog", { name: "Office transfer" }),
    ).toBeTruthy();
    expect(location.hash).toBe(destination);
  },
);

it("honors one global discard for a true-unknown same-page deployment", async () => {
  const { default: Workspace } = await import("./App");
  const original = "#routes?line=public&user=user";
  const destination = "#routes?deployment=deploy-office&line=public&user=user";
  history.replaceState(null, "", original);
  setup("routeweaver/managed-xray", "26.3.27-rw1", false);
  const fetchInventory = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).endsWith("/auth/me")
        ? json({
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "test",
          })
        : fetchInventory(url, init),
    ),
  );
  mount(<Workspace />);
  await userEvent.click(
    await screen.findByRole("button", { name: "新建转发路径" }),
  );
  const editor = await screen.findByRole("dialog", { name: "新建转发路径" });
  await userEvent.type(
    within(editor).getByRole("textbox", { name: "转发路径名称" }),
    "Discard only after confirmation",
  );
  location.hash = destination;
  const destinationState = history.state;
  const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？",
  });
  expect(location.hash).toBe(destination);
  expect(history.state).toBe(destinationState);
  expect(
    within(confirmation).getByText(
      "继续编辑会建立新的历史记录，并清除浏览器的前进记录。",
    ),
  ).toBeTruthy();
  expect(
    (
      within(editor).getByLabelText("转发路径名称") as HTMLInputElement
    ).value,
  ).toBe("Discard only after confirmation");
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "放弃修改并离开" }),
  );
  expect(location.hash).toBe(destination);
  expect(
    await screen.findByRole("dialog", { name: "Office transfer" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "新建转发路径" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
  expect(location.hash).toBe(destination);
  expect(
    screen.getByRole("link", { name: "返回线路" }).getAttribute("href"),
  ).toBe("#published-routes?line=public&user=user");
});

it.each(["completed", "pending"])(
  "keeps %s deployment checks scoped to their original route",
  async (stage) => {
    const { ServerRoutesPage } = await import("./ServerRoutes");
    location.hash = "routes?deployment=deploy-office";
    setup("routeweaver/managed-xray", "26.3.27-rw1", false);
    const fetchInventory = globalThis.fetch;
    let completeFirst!: (value: Response) => void;
    const firstCheck = new Promise<Response>((resolve) => {
      completeFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (path.endsWith("/server-deployments")) {
          const records = await (await fetchInventory(url, init)).json();
          return json([
            ...records,
            { ...records[0], id: "deploy-second", name: "Second transfer" },
          ]);
        }
        if (path.endsWith("/deploy-office/validate")) return firstCheck;
        if (path.endsWith("/deploy-second/validate"))
          return json({
            valid: true,
            diagnostics: [],
            artifacts: [
              { path: "second-config", content: "second configuration" },
            ],
          });
        return fetchInventory(url, init);
      }),
    );
    mount(<ServerRoutesPage />);
    const first = await screen.findByRole("dialog", {
      name: "Office transfer",
    });
    await userEvent.click(
      within(first).getByRole("button", { name: "查看修改并应用" }),
    );
    if (stage === "completed") {
      completeFirst(
        json({
          valid: true,
          diagnostics: [],
          artifacts: [{ path: "first-config", content: "first configuration" }],
        }),
      );
      await screen.findByRole("dialog", { name: "应用转发路径修改" });
      await userEvent.click(
        screen.getByRole("checkbox", { name: "确认允许此转发路径提供访问" }),
      );
    }
    location.hash = "routes?deployment=deploy-second";
    await screen.findByRole("heading", { name: "Second transfer" });
    if (stage === "pending")
      completeFirst(
        json({
          valid: true,
          diagnostics: [],
          artifacts: [{ path: "first-config", content: "first configuration" }],
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByRole("heading", { name: "应用转发路径修改" }),
    ).toBeNull();
    const second = screen.getByRole("dialog", { name: "Second transfer" });
    await userEvent.click(
      within(second).getByRole("button", { name: "查看修改并应用" }),
    );
    const review = await screen.findByRole("dialog", {
      name: "应用转发路径修改",
    });
    expect(
      (
        within(review).getByRole("checkbox", {
          name: "确认允许此转发路径提供访问",
        }) as HTMLInputElement
      ).getAttribute("aria-checked"),
  ).toBe("false");
    await userEvent.click(within(review).getByText("断联时的有效期与生成文件"));
    expect(await within(review).findByText("second-config")).toBeTruthy();
    expect(within(review).queryByText("first-config")).toBeNull();
  },
);
it.each([false, true])(
  "offers a usable public-route next step when a transfer path exists: %s",
  async (hasPath) => {
    const { default: Workspace } = await import("./App");
    location.hash = "published-routes";
    setup("routeweaver/managed-xray", "26.3.27-rw1", false);
    const inventoryFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (path.endsWith("/auth/me"))
          return json({
            user: { id: "admin", name: "Admin", role: "admin" },
            csrfToken: "test",
          });
        if (path.endsWith("/published-routes")) return json([]);
        if (!hasPath && path.endsWith("/server-deployments")) return json([]);
        return inventoryFetch(url, init);
      }),
    );
    mount(<Workspace />);
    if (hasPath) {
      await userEvent.click(
        (await screen.findAllByRole("button", { name: "配置公开线路" }))[0],
      );
      expect(
        await screen.findByRole("dialog", { name: "配置公开线路" }),
      ).toBeTruthy();
    } else {
      const actions = await screen.findAllByRole("link", {
        name: "创建转发路径",
      });
      expect(actions).toHaveLength(2);
      expect(
        actions.every((action) => action.getAttribute("href") === "#routes"),
      ).toBe(true);
      expect(screen.queryByRole("button", { name: "配置公开线路" })).toBeNull();
      await userEvent.click(actions[0]);
      await userEvent.click(
        (await screen.findAllByRole("button", { name: "新建转发路径" }))[0],
      );
      expect(
        await screen.findByRole("dialog", { name: "新建转发路径" }),
      ).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: "配置公开线路" })).toBeNull();
    }
  },
);

it.each([
  [
    "published route is not assigned to this account",
    "Alice 尚未获准使用「Office」",
  ],
  ["account service is not active", "Alice 的服务当前不可用"],
])(
  "offers authorization recovery for %s without granting access",
  async (error, explanation) => {
    setup("routeweaver/managed-xray", "26.3.27-rw1");
    const fetchInventory = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) =>
        String(url).endsWith("/principals")
          ? new Response(JSON.stringify({ error }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            })
          : fetchInventory(url, init),
      ),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "配置用户入口" }),
    );
    const modal = await screen.findByRole("dialog", {
      name: "配置「Office」的用户入口",
    });
    await userEvent.click(within(modal).getByText("凭据与版本设置"));
    await waitFor(() =>
      expect(
        (
          within(modal).getByRole("textbox", {
            name: "凭据版本",
          }) as HTMLInputElement
        ).value,
      ).not.toBe(""),
    );
    await userEvent.click(within(modal).getByRole("combobox", { name: "用户" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Alice" }),
    );
    await userEvent.click(
      within(modal).getByRole("button", { name: "创建用户入口" }),
    );
    expect(await within(modal).findByText(explanation)).toBeTruthy();
    expect(
      within(modal).getByRole("button", { name: "检查此用户授权" }),
    ).toBeTruthy();
    expect(
      within(modal).queryByRole("link", { name: "管理用户授权" }),
    ).toBeNull();
    expect(within(modal).queryByText(error)).toBeNull();
    expect(within(modal).getByText("Alice")).toBeTruthy();
  },
);

it("keeps a user-entry request open until its outcome is known", async () => {
  setup("routeweaver/managed-xray", "26.3.27-rw1");
  const inventoryFetch = globalThis.fetch;
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).endsWith("/principals") ? pending : inventoryFetch(url, init),
    ),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "配置用户入口" }),
  );
  const modal = await screen.findByRole("dialog", {
    name: "配置「Office」的用户入口",
  });
  await userEvent.click(within(modal).getByText("凭据与版本设置"));
  await waitFor(() =>
    expect(
      (
        within(modal).getByRole("textbox", {
          name: "凭据版本",
        }) as HTMLInputElement
      ).value,
    ).not.toBe(""),
  );
  await userEvent.click(within(modal).getByRole("combobox", { name: "用户" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Alice" }),
  );
  await userEvent.click(
    within(modal).getByRole("button", { name: "创建用户入口" }),
  );
  await waitFor(() =>
    expect(
      (
        within(modal).getByRole("button", {
          name: /取\s*消/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
  expect(within(modal).queryByRole("button", { name: "关闭" })).toBeNull();
  expect(
    within(modal).queryByRole("link", { name: "管理用户授权" }),
  ).toBeNull();
  await userEvent.keyboard("{Escape}");
  const mask = document.querySelector('[data-slot="dialog-overlay"]')!;
      await userEvent.click(mask);
  expect(
    screen.getByRole("dialog", { name: "配置「Office」的用户入口" }),
  ).toBeTruthy();
  finish(json({ entryId: "grant", status: "pending-deployment" }));
  expect(await within(modal).findByText("用户入口已准备")).toBeTruthy();
  await userEvent.click(
    within(modal).getByRole("button", { name: "稍后处理" }),
  );
  expect(
    screen.queryByRole("dialog", { name: "配置「Office」的用户入口" }),
  ).toBeNull();
});

it("offers user setup instead of an empty assignable-user picker", async () => {
  setup("routeweaver/managed-xray", "26.3.27-rw1");
  const inventoryFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) =>
      String(url).endsWith("/state")
        ? json({ users: [] })
        : inventoryFetch(url, init),
    ),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "配置用户入口" }),
  );
  const modal = await screen.findByRole("dialog", {
    name: "配置「Office」的用户入口",
  });
  expect(await within(modal).findByText("先创建用户")).toBeTruthy();
  expect(
    within(modal)
      .getByRole("link", { name: "前往用户管理" })
      .getAttribute("href"),
  ).toBe("#users");
  expect(
    (
      within(modal).getByRole("button", {
        name: "创建用户入口",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it.each([
  ["public", "leave"],
  ["public", "stay"],
  ["server", "leave"],
  ["server", "stay"],
  ["public", "same-target"],
  ["server", "same-target"],
  ["public", "pending-return"],
  ["server", "pending-return"],
] as const)(
  "authorizes the entire %s save completion against its original view after %s",
  async (kind, action) => {
    setup("routeweaver/managed-xray", "26.3.27-rw1", false);
    const originalFetch = globalThis.fetch;
    const deployment = (
      await (await originalFetch("/api/server-deployments")).json()
    )[0];
    let finishSave: ((response: Response) => void) | undefined;
    let saved: unknown;
    let inventoryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (
          !init?.method &&
          path.endsWith(
            kind === "public" ? "/published-routes" : "/server-deployments",
          )
        )
          inventoryReads++;
        if (path.endsWith("/reveal")) return json(deployment);
        if (
          init?.method === "PUT" &&
          path.includes(
            kind === "public" ? "/published-routes/" : "/server-deployments/",
          )
        ) {
          saved = {
            ...(kind === "public" ? route : deployment),
            ...JSON.parse(String(init.body)),
          };
          return new Promise<Response>((resolve) => {
            finishSave = resolve;
          });
        }
        return originalFetch(url, init);
      }),
    );
    const base = kind === "public" ? "#published-routes" : "#routes";
    const detail =
      kind === "public"
        ? `${base}?line=public`
        : `${base}?deployment=deploy-office`;
    const title = kind === "public" ? "Office" : "Office transfer";
    history.replaceState(null, "", base);
    const controller = createWorkspaceHistory({
      isDirty: hasUnsavedChanges,
      confirm: () => {
        throw new Error("Unchanged editor must be clean");
      },
      accept: () => {},
    });
    historyControllers.push(controller);
    const { client } = mount(
      <WorkspaceHistoryContext.Provider value={{ current: controller }}>
        {kind === "public" ? <PublishedRoutesPage /> : <ServerRoutesPage />}
      </WorkspaceHistoryContext.Provider>,
    );
    await screen.findByRole("heading", {
      name: kind === "public" ? "线路" : "转发路径",
      level: 1,
    });
    await act(async () => controller.navigate(detail));
    const drawer = await screen.findByRole("dialog", { name: title });
    await userEvent.click(
      within(drawer).getByRole("button", {
        name: kind === "public" ? "编辑线路" : "编辑转发路径",
      }),
    );
    const editor = await screen.findByRole("dialog", { name: `编辑 ${title}` });
    if (kind === "public") {
      await userEvent.click(
        within(editor).getByRole("button", { name: "检查公开线路" }),
      );
      await within(editor).findByText("路径检查完成");
    }
    let currentDetail = detail;
    if (action === "same-target") {
      currentDetail = `${detail}&user=user`;
      await act(async () => controller.navigate(currentDetail));
      expect(screen.getByRole("dialog", { name: `编辑 ${title}` })).toBe(
        editor,
      );
    }
    expect(hasUnsavedChanges()).toBe(false);
    await userEvent.click(
      within(editor).getByRole("button", {
        name: kind === "public" ? "保存公开线路" : "保存草稿",
      }),
    );
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    expect(client.isMutating()).toBe(1);
    let editorBeforeCompletion: HTMLElement | null = null;
    if (action === "leave") {
      await act(async () => history.back());
      await waitFor(() => expect(location.hash).toBe(base));
      await act(async () => {});
      editorBeforeCompletion = screen.queryByRole("dialog", {
        name: `编辑 ${title}`,
      });
    }
    if (action === "pending-return") {
      currentDetail = `${detail}&user=user`;
      await act(async () => controller.navigate(currentDetail));
      expect(screen.getByRole("dialog", { name: `编辑 ${title}` })).toBe(
        editor,
      );
    }
    const readsBeforeCompletion = inventoryReads;
    await act(async () => finishSave!(json(saved)));
    await waitFor(() => expect(client.isMutating()).toBe(0));
    await waitFor(() =>
      expect(inventoryReads).toBeGreaterThan(readsBeforeCompletion),
    );
    if (action === "leave") {
      expect(location.hash).toBe(base);
      expect(screen.queryByRole("dialog", { name: title })).toBeNull();
      expect(editorBeforeCompletion).toBeNull();
      expect(
        screen.queryByRole("dialog", { name: `编辑 ${title}` }),
      ).toBeNull();
      expect(
        screen.queryByText(
          kind === "public" ? "线路已保存" : "转发路径草稿已保存",
        ),
      ).toBeNull();
    } else {
      if (action === "pending-return") {
        // A mounted editor can receive new props while its mutation is pending.
        // The old completion must not borrow the new view's valid callback.
        expect(screen.getByRole("dialog", { name: `编辑 ${title}` })).toBe(
          editor,
        );
        expect(screen.queryByRole("dialog", { name: title })).toBeNull();
        expect(location.hash).toBe(currentDetail);
        expect(
          screen.queryByText(
            kind === "public" ? "线路已保存" : "转发路径草稿已保存",
          ),
        ).toBeNull();
        finishSave = undefined;
        await userEvent.click(
          within(editor).getByRole("button", {
            name: kind === "public" ? "保存公开线路" : "保存草稿",
          }),
        );
        await waitFor(() => expect(finishSave).toBeTypeOf("function"));
        await act(async () => finishSave!(json(saved)));
        await waitFor(() => expect(client.isMutating()).toBe(0));
      }
      expect(await screen.findByRole("dialog", { name: title })).toBeTruthy();
      expect(location.hash).toBe(currentDetail);
      expect(
        await screen.findByText(
          kind === "public" ? "线路已保存" : "转发路径草稿已保存",
        ),
      ).toBeTruthy();
    }
  },
);

it.each(["public", "server"] as const)("keeps the %s route Close control after twice canceling dirty dismissal", async (kind) => {
  setup("routeweaver/managed-xray", "26.3.27-rw1", false);
  const originalFetch = fetch;
  const deployment = (await (await originalFetch("/api/server-deployments")).json())[0];
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (init?.method && init.method !== "GET") writes.push(String(url));
    if (String(url).endsWith("/reveal")) return json(deployment);
    return originalFetch(url, init);
  }));
  mount(kind === "public" ? <PublishedRoutesPage /> : <ServerRoutesPage />);
  await userEvent.click(await screen.findByRole("button", { name: kind === "public" ? "编辑" : "编辑转发路径 Office transfer" }));
  const dialog = await screen.findByRole("dialog", { name: kind === "public" ? "编辑 Office" : "编辑 Office transfer" });
  const name = within(dialog).getByLabelText(kind === "public" ? "线路名称" : "转发路径名称");
  fireEvent.change(name, { target: { value: "Retained route" } });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(close);
    const review = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("button", { name: "继续编辑" })));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect((name as HTMLInputElement).value).toBe("Retained route");
  }
  expect(writes).toEqual([]);
});

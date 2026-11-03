// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ProfileEditor } from "./Profiles";
import { PublishedRoutesPage } from "./PublishedRoutes";
import { emptyProfile } from "./model";
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clientForRead = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  return client;
};
it("does not call paused linked-output reads empty and preserves the editable profile through recovery", async () => {
  const user = userEvent.setup();
  onlineManager.setOnline(false);
  const client = clientForRead();
  for (const key of ["sources", "collections", "resources", "platform-entries"])
    client.setQueryData([key], []);
  client.setQueryData(["overview"], { routes: [] });
  let release!: (response: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writes.push(url);
      if (url === "/api/me/outputs")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return json(url.endsWith("/overview") ? { routes: [] } : []);
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={{ ...emptyProfile(), name: "Original" }}
          isNew
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  expect(screen.getByText("等待核对关联订阅…")).toBeTruthy();
  expect(screen.queryByText("关联订阅（0）")).toBeNull();
  expect(screen.queryByText("暂无关联订阅")).toBeNull();
  const name = screen.getByRole("textbox", { name: "配置名称" });
  await user.clear(name);
  await user.type(name, "Unsent local draft");
  await act(async () => onlineManager.setOnline(true));
  await screen.findByText("正在核对此配置的订阅…");
  expect(screen.queryByText("暂无关联订阅")).toBeNull();
  await act(async () => release(json({ message: "关联读取失败" }, 503)));
  await screen.findByText("关联读取失败");
  expect((name as HTMLInputElement).value).toBe("Unsent local draft");
  await user.click(screen.getByRole("button", { name: "重新核对订阅" }));
  await screen.findByText("正在核对此配置的订阅…");
  await act(async () => release(json([])));
  await screen.findByText("关联订阅（0）");
  expect(screen.getByText("暂无关联订阅")).toBeTruthy();
  expect((name as HTMLInputElement).value).toBe("Unsent local draft");
  expect(writes).toEqual([]);
});
it("keeps user assignment offline, pending and failed without blocking dismissal or losing sibling input", async () => {
  const user = userEvent.setup();
  onlineManager.setOnline(false);
  const client = clientForRead();
  const instance = {
    id: "core",
    hostId: "host",
    adapterId: "routeweaver/managed-xray",
    version: "26.3.27-rw1",
  };
  const listener = {
    id: "entry",
    name: "Entry",
    instanceId: "core",
    connection: { protocol: "vless", host: "0.0.0.0", port: 443 },
  };
  const deployment = {
    id: "deployment",
    name: "Path",
    status: "draft",
    diagnostics: [],
    ir: {
      schemaVersion: "1.0",
      id: "deployment",
      topologyRevision: "1",
      programs: [{ instance, listener, egress: [], rules: [], resources: [] }],
    },
  };
  client.setQueryData(["infrastructure"], {
    hosts: [{ id: "host", name: "Host", address: "host.example.invalid" }],
    instances: [instance],
    endpoints: [listener],
    links: [],
    deployments: [deployment],
  });
  client.setQueryData(
    ["published-routes"],
    [
      {
        id: "route",
        name: "Route",
        deploymentId: "deployment",
        endpointIds: ["entry"],
        publicHost: "public.example.invalid",
        publicPort: 443,
        status: "draft",
        diagnostics: [],
      },
    ],
  );
  let release!: (response: Response) => void;
  const unexpected: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/state" || (init?.method && init.method !== "GET")) {
        unexpected.push(`${init?.method || "GET"} ${url}`);
        throw new Error("Unexpected request");
      }
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <PublishedRoutesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "配置用户入口" }));
  let dialog = await screen.findByRole("dialog", {
    name: "配置「Route」的用户入口",
  });
  expect(within(dialog).getByText("等待网络连接")).toBeTruthy();
  expect(within(dialog).queryByRole("combobox", { name: "用户" })).toBeNull();
  expect(within(dialog).queryByText("先创建用户")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  const returned = await screen.findByRole("dialog", { name: "Route" });
  expect(
    screen.queryByRole("dialog", { name: "配置「Route」的用户入口" }),
  ).toBeNull();
  await user.click(within(returned).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(screen.getByRole("button", { name: "配置用户入口" }));
  dialog = await screen.findByRole("dialog", {
    name: "配置「Route」的用户入口",
  });
  await user.click(within(dialog).getByText("凭据与版本设置"));
  const version = within(dialog).getByRole("textbox", { name: "凭据版本" });
  await user.clear(version);
  await user.type(version, "unsent-version");
  await act(async () => onlineManager.setOnline(true));
  const pending = await within(dialog).findByRole("status", {
    name: "正在加载",
  });
  expect(pending.getAttribute("aria-busy")).toBe("true");
  expect(pending.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
  expect((version as HTMLInputElement).value).toBe("unsent-version");
  await act(async () => release(json({ message: "用户读取失败" }, 503)));
  await within(dialog).findByText("用户读取失败");
  expect(within(dialog).queryByRole("combobox", { name: "用户" })).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "重试" }));
  await within(dialog).findByRole("status", { name: "正在加载" });
  await act(async () =>
    release(json({ users: [{ id: "user", name: "Alice" }] })),
  );
  await user.click(
    await within(dialog).findByRole("combobox", { name: "用户" }),
  );
  await user.click(await screen.findByRole("option", { name: "Alice" }));
  expect((version as HTMLInputElement).value).toBe("unsent-version");
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.refetchQueries({
      queryKey: ["principal-users"],
      exact: true,
    });
  });
  expect(
    within(dialog).getByRole("combobox", { name: "用户" }).textContent,
  ).toContain("Alice");
  expect(within(dialog).queryByRole("status", { name: "正在加载" })).toBeNull();
  await act(async () => {
    release(json({ message: "后台用户读取失败" }, 503));
    await refresh;
  });
  expect(await within(dialog).findByText("后台用户读取失败")).toBeTruthy();
  expect(
    within(dialog).getByRole("combobox", { name: "用户" }).textContent,
  ).toContain("Alice");
  expect((version as HTMLInputElement).value).toBe("unsent-version");
  act(() => onlineManager.setOnline(false));
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await screen.findByRole("dialog", { name: "Route" });
  expect(
    screen.queryByRole("dialog", { name: "配置「Route」的用户入口" }),
  ).toBeNull();
  expect(unexpected).toEqual([]);
});

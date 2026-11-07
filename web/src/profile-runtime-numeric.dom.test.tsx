// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";

const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const missing = (location: { kind: string; id?: string }, ref = "removed") => ({
  code: "missing_action_reference",
  reference: { kind: "endpoint", id: ref },
  location,
});
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "/");
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
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  onlineManager.setOnline(true);
});
function mount(
  profile: Profile,
  validation: unknown = missing({ kind: "default" }),
  options: {
    status?: number;
    detail?: string;
    preview?: () => Promise<Response>;
    entries?: () => Promise<Response>;
    input?: () => Promise<Response>;
    output?: Output;
    outputs?: Output[];
    cachedEntries?: boolean;
    staleTime?: number;
  } = {},
) {
  const writes: { path: string; body: Profile }[] = [];
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: options.staleTime },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  if (options.cachedEntries) client.setQueryData(["platform-entries"], []);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/me/platform-entries" && options.entries)
        return options.entries();
      if (path === "/api/me/collections/preview")
        return options.input
          ? options.input()
          : json({ endpoints: [], stages: [] });
      if (init?.method === "POST" || init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        if (path.endsWith("/preview"))
          return options.preview
            ? options.preview()
            : json(
                {
                  detail:
                    options.detail ||
                    "defaultAction: endpoint reference missing",
                  validation,
                },
                options.status || 400,
              );
        return json(body);
      }
      return json(
        path.endsWith("/outputs") && (options.outputs || options.output)
          ? options.outputs || [options.output]
          : path.endsWith("/sources") && profile.sourceIds?.length
            ? [
                {
                  id: profile.sourceIds[0],
                  name: "Source",
                  kind: "text",
                  enabled: true,
                  snapshot: { endpoints: [] },
                },
              ]
            : [],
      );
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={options.output}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, client };
}
// Source-only reconstruction: runtime checks are UNRUN.
it.each(["-", "1e", "", "7890.0000000000000001", "65535.000000000000001", "1e999999"])(
  "retains runtime port intent %s across navigation and blocks stale requests until repaired",
  async (raw) => {
    const profile = { ...emptyProfile(), id: "numeric-profile", name: "Numeric profile" };
    const { writes } = mount(profile);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "运行设置" }));
    const port = screen.getByRole("spinbutton", { name: "本地混合代理端口" });
    fireEvent.change(port, { target: { value: raw } });
    expect((port as HTMLInputElement).value).toBe(raw);
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "检查与预览" }));
    await user.click(screen.getByRole("button", { name: "预览配置" }));
    await waitFor(() => expect(document.activeElement).toBe(port));
    expect((port as HTMLInputElement).value).toBe(raw);
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await user.click(screen.getByRole("button", { name: "保存并检查" }));
    expect(writes).toEqual([]);
    fireEvent.change(port, { target: { value: "8.080e3" } });
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.runtime.mixedPort).toBe(8080);
  },
);

it("blocks an edited DNS decimal tail without changing other fields and keeps arrow correction", async () => {
  const profile = { ...emptyProfile(), id: "dns-numeric", name: "DNS numeric" };
  profile.ir.runtime.dns = { servers: [{ id: "dns", type: "udp", address: "1.1.1.1", port: 53 }], final: "dns" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  const port = screen.getByRole("spinbutton", { name: "DNS 端口 1" });
  fireEvent.change(port, { target: { value: "53.000000000000000001" } });
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(writes).toEqual([]);
  expect((port as HTMLInputElement).value).toBe("53.000000000000000001");
  fireEvent.keyDown(port, { key: "ArrowUp" });
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.runtime.dns?.servers[0].port).toBe(54);
});

it("does not reinterpret untouched zero and optional DNS ports", async () => {
  const profile = { ...emptyProfile(), id: "legacy-ports", name: "Legacy ports" };
  profile.ir.runtime.mixedPort = 0;
  profile.ir.runtime.dns = { servers: [{ id: "dns", type: "tls", address: "1.1.1.1" }], final: "dns" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.runtime.mixedPort).toBe(0);
  expect(writes[0].body.ir.runtime.dns?.servers[0].port).toBeUndefined();
});

it("drops only the invalid DNS editor when its server is removed", async () => {
  const profile = { ...emptyProfile(), id: "remove-port", name: "Remove port" };
  profile.ir.runtime.dns = { servers: [
    { id: "bad", type: "udp", address: "1.1.1.1", port: 53 },
    { id: "retained", type: "tls", address: "8.8.8.8", port: 853 },
  ], final: "retained" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 端口 1" }), { target: { value: "1e" } });
  await user.click(screen.getByRole("button", { name: "删除 DNS 1" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.runtime.dns?.servers).toEqual([
    { id: "retained", type: "tls", address: "8.8.8.8", port: 853 },
  ]);
});

it.each([7890, 8080])("discards old numeric edits only when JSON is explicitly applied, then saves port %s", async (mixedPort) => {
  const profile = { ...emptyProfile(), id: "replace-ports", name: "Replace ports" };
  profile.ir.runtime.dns = { servers: [{ id: "reused-dns", type: "udp", address: "1.1.1.1", port: 53 }], final: "reused-dns" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "本地混合代理端口" }), { target: { value: "1e" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 端口 1" }), { target: { value: "53.000000000000000001" } });
  await user.click(screen.getByRole("button", { name: "高级：配置意图与目标版本" }));
  await user.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  const replacement = structuredClone(profile.ir);
  replacement.runtime.mixedPort = mixedPort;
  replacement.runtime.dns!.servers[0].port = 853;
  fireEvent.change(screen.getByRole("textbox", { name: "配置意图 JSON 文本" }), { target: { value: JSON.stringify(replacement) } });
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "配置意图 JSON 文本" })).toBeNull());
  expect((screen.getByRole("spinbutton", { name: "本地混合代理端口" }) as HTMLInputElement).value).toBe(String(mixedPort));
  expect((screen.getByRole("spinbutton", { name: "DNS 端口 1" }) as HTMLInputElement).value).toBe("853");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.runtime.mixedPort).toBe(mixedPort);
  expect(writes[0].body.ir.runtime.dns?.servers[0]).toEqual({ id: "reused-dns", type: "udp", address: "1.1.1.1", port: 853 });
});

it.each([
  { servers: [null], final: "reused-dns" },
  { servers: [{ id: "reused-dns", type: "udp", address: "1.1.1.1", port: 53 }], final: 17 },
  { servers: [{ id: "reused-dns", type: "udp", address: 17, port: 53 }], final: "reused-dns" },
])("preserves explicit malformed DNS replacement without a hidden numeric blocker", async (dns) => {
  const profile = { ...emptyProfile(), id: "replace-malformed-dns", name: "Malformed DNS replacement" };
  profile.ir.runtime.dns = { servers: [{ id: "reused-dns", type: "udp", address: "1.1.1.1", port: 53 }], final: "reused-dns" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "本地混合代理端口" }), { target: { value: "1e" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "DNS 端口 1" }), { target: { value: "1e" } });
  await user.click(screen.getByRole("button", { name: "高级：配置意图与目标版本" }));
  await user.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  const replacement = { ...profile.ir, runtime: { ...profile.ir.runtime, dns } };
  fireEvent.change(screen.getByRole("textbox", { name: "配置意图 JSON 文本" }), { target: { value: JSON.stringify(replacement) } });
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await screen.findByText("DNS 结构无法读取");
  expect(screen.queryByRole("spinbutton", { name: "DNS 端口 1" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.runtime.dns).toEqual(dns);
  expect(writes[0].body.ir.runtime.mixedPort).toBe(profile.ir.runtime.mixedPort);
  await user.click(screen.getByRole("button", { name: "修复 DNS JSON" }));
  const repairText = screen.getByRole("textbox", { name: "配置意图 JSON 文本" }) as HTMLTextAreaElement;
  expect(JSON.parse(repairText.value).runtime.dns).toEqual(dns);
  const repaired = structuredClone(profile.ir);
  repaired.runtime.mixedPort = 8080;
  repaired.runtime.dns!.servers[0].port = 853;
  fireEvent.change(repairText, { target: { value: JSON.stringify(repaired) } });
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(screen.queryByText("DNS 结构无法读取")).toBeNull());
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body.ir.runtime.mixedPort).toBe(8080);
  expect(writes[1].body.ir.runtime.dns?.servers[0].port).toBe(853);
});

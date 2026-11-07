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
// Source-only regression specifications. Not executed in this recovery workspace.
it.each(["1e", "-", "300.00000000000000001", "9007199254740993"])("blocks existing group raw interval %s and recovers repeatedly", async (raw) => {
  const profile = { ...emptyProfile(), id: "group-intent", name: "Group intent" };
  profile.ir.groups = [{ id: "test-group", name: "Probe", kind: "url-test", members: [{ kind: "direct" }], intervalSeconds: 300 }];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "策略组" }));
  await user.click(screen.getByRole("button", { name: "策略参数" }));
  const interval = screen.getByRole("spinbutton", { name: "测试间隔（秒）" });
  fireEvent.change(interval, { target: { value: raw } });
  await user.click(screen.getByRole("tab", { name: "检查与预览" }));
  await user.click(screen.getByRole("button", { name: "预览配置" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "测试间隔（秒）" })));
  expect((screen.getByRole("spinbutton", { name: "测试间隔（秒）" }) as HTMLInputElement).value).toBe(raw);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "测试间隔（秒）" })));
  expect(writes).toEqual([]);
  fireEvent.change(screen.getByRole("spinbutton", { name: "测试间隔（秒）" }), { target: { value: "6e1" } });
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.groups[0].intervalSeconds).toBe(60);
});

it.each(["blank", "arrow", "untouched"])("retains group interval %s semantics", async (mode) => {
  const profile = { ...emptyProfile(), id: "group-controls", name: "Group controls" };
  profile.ir.groups = [{ id: "test-group", name: "Probe", kind: "url-test", members: [{ kind: "direct" }], intervalSeconds: 0 }];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  if (mode !== "untouched") {
    await user.click(screen.getByRole("tab", { name: "策略组" }));
    await user.click(screen.getByRole("button", { name: "策略参数" }));
    const interval = screen.getByRole("spinbutton", { name: "测试间隔（秒）" });
    fireEvent.change(interval, { target: { value: mode === "blank" ? "" : "1e" } });
    if (mode === "arrow") fireEvent.keyDown(interval, { key: "ArrowUp" });
  }
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.groups[0].intervalSeconds).toBe(mode === "blank" ? 300 : mode === "arrow" ? 1 : 0);
});

it("keeps create-and-use interval ownership until corrected or cancelled", async () => {
  const profile = { ...emptyProfile(), id: "group-modal", name: "Group modal" };
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "默认流量：使用多个候选连接…" }));
  const dialog = await screen.findByRole("dialog", { name: "创建并使用策略组" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "策略组名称" }), { target: { value: "Probe" } });
  await user.click(within(dialog).getByRole("switch", { name: "自动加入连接" }));
  await user.click(within(dialog).getByRole("combobox", { name: "选择策略" }));
  await user.click(screen.getByRole("option", { name: "延迟优选" }));
  await user.click(within(dialog).getByRole("button", { name: "策略参数" }));
  const interval = within(dialog).getByRole("spinbutton", { name: "测试间隔（秒）" });
  fireEvent.change(interval, { target: { value: "300.000000000000000001" } });
  await user.click(within(dialog).getByRole("button", { name: "策略参数" }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.click(within(dialog).getByRole("button", { name: "创建并使用" }));
    await waitFor(() => expect(document.activeElement).toBe(interval));
    expect((interval as HTMLInputElement).value).toBe("300.000000000000000001");
  }
  expect(writes).toEqual([]);
  fireEvent.change(interval, { target: { value: "" } });
  await user.click(within(dialog).getByRole("button", { name: "创建并使用" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "创建并使用策略组" })).toBeNull());
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.groups[0].intervalSeconds).toBe(300);
});

it.each([300, 600])("replaces invalid group raw intent with explicitly applied JSON interval %s", async (intervalSeconds) => {
  const profile = { ...emptyProfile(), id: "group-json", name: "Group JSON" };
  profile.ir.groups = [{ id: "test-group", name: "Probe", kind: "url-test", members: [{ kind: "direct" }], intervalSeconds: 300 }];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "策略组" }));
  await user.click(screen.getByRole("button", { name: "策略参数" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "测试间隔（秒）" }), { target: { value: "300.00000000000000001" } });
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByRole("button", { name: "高级：配置意图与目标版本" }));
  await user.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  const replacement = structuredClone(profile.ir);
  replacement.groups[0].intervalSeconds = intervalSeconds;
  fireEvent.change(screen.getByRole("textbox", { name: "配置意图 JSON 文本" }), { target: { value: JSON.stringify(replacement) } });
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "配置意图 JSON 文本" })).toBeNull());
  await user.click(screen.getByRole("tab", { name: "策略组" }));
  await user.click(screen.getByRole("button", { name: "策略参数" }));
  expect((screen.getByRole("spinbutton", { name: "测试间隔（秒）" }) as HTMLInputElement).value).toBe(String(intervalSeconds));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.groups[0].intervalSeconds).toBe(intervalSeconds);
});

it.each(["manual", "url-test"])("retires invalid interval when manual removes the field, then saves %s", async (kind) => {
  const profile = { ...emptyProfile(), id: "group-manual", name: "Group manual" };
  profile.ir.groups = [{ id: "test-group", name: "Probe", kind: "url-test", members: [{ kind: "direct" }], intervalSeconds: 600 }];
  const { writes } = mount(profile);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "策略组" }));
  await user.click(screen.getByRole("button", { name: "策略参数" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "测试间隔（秒）" }), { target: { value: "1e" } });
  await user.click(screen.getByRole("combobox", { name: "选择策略" }));
  await user.click(screen.getByRole("option", { name: "手动选择" }));
  expect(screen.queryByRole("spinbutton", { name: "测试间隔（秒）" })).toBeNull();
  if (kind === "url-test") {
    await user.click(screen.getByRole("combobox", { name: "选择策略" }));
    await user.click(screen.getByRole("option", { name: "延迟优选" }));
    expect((screen.getByRole("spinbutton", { name: "测试间隔（秒）" }) as HTMLInputElement).value).toBe("300");
  }
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.groups[0].kind).toBe(kind);
  expect(writes[0].body.ir.groups[0].intervalSeconds).toBe(kind === "manual" ? undefined : 300);
});

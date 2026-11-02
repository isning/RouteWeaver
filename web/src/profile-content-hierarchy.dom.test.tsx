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
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { ClientNode, Output, Profile, Source } from "./types";

const node = (id: string, name: string): ClientNode => ({
  id,
  name,
  origin: "imported",
  connection: { protocol: "socks", host: `${id}.example.test`, port: 1080 },
});
const effective = [
  node("tokyo", "Tokyo accepted"),
  node("london", "London accepted"),
];
const source: Source = {
  id: "travel-source",
  name: "Travel source",
  kind: "text",
  enabled: true,
  snapshot: {
    endpoints: [...effective, node("filtered", "Raw filtered node")],
  },
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture() {
  const profile = {
    ...emptyProfile(),
    id: "intent-profile",
    name: "Travel configuration",
    sourceIds: [source.id],
  };
  profile.ir.name = profile.name;
  return profile;
}
function mount(
  profile: Profile = fixture(),
  options: {
    output?: Output;
    inputFailure?: boolean;
    isNew?: boolean;
    saveResponse?: () => Promise<Response>;
  } = {},
) {
  const writes: { path: string; body: any }[] = [];
  const savedSources = [source];
  const onClose = vi.fn();
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/me/collections/preview")
      return options.inputFailure
        ? json({ detail: "Accepted source is unavailable" }, 503)
        : json({ endpoints: effective, stages: [] });
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/api/me/sources") {
        const savedSource = { ...body, snapshot: { endpoints: effective } };
        savedSources.push(savedSource);
        return json(savedSource);
      }
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "checked-phone",
          outputId: options.output?.id,
          artifacts: [{ path: "config.json", content: "checked exact client" }],
        });
      if (path.startsWith("/api/me/profiles") && options.saveResponse)
        return options.saveResponse();
      return json(body);
    }
    return json(
      path.endsWith("/sources")
        ? savedSources
        : path.endsWith("/outputs") && options.output
          ? [options.output]
          : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor
          initial={profile}
          isNew={options.isNew ?? false}
          output={options.output}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, fetcher, onClose, client };
}

it("offers one strategy-group action in an empty panel and retains it after adding", async () => {
  mount();
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
  expect(screen.getByText("暂无策略组")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加策略组" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "添加策略组" }));
  expect(screen.queryByText("暂无策略组")).toBeNull();
  expect(screen.getByRole("textbox", { name: "策略组名称" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加策略组" })).toHaveLength(1);
});

it("names save-before-inspection, preserves direct intent, and cancels only the review", async () => {
  const { writes } = mount(fixture(), { isNew: true });
  await screen.findByText("2 个有效连接");
  expect(screen.getByText("已导入的连接尚未用于分流。")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存并检查" }));
  const review = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(
    writes.filter((write) => write.path === "/api/me/profiles"),
  ).toHaveLength(1);
  expect(
    writes.find((write) => write.path === "/api/me/profiles")?.body.ir
      .defaultAction,
  ).toEqual({ kind: "direct" });
  await userEvent.click(
    within(review).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "检查发布" })).toBeTruthy();
  expect(screen.getByText("草稿已保存")).toBeTruthy();
  expect(writes.some((write) => write.path.includes("/outputs"))).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Changed draft" },
  });
  expect(screen.getByRole("button", { name: "保存并检查" })).toBeTruthy();
});

it("opens inspection of a saved profile without saving or publishing again", async () => {
  const { writes } = mount();
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("button", { name: "检查发布" }));
  const review = await screen.findByRole("dialog", { name: "新增客户端订阅" });
  await userEvent.click(
    within(review).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(writes).toEqual([]);
  expect(screen.getByRole("button", { name: "检查发布" })).toBeTruthy();
});

it("keeps one saved state with the save actions through repeated saves and the next edit", async () => {
  const { writes } = mount();
  await screen.findByText("2 个有效连接");
  const actions = screen.getByRole("group", { name: "保存与检查配置" });
  expect(within(actions).getByRole("status").textContent).toBe("已保存草稿");
  const save = within(actions).getByRole("button", {
    name: "保存草稿",
  });
  await userEvent.click(save);
  await waitFor(() =>
    expect(within(actions).getByRole("status").textContent).toBe("草稿已保存"),
  );
  await userEvent.click(save);
  await waitFor(() =>
    expect(
      writes.filter((w) => w.path === "/api/me/profiles/intent-profile"),
    ).toHaveLength(2),
  );
  expect(screen.getAllByText("草稿已保存")).toHaveLength(1);
  expect(screen.queryByText("配置草稿已保存")).toBeNull();
  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Edited name" },
  });
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  expect(
    within(actions).getByRole("button", { name: "保存并检查" }),
  ).toBeTruthy();
});

it("keeps dirty input and error on failed save while pending actions stay busy", async () => {
  let resolveSave!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveSave = resolve;
  });
  mount(fixture(), { saveResponse: () => pending });
  await screen.findByText("2 个有效连接");
  const name = screen.getByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Unsaved retained name" } });
  const actions = screen.getByRole("group", { name: "保存与检查配置" });
  const save = within(actions).getByRole("button", {
    name: "保存草稿",
  });
  await userEvent.click(save);
  const check = within(actions).getByRole("button", {
    name: "保存并检查",
  });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(check.getAttribute("aria-busy")).toBe("true");
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  resolveSave(json({ detail: "Draft save unavailable" }, 503));
  await screen.findByText("Draft save unavailable");
  expect((name as HTMLInputElement).value).toBe("Unsaved retained name");
  expect(within(actions).getByRole("status").textContent).toBe("草稿尚未保存");
  expect((save as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText("配置草稿已保存")).toBeNull();
});

it("new structured DNS selects its actual resolver and retains runtime intent after a rejected save", async () => {
  const initial = fixture();
  initial.ir.runtime.dns = undefined;
  const { writes } = mount(initial, {
    saveResponse: async () => json({ detail: "Synthetic stale draft" }, 409),
  });
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  await userEvent.click(screen.getByRole("switch", { name: "启用 DNS" }));
  await userEvent.click(screen.getByRole("switch", { name: "启用流量嗅探" }));
  await userEvent.click(screen.getByRole("switch", { name: "启用 TUN" }));
  fireEvent.change(screen.getByRole("textbox", { name: "DNS 服务器 1" }), {
    target: { value: "192.0.2.53" },
  });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("Synthetic stale draft");
  const saved = writes.find((entry) =>
    entry.path.endsWith("/intent-profile"),
  )!.body;
  expect(saved.ir.runtime.dns.final).toBe(saved.ir.runtime.dns.servers[0].id);
  expect(saved.ir.runtime.dns.servers[0]).toMatchObject({
    type: "tls",
    address: "192.0.2.53",
    port: 853,
  });
  expect(saved.ir.runtime.sniff).toBe(true);
  expect(saved.ir.runtime.tun).toEqual({
    enabled: true,
    addresses: ["172.19.0.1/30"],
    autoRoute: true,
  });
  expect(
    (screen.getByRole("textbox", { name: "DNS 服务器 1" }) as HTMLInputElement)
      .value,
  ).toBe("192.0.2.53");
  expect(
    screen
      .getByRole("switch", { name: "启用流量嗅探" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("switch", { name: "启用 TUN" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(
      writes.filter((entry) => entry.path.endsWith("/intent-profile")),
    ).toHaveLength(2),
  );
  expect(
    writes.filter((entry) => entry.path.endsWith("/intent-profile"))[1].body,
  ).toEqual(saved);
});

it("retains the opened profile draft on a typed revision conflict without upgrading its token or retrying", async () => {
  const profile = { ...fixture(), revisionToken: "opened-profile-revision" };
  const { fetcher, writes, onClose } = mount(profile, {
    saveResponse: async () =>
      json(
        { code: "PROFILE_DRAFT_CHANGED", message: "Changed in another editor" },
        409,
      ),
  });
  await screen.findByText("2 个有效连接");
  const name = screen.getByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "My submitted draft" } });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText(
    "配置或引用内容已变化。当前输入已保留，不能覆盖新版本。",
  );
  const sent = fetcher.mock.calls.find(
    ([, init]) => init?.method === "PUT",
  )![1]!;
  expect(new Headers(sent.headers).get("If-Match")).toBe(
    "opened-profile-revision",
  );
  expect(JSON.parse(String(sent.body))).not.toHaveProperty("revisionToken");
  expect((name as HTMLInputElement).value).toBe("My submitted draft");
  const save = screen.getByRole("button", { name: "保存草稿" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "保存并检查" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(name, { target: { value: "Still my retained draft" } });
  await userEvent.click(save);
  expect(writes.filter((w) => w.path.endsWith("/intent-profile"))).toHaveLength(
    1,
  );
  const discard = screen.getByRole("button", { name: "放弃修改并返回" });
  await userEvent.click(discard);
  const first = await screen.findByRole("alertdialog", {
    name: "放弃当前修改并返回？",
  });
  const keep = within(first).getByRole("button", { name: "保留当前输入" });
  expect(document.activeElement).toBe(keep);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((name as HTMLInputElement).value).toBe("Still my retained draft");
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(discard);
  await userEvent.click(discard);
  const second = await screen.findByRole("alertdialog", {
    name: "放弃当前修改并返回？",
  });
  await userEvent.click(
    within(second).getByRole("button", { name: "放弃修改并返回" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(writes.filter((w) => w.path.endsWith("/intent-profile"))).toHaveLength(
    1,
  );
  expect(
    fetcher.mock.calls.some(([url]) => String(url).endsWith("/reveal")),
  ).toBe(false);
});

it("uses only successful save revisions for later edits and keeps tokens out of draft previews and clone creation", async () => {
  let saved = 0;
  const profile = { ...fixture(), revisionToken: "source-profile-revision" };
  const { fetcher, writes } = mount(profile, {
    isNew: true,
    saveResponse: async () =>
      json({ ...profile, revisionToken: `accepted-${++saved}` }),
  });
  await screen.findByText("2 个有效连接");
  const save = screen.getByRole("button", { name: "保存草稿" });
  await userEvent.click(save);
  await screen.findByText("草稿已保存");
  await userEvent.click(save);
  await waitFor(() => expect(saved).toBe(2));
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  const requests = fetcher.mock.calls.filter(
    ([url, init]) =>
      String(url) === "/api/me/profiles" && init?.method === "POST",
  );
  expect(requests[0][1]?.method).toBe("POST");
  expect(new Headers(requests[0][1]?.headers).has("If-Match")).toBe(false);
  const update = fetcher.mock.calls.find(
    ([, init]) => init?.method === "PUT",
  )![1]!;
  expect(new Headers(update.headers).get("If-Match")).toBe("accepted-1");
  expect(JSON.parse(String(update.body))).not.toHaveProperty("revisionToken");
  await userEvent.click(screen.getByRole("tab", { name: "检查与预览" }));
  await userEvent.click(screen.getByRole("button", { name: "预览配置" }));
  await waitFor(() =>
    expect(
      writes.some((write) => write.path === "/api/me/profiles/preview"),
    ).toBe(true),
  );
  expect(
    writes.find((write) => write.path === "/api/me/profiles/preview")!.body,
  ).not.toHaveProperty("revisionToken");
});

it("does not label a rejected resave as saved after a previously accepted revision", async () => {
  let saves = 0;
  const profile = { ...fixture(), revisionToken: "opened" };
  mount(profile, {
    saveResponse: async () =>
      ++saves === 1
        ? json({ ...profile, revisionToken: "accepted" })
        : json(
            { code: "PROFILE_DRAFT_CHANGED", message: "Changed elsewhere" },
            409,
          ),
  });
  await screen.findByText("2 个有效连接");
  const save = screen.getByRole("button", { name: "保存草稿" });
  await userEvent.click(save);
  await screen.findByText("草稿已保存");
  await userEvent.click(save);
  await screen.findByRole("button", { name: "放弃修改并返回" });
  expect(
    within(screen.getByRole("group", { name: "保存与检查配置" })).getByRole(
      "status",
    ).textContent,
  ).toBe("草稿尚未保存");
});

it("finishes confirmed discard without leaving an editable form waiting on catalog refresh", async () => {
  const { onClose, client } = mount(
    { ...fixture(), revisionToken: "opened" },
    {
      saveResponse: async () => json({ code: "PROFILE_DRAFT_CHANGED" }, 409),
    },
  );
  await screen.findByText("2 个有效连接");
  let release!: (value: Profile[]) => void;
  const refresh = new Promise<Profile[]>((resolve) => {
    release = resolve;
  });
  client.setQueryData(["profiles"], [fixture()]);
  // An active parent catalog refetch is independently pending, like Subscriptions.
  const observer = new QueryObserver(client, {
    queryKey: ["profiles"],
    staleTime: Infinity,
    queryFn: () => refresh,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "放弃修改并返回" }),
    );
    const confirmation = await screen.findByRole("alertdialog", {
      name: "放弃当前修改并返回？",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "放弃修改并返回" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    release([fixture()]);
    unsubscribe();
  }
});

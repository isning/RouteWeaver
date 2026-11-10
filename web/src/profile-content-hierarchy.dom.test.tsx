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
import { useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  onlineManager,
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
  onlineManager.setOnline(true);
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
    unmountOnClose?: boolean;
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
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <ProfileEditor
      initial={profile}
      isNew={options.isNew ?? false}
      output={options.output}
      onClose={() => {
        onClose();
        if (options.unmountOnClose) setOpen(false);
      }}
    /> : <p>Profile list</p>;
  }
  const rendered = render(
    <QueryClientProvider client={client}>
      <UIProviders><Host /></UIProviders>
    </QueryClientProvider>,
  );
  return { writes, fetcher, onClose, client, unmount: rendered.unmount };
}

it("offers one strategy-group action in an empty panel and retains it after adding", async () => {
  mount();
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
  expect(screen.getByText("需要自动优选、故障切换或多个候选连接时，再添加策略组。")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "添加策略组" })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "添加策略组" }));
  expect(screen.queryByText("需要自动优选、故障切换或多个候选连接时，再添加策略组。")).toBeNull();
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
  expect(within(actions).getByRole("status").textContent).toBe("正在保存草稿，请等待结果。");
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

it("uses one keyboard tab control without losing the visible connection context or draft", async () => {
  const { writes } = mount();
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Retained tabbed draft" } });
  const before = { hash: location.hash, length: history.length };
  expect(screen.queryByRole("navigation", { name: "配置内容" })).toBeNull();
  expect(screen.getAllByRole("tablist")).toHaveLength(1);
  const tabs = screen.getByRole("tablist", { name: "配置内容" });
  const rules = within(tabs).getByRole("tab", { name: "分流规则" });
  rules.focus();
  await userEvent.keyboard("{ArrowRight}");
  const groups = within(tabs).getByRole("tab", { name: "策略组" });
  await waitFor(() => expect(document.activeElement).toBe(groups));
  expect(groups.getAttribute("aria-selected")).toBe("true");
  await userEvent.keyboard("{End}");
  const runtime = within(tabs).getByRole("tab", { name: "运行设置" });
  await waitFor(() => expect(document.activeElement).toBe(runtime));
  expect(runtime.getAttribute("aria-selected")).toBe("true");
  expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
  expect((name as HTMLInputElement).value).toBe("Retained tabbed draft");
  expect(location.hash).toBe(before.hash);
  expect(history.length).toBe(before.length);
  const connections = screen.getByRole("region", { name: "连接与流量" });
  expect(connections.textContent).toContain("Travel source");
  expect(within(connections).getByRole("combobox", { name: "默认流量行为" }).textContent).toContain("直连");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(writes).toEqual([]);
  await userEvent.keyboard("{Home}");
  await waitFor(() => expect(document.activeElement).toBe(rules));
  expect(rules.getAttribute("aria-selected")).toBe("true");
});

it("does not let the editor tabs bypass the pending-save interaction guard", async () => {
  let finish!: (response: Response) => void;
  mount(fixture(), { saveResponse: () => new Promise<Response>(resolve => { finish = resolve; }) });
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  const runtime = screen.getByRole("tab", { name: "运行设置" });
  await waitFor(() => expect((runtime as HTMLButtonElement).disabled).toBe(true));
  await userEvent.click(runtime);
  expect(screen.getByRole("tab", { name: "分流规则" }).getAttribute("aria-selected")).toBe("true");
  finish(json(fixture()));
  await waitFor(() => expect((runtime as HTMLButtonElement).disabled).toBe(false));
});

it("associates neutral name guidance with an untouched new draft while preserving save prerequisites", async () => {
  const { writes } = mount(emptyProfile(), { isNew: true });
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  const guidance = screen.getByText("填写配置名称后可保存或检查。");
  expect(name.getAttribute("aria-describedby")).toBe(guidance.id);
  expect(name.getAttribute("aria-invalid")).not.toBe("true");
  const save = screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
  const check = screen.getByRole("button", { name: "保存并检查" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(check.disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Daily routing" } });
  expect(screen.queryByText("填写配置名称后可保存或检查。")).toBeNull();
  expect(name.hasAttribute("aria-describedby")).toBe(false);
  await waitFor(() => expect(save.disabled).toBe(false));
  expect(check.disabled).toBe(false);
  fireEvent.change(name, { target: { value: "   " } });
  expect(name.getAttribute("aria-describedby")).toBe(screen.getByText("填写配置名称后可保存或检查。").id);
  expect(save.disabled).toBe(true);
  expect(check.disabled).toBe(true);
  expect(writes).toEqual([]);
});

it("groups runtime capabilities as equal rows with associated help and owned expanded parameters", async () => {
  const initial = fixture();
  initial.ir.runtime.dns = undefined;
  mount(initial);
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  const group = screen.getByRole("group", { name: "客户端网络能力" });
  const rows = Array.from(group.querySelectorAll(".runtime-setting-row"));
  expect(rows).toHaveLength(3);
  expect(rows.map(row => row.querySelector("h3")?.textContent)).toEqual(["DNS 解析", "流量嗅探", "TUN 虚拟网卡"]);
  for (const row of rows) {
    const toggle = within(row as HTMLElement).getByRole("switch");
    const help = document.getElementById(toggle.getAttribute("aria-describedby")!);
    expect(row.contains(help)).toBe(true);
    expect(help?.className).toContain("text-muted-foreground");
  }
  const dns = within(group).getByRole("switch", { name: "启用 DNS" });
  dns.focus();
  await userEvent.keyboard(" ");
  expect(document.activeElement).toBe(dns);
  expect(rows[0].contains(screen.getByRole("textbox", { name: "DNS 服务器 1" }))).toBe(true);
  const tun = within(group).getByRole("switch", { name: "启用 TUN" });
  await userEvent.click(tun);
  expect(rows[2].contains(screen.getByRole("checkbox", { name: "自动配置路由" }))).toBe(true);
  await userEvent.click(tun);
  expect(screen.queryByRole("checkbox", { name: "自动配置路由" })).toBeNull();
  expect(document.activeElement).toBe(tun);
  expect(screen.getByRole("group", { name: "保存与检查配置" }).textContent).toContain("草稿尚未保存");
});

it("keeps expanded runtime values through a pending save and reports the accepted draft", async () => {
  let finish!: (response: Response) => void;
  const initial = fixture();
  initial.ir.runtime.dns = undefined;
  const { writes } = mount(initial, { saveResponse: () => new Promise<Response>(resolve => { finish = resolve; }) });
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  await userEvent.click(screen.getByRole("switch", { name: "启用 DNS" }));
  fireEvent.change(screen.getByRole("textbox", { name: "DNS 服务器 1" }), { target: { value: "192.0.2.54" } });
  const save = screen.getByRole("button", { name: "保存草稿" });
  await userEvent.click(save);
  expect((save as HTMLButtonElement).disabled).toBe(true);
  const body = writes.find(entry => entry.path.endsWith("/intent-profile"))!.body;
  expect(body.ir.runtime.dns.servers[0].address).toBe("192.0.2.54");
  expect(screen.getByRole("group", { name: "客户端网络能力" }).closest("[inert]")).not.toBeNull();
  expect(screen.getByRole("textbox", { name: "DNS 服务器 1" })).toHaveProperty("value", "192.0.2.54");
  finish(json(body));
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("tab", { name: "运行设置" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("group", { name: "保存与检查配置" }).textContent).toContain("草稿已保存");
  expect(screen.getByRole("group", { name: "客户端网络能力" }).closest("[inert]")).toBeNull();
  expect(screen.getByRole("textbox", { name: "DNS 服务器 1" })).toHaveProperty("value", "192.0.2.54");
});

// DNS reconstruction contracts: authored at the public ProfileEditor seam;
// source-only and unrun in the 2026-11-06 recovery workspace.
it("retains a deleted default DNS identity until an explicit replacement is selected", async () => {
  const initial = fixture();
  initial.ir.runtime.dns = {
    servers: [
      { id: "dns-original", type: "tls", address: "192.0.2.53", port: 853 },
      { id: "dns-replacement", type: "tls", address: "192.0.2.54", port: 853 },
    ],
    final: "dns-original",
  };
  const { writes } = mount(initial);
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  await userEvent.click(screen.getByRole("button", { name: "删除 DNS 1" }));
  const selection = screen.getByRole("combobox", { name: "默认 DNS" });
  expect(selection.textContent).toContain("已缺失：dns-original");
  expect(selection.getAttribute("aria-invalid")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "重新选择默认 DNS" }));
  expect(document.activeElement).toBe(selection);
  expect(writes).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.some(entry => entry.path.endsWith("/intent-profile"))).toBe(true));
  expect(writes.find(entry => entry.path.endsWith("/intent-profile"))!.body.ir.runtime.dns).toEqual({
    servers: [{ id: "dns-replacement", type: "tls", address: "192.0.2.54", port: 853 }],
    final: "dns-original",
  });
  await userEvent.click(selection);
  await userEvent.click(screen.getByRole("option", { name: "192.0.2.54" }));
  expect(selection.getAttribute("aria-invalid")).not.toBe("true");
  expect(screen.queryByRole("button", { name: "重新选择默认 DNS" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.filter(entry => entry.path.endsWith("/intent-profile"))).toHaveLength(2));
  expect(writes.filter(entry => entry.path.endsWith("/intent-profile"))[1].body.ir.runtime.dns.final).toBe("dns-replacement");
});

it.each([
  ["null DNS", null],
  ["scalar DNS", "unreadable"],
  ["zero DNS", 0],
  ["false DNS", false],
  ["array DNS", []],
  ["missing servers", { final: "dns-missing" }],
  ["object servers", { servers: {}, final: "dns-missing" }],
  ["null row", { servers: [null], final: "dns-missing" }],
  ["scalar row", { servers: [false], final: "dns-missing" }],
  ["array row", { servers: [[]], final: "dns-missing" }],
  ["missing row identity", { servers: [{ type: "tls", address: "192.0.2.53" }], final: "dns-missing" }],
  ["mixed valid and invalid rows", { servers: [{ id: "dns-a", type: "tls", address: "192.0.2.53" }, null], final: "dns-missing" }],
  ["object address", { servers: [{ id: "dns-a", type: "tls", address: {} }], final: "dns-missing" }],
  ["object port", { servers: [{ id: "dns-a", type: "tls", address: "192.0.2.53", port: {} }], final: "dns-missing" }],
  ["object final", { servers: [], final: {} }],
])("keeps %s JSON-repairable and retains raw DNS after a rejected save", async (_name, dns) => {
  const { writes } = mount(fixture(), {
    saveResponse: async () => json({ detail: "Synthetic invalid DNS shape" }, 400),
  });
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  await userEvent.click(screen.getByText("高级：配置意图与目标版本"));
  await userEvent.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  const dialog = screen.getByRole("dialog", { name: "配置意图 JSON" });
  const input = within(dialog).getByRole("textbox") as HTMLTextAreaElement;
  const ir = JSON.parse(input.value);
  ir.runtime.dns = dns;
  fireEvent.change(input, { target: { value: JSON.stringify(ir) } });
  await userEvent.click(within(dialog).getByRole("button", { name: "应用到草稿" }));
  await screen.findByText("DNS 结构无法读取");
  expect(screen.queryByRole("combobox", { name: "默认 DNS" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "修复 DNS JSON" }));
  const repair = screen.getByRole("dialog", { name: "配置意图 JSON" });
  expect(JSON.parse((within(repair).getByRole("textbox") as HTMLTextAreaElement).value).runtime.dns).toEqual(dns);
  await userEvent.click(within(repair).getByRole("button", { name: "关闭" }));
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.some(entry => entry.path.endsWith("/intent-profile"))).toBe(true));
  expect(writes.find(entry => entry.path.endsWith("/intent-profile"))!.body.ir.runtime.dns).toEqual(dns);
  await screen.findByText("Synthetic invalid DNS shape");
  expect(screen.getByText("DNS 结构无法读取")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "修复 DNS JSON" }));
  const retained = screen.getByRole("dialog", { name: "配置意图 JSON" });
  expect(JSON.parse((within(retained).getByRole("textbox") as HTMLTextAreaElement).value).runtime.dns).toEqual(dns);
});

it.each(["dns-removed", ""])("keeps an empty DNS inventory with final %s through a rejected draft save and explicit addition", async (final) => {
  const initial = fixture();
  initial.ir.runtime.dns = { servers: [], final };
  const { writes } = mount(initial, {
    saveResponse: async () => json({ detail: "Synthetic stale DNS draft" }, 409),
  });
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "运行设置" }));
  const selection = screen.getByRole("combobox", { name: "默认 DNS" });
  expect(selection.textContent).toContain(final ? "已缺失：dns-removed" : "尚未选择默认 DNS");
  expect(screen.getByText("请先添加 DNS 服务器，再选择默认 DNS。可先保存草稿，检查通过后才能发布。")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("Synthetic stale DNS draft");
  expect(writes.find(entry => entry.path.endsWith("/intent-profile"))!.body.ir.runtime.dns).toEqual({ servers: [], final });
  await userEvent.click(screen.getByRole("button", { name: "添加 DNS" }));
  expect(selection.textContent).toContain(final ? "已缺失：dns-removed" : "尚未选择默认 DNS");
  expect(selection.getAttribute("aria-invalid")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "重新选择默认 DNS" }));
  expect(document.activeElement).toBe(selection);
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.filter(entry => entry.path.endsWith("/intent-profile"))).toHaveLength(2));
  const saved = writes.filter(entry => entry.path.endsWith("/intent-profile"))[1].body.ir.runtime.dns;
  expect(saved.final).toBe(final);
  expect(saved.servers).toHaveLength(1);
});


it.each(["direct", "reject"] as const)("starts with the traffic decision and allows %s without proxy sources", async (kind) => {
  const profile = { ...emptyProfile(), id: "direct-only", name: "Direct only" };
  profile.ir.defaultAction = { kind };
  const { writes } = mount(profile);
  await screen.findByText("直连与拒绝不需要代理连接");
  const traffic = screen.getByRole("heading", { name: "默认流量去向" });
  const connections = screen.getByRole("heading", { name: "代理连接" });
  expect(traffic.compareDocumentPosition(connections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText("0 个有效连接")).toBeNull();
  expect(screen.queryByText("未选择代理连接")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.some((write) => write.path.includes("/profiles"))).toBe(true));
  const saved = writes.find((write) => write.path.includes("/profiles"))!.body;
  expect(saved.ir.defaultAction).toEqual({ kind });
  expect(saved.ir.groups).toEqual([]);
});

it("shows the purpose of a saved strategy group before its form, preserving it when collapsed", async () => {
  const profile = fixture();
  profile.ir.groups = [{ id: "work", name: "Work route", kind: "manual", members: [{ kind: "direct" }] }];
  profile.ir.defaultAction = { kind: "group", ref: "work" };
  const { writes } = mount(profile);
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
  const summary = screen.getByText("Work route").closest("summary")!;
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  expect(summary.textContent).toContain("手动选择，1 个固定候选");
  expect(summary.textContent).not.toContain("尚未用于流量分配");
  fireEvent.click(summary);
  await waitFor(() => expect(details.open).toBe(true));
  fireEvent.change(screen.getByRole("textbox", { name: "策略组名称" }), { target: { value: "Work renamed" } });
  fireEvent.click(summary);
  await waitFor(() => expect(details.open).toBe(false));
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.some((write) => write.path.includes("/profiles"))).toBe(true));
  expect(writes.find((write) => write.path.includes("/profiles"))!.body.ir.groups[0]).toEqual({ ...profile.ir.groups[0], name: "Work renamed" });
});


it("distinguishes fixed, all-connection, and filtered automatic members while groups remain collapsed", async () => {
  const profile = fixture();
  profile.ir.groups = [
    { id: "fixed", name: "Fixed only", kind: "manual", members: [{ kind: "direct" }] },
    { id: "all", name: "All connections", kind: "manual", members: [], dynamic: {} },
    { id: "filtered", name: "Filtered connections", kind: "url-test", members: [], dynamic: { sourceId: source.id, namePattern: "Tokyo", protocol: "socks", region: "JP", tags: ["work"] } },
    { id: "unresolved", name: "Unresolved source", kind: "manual", members: [], dynamic: { sourceId: "private-opaque-source-id" } },
  ];
  const { writes } = mount(profile);
  await screen.findByText("2 个有效连接");
  await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
  const summary = (name: string) => screen.getByText(name, { exact: true }).closest("summary")!;
  expect(summary("Fixed only").textContent).toContain("仅固定成员");
  expect(summary("All connections").textContent).toContain("当前配置中的全部连接");
  const filtered = summary("Filtered connections");
  expect(filtered.textContent).toContain("按条件自动加入");
  expect(filtered.textContent).toContain("来源：Travel source");
  expect(filtered.textContent).toContain("名称匹配：Tokyo");
  expect(filtered.textContent).toContain("协议：socks");
  expect(filtered.textContent).toContain("地区：JP");
  expect(filtered.textContent).toContain("标签：work");
  expect(filtered.textContent).not.toContain(source.id);
  expect(summary("Unresolved source").textContent).toContain("指定来源（名称暂不可用）");
  expect(summary("Unresolved source").textContent).not.toContain("private-opaque-source-id");
  for (const name of ["Fixed only", "All connections", "Filtered connections", "Unresolved source"])
    expect(summary(name).closest("details")!.open).toBe(false);
  expect(writes).toEqual([]);
});


it("never sends an offline draft after discarding and reconnecting", async () => {
  const profile = { ...emptyProfile(), id: "direct-only", name: "Direct only" };
  const { writes } = mount(profile, { unmountOnClose: true });
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Abandoned offline draft" } });
  act(() => onlineManager.setOnline(false));
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await userEvent.click(await screen.findByRole("button", { name: "放弃修改" }));
  await screen.findByText("Profile list");
  await act(async () => {
    onlineManager.setOnline(true);
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(writes).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["保存草稿", "保存并检查"])("keeps offline values editable after %s and requires an explicit online retry", async (action) => {
  const profile = { ...emptyProfile(), id: "direct-only", name: "Direct only" };
  const { writes } = mount(profile);
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Offline draft" } });
  act(() => onlineManager.setOnline(false));
  await userEvent.click(screen.getByRole("button", { name: action }));
  await screen.findByText("当前离线，草稿未保存。请联网后重新保存。");
  expect(name.closest("[inert]")).toBeNull();
  expect(name).toHaveProperty("value", "Offline draft");
  fireEvent.change(name, { target: { value: "Recovered draft" } });
  await act(async () => {
    onlineManager.setOnline(true);
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(writes).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: action }));
  await waitFor(() => expect(writes.filter(write => write.path === "/api/me/profiles/direct-only")).toHaveLength(1));
  expect(writes[0].body.name).toBe("Recovered draft");
  if (action === "保存并检查") await screen.findByRole("dialog", { name: "新增客户端订阅" });
  else await screen.findByText("草稿已保存");
});

it("does not offer to discard a save already sent and blocks duplicate saves until it settles", async () => {
  let finish!: (response: Response) => void;
  const profile = { ...emptyProfile(), id: "direct-only", name: "Direct only" };
  const { writes, onClose } = mount(profile, {
    unmountOnClose: true,
    saveResponse: () => new Promise(resolve => { finish = resolve; }),
  });
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), { target: { value: "Pending online draft" } });
  await userEvent.dblClick(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  const back = screen.getByRole("button", { name: "返回" });
  expect(back).toHaveProperty("disabled", true);
  await userEvent.click(back);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "保存与检查配置" }).textContent).toContain("正在保存草稿，请等待结果。");
  finish(json(writes[0].body));
  await screen.findByText("草稿已保存");
  expect(back).toHaveProperty("disabled", false);
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findByText("Profile list");
  expect(writes).toHaveLength(1);
});

it("submits once when save and inspect are activated in the same event turn", async () => {
  let finish!: (response: Response) => void;
  const { writes } = mount({ ...emptyProfile(), id: "direct-only", name: "Direct only" }, {
    saveResponse: () => new Promise(resolve => { finish = resolve; }),
  });
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), { target: { value: "One submission" } });
  act(() => {
    screen.getByRole("button", { name: "保存草稿" }).click();
    screen.getByRole("button", { name: "保存并检查" }).click();
  });
  await waitFor(() => expect(writes).toHaveLength(1));
  finish(json(writes[0].body));
  await screen.findByText("草稿已保存");
  expect(writes).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not start a save after its editor has unmounted in the submission turn", async () => {
  const { writes, unmount } = mount({ ...emptyProfile(), id: "direct-only", name: "Direct only" });
  await screen.findByRole("textbox", { name: "配置名称" });
  await act(async () => {
    screen.getByRole("button", { name: "保存草稿" }).click();
    unmount();
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(writes).toEqual([]);
});

it("does not retry a sent save after losing connection and keeps its values on failure", async () => {
  let finish!: (response: Response) => void;
  const { writes } = mount({ ...emptyProfile(), id: "direct-only", name: "Direct only" }, {
    saveResponse: () => new Promise(resolve => { finish = resolve; }),
  });
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Retained failed draft" } });
  await userEvent.click(screen.getByRole("button", { name: "保存并检查" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  act(() => onlineManager.setOnline(false));
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  finish(json({ detail: "Save service unavailable" }, 503));
  await screen.findByText("Save service unavailable");
  expect(name.closest("[inert]")).toBeNull();
  expect(name).toHaveProperty("value", "Retained failed draft");
  await act(async () => {
    onlineManager.setOnline(true);
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(writes).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not reopen review in a newer view when an already sent save completes", async () => {
  let finish!: (response: Response) => void;
  const { writes } = mount({ ...emptyProfile(), id: "direct-only", name: "Direct only" }, {
    saveResponse: () => new Promise(resolve => { finish = resolve; }),
  });
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), { target: { value: "Saved before leaving" } });
  await userEvent.click(screen.getByRole("button", { name: "保存并检查" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  history.replaceState(null, "", "#subscriptions");
  finish(json(writes[0].body));
  await screen.findByText("草稿已保存");
  expect(location.hash).toBe("#subscriptions");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toHaveLength(1);
});

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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { EndpointFilter, Profile, Source } from "./types";

const source: Source = {
  id: "airport",
  name: "Airport",
  kind: "text",
  enabled: true,
};
const endpoints = [
  {
    id: "north",
    name: "North Gate",
    origin: "imported",
    sourceId: source.id,
    region: "HK",
    connection: { protocol: "socks", host: "north.example.test", port: 1080 },
  },
  {
    id: "south",
    name: "South Gate",
    origin: "imported",
    sourceId: source.id,
    region: "JP",
    connection: { protocol: "socks", host: "south.example.test", port: 1080 },
  },
];
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
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
function fixture(dynamic?: EndpointFilter): Profile {
  const profile = {
    ...emptyProfile(),
    id: "membership-profile",
    name: "My routes",
    sourceIds: [source.id],
  };
  profile.ir.name = profile.name;
  profile.ir.groups = [
    {
      id: "choice",
      name: "Airport choice",
      kind: "manual",
      members: [{ kind: "endpoint", ref: "north" }],
      ...(dynamic === undefined ? {} : { dynamic }),
    },
  ];
  profile.ir.defaultAction = { kind: "group", ref: "choice" };
  return profile;
}
function mount(profile = fixture()) {
  const writes: { path: string; body: Profile }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (path === "/api/me/collections/preview")
        return json({ endpoints, stages: [] });
      if (init?.method === "POST" || init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push({ path, body });
        return json(body);
      }
      if (path === "/api/me/sources")
        return json([{ ...source, snapshot: { endpoints } }]);
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const rendered = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ProfileEditor initial={profile} isNew={false} onClose={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "策略组" }), {
    button: 0,
    ctrlKey: false,
  });
  // These tests exercise the expanded membership form, not its overview.
  fireEvent.click(screen.getByText(profile.ir.groups[0].name, { exact: true }).closest("summary")!);
  return { writes, ...rendered };
}
function group() {
  return within(
    screen
      .getByRole("textbox", { name: "策略组名称" })
      .closest(".group-card") as HTMLElement,
  );
}
async function save(writes: { path: string; body: Profile }[]) {
  const before = writes.length;
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes.length).toBe(before + 1));
  await screen.findByText("草稿已保存");
  expect(writes[before].path).toBe("/api/me/profiles/membership-profile");
  return writes[before].body;
}

it("clearing the last condition keeps automatic membership enabled rather than silently removing members", async () => {
  const { writes } = mount(fixture({}));
  await screen.findByText("2 个有效连接");
  await userEvent.click(group().getByRole("button", { expanded: false }));
  fireEvent.change(group().getByRole("textbox", { name: "地区" }), {
    target: { value: "HK" },
  });
  fireEvent.change(group().getByRole("textbox", { name: "地区" }), {
    target: { value: "" },
  });
  const saved = await save(writes);
  expect(saved.ir.groups[0].dynamic).toEqual({});
  expect(saved.ir.groups[0].members).toEqual([
    { kind: "endpoint", ref: "north" },
  ]);
  expect(saved.ir.defaultAction).toEqual({ kind: "group", ref: "choice" });
});

it("makes automatic inclusion explicit and disabling clears conditions, never fixed members or the route", async () => {
  const { writes } = mount();
  await screen.findByText("2 个有效连接");
  const toggle = group().getByRole("switch", { name: "自动加入连接" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(group().getByText("仅固定成员")).toBeTruthy();
  expect(writes).toEqual([]);
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(group().getByText("当前配置中的全部连接")).toBeTruthy();
  expect(writes).toEqual([]);
  await userEvent.click(group().getByRole("button", { name: "筛选条件" }));
  fireEvent.change(group().getByRole("textbox", { name: "地区" }), {
    target: { value: "HK" },
  });
  expect(group().getByText("按条件自动加入")).toBeTruthy();
  expect(group().getByText("关闭将清除筛选条件")).toBeTruthy();
  await userEvent.click(toggle);
  expect(group().queryByRole("textbox", { name: "地区" })).toBeNull();
  const disabled = await save(writes);
  expect(disabled.ir.groups[0].dynamic).toBeUndefined();
  expect(disabled.ir.groups[0].members).toEqual([
    { kind: "endpoint", ref: "north" },
  ]);
  expect(disabled.ir.defaultAction).toEqual({ kind: "group", ref: "choice" });
  await userEvent.click(toggle);
  const enabled = await save(writes);
  expect(enabled.ir.groups[0].dynamic).toEqual({});
  expect(enabled.ir.groups[0].members).toEqual(disabled.ir.groups[0].members);
  expect(enabled.ir.defaultAction).toEqual(disabled.ir.defaultAction);
});

it.each([
  {
    label: "absent",
    dynamic: undefined,
    checked: "false",
    summary: "仅固定成员",
  },
  {
    label: "all",
    dynamic: {},
    checked: "true",
    summary: "当前配置中的全部连接",
  },
  {
    label: "filtered",
    dynamic: { sourceId: "airport", region: "HK" },
    checked: "true",
    summary: "按条件自动加入",
  },
])(
  "reopens a saved $label group without changing its membership state",
  async ({ dynamic, checked, summary }) => {
    const profile = fixture(dynamic);
    const original = structuredClone(profile);
    const first = mount(profile);
    await screen.findByText("2 个有效连接");
    expect(
      group()
        .getByRole("switch", { name: "自动加入连接" })
        .getAttribute("aria-checked"),
    ).toBe(checked);
    expect(group().getByText(summary)).toBeTruthy();
    expect(first.writes).toEqual([]);
    expect(profile).toEqual(original);
    fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
      target: { value: "Renamed configuration" },
    });
    const saved = await save(first.writes);
    expect(saved.ir.groups).toEqual(original.ir.groups);
    first.unmount();
    const reopened = mount(saved);
    await screen.findByText("2 个有效连接");
    expect(
      group()
        .getByRole("switch", { name: "自动加入连接" })
        .getAttribute("aria-checked"),
    ).toBe(checked);
    expect(group().getByText(summary)).toBeTruthy();
    expect(reopened.writes).toEqual([]);
  },
);

it("treats legacy null as off without rewriting it on open", async () => {
  const profile = fixture();
  profile.ir.groups[0].dynamic = null as unknown as EndpointFilter;
  const { writes } = mount(profile);
  await screen.findByText("2 个有效连接");
  expect(
    group()
      .getByRole("switch", { name: "自动加入连接" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(group().getByText("仅固定成员")).toBeTruthy();
  expect(writes).toEqual([]);
  expect(profile.ir.groups[0].dynamic).toBeNull();
});

it("clearing individual filters or a source restriction preserves all other defined conditions", async () => {
  const { writes } = mount(
    fixture({
      namePattern: "North",
      protocol: "socks",
      region: "HK",
      tags: ["preferred"],
      sourceId: "airport",
    }),
  );
  await screen.findByText("2 个有效连接");
  await userEvent.click(group().getByRole("button", { name: "筛选条件" }));
  fireEvent.change(group().getByRole("textbox", { name: "地区" }), {
    target: { value: "" },
  });
  let saved = await save(writes);
  expect(saved.ir.groups[0].dynamic).toEqual({
    namePattern: "North",
    protocol: "socks",
    tags: ["preferred"],
    sourceId: "airport",
  });
  const sourceField = within(
    group()
      .getByRole("combobox", { name: "限定来源" })
      .closest("label") as HTMLElement,
  );
  await userEvent.click(
    sourceField.getByRole("combobox", { name: "限定来源" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "清除选择" }));
  saved = await save(writes);
  expect(saved.ir.groups[0].dynamic).toEqual({
    namePattern: "North",
    protocol: "socks",
    tags: ["preferred"],
  });
  expect(
    group()
      .getByRole("switch", { name: "自动加入连接" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

it("clearing the last source restriction means all current connections, not off", async () => {
  const { writes } = mount(fixture({ sourceId: "airport" }));
  await screen.findByText("2 个有效连接");
  await userEvent.click(group().getByRole("button", { name: "筛选条件" }));
  const sourceField = within(
    group()
      .getByRole("combobox", { name: "限定来源" })
      .closest("label") as HTMLElement,
  );
  await userEvent.click(
    sourceField.getByRole("combobox", { name: "限定来源" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "清除选择" }));
  expect(group().getByText("当前配置中的全部连接")).toBeTruthy();
  expect(
    group()
      .getByRole("switch", { name: "自动加入连接" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect((await save(writes)).ir.groups[0].dynamic).toEqual({});
});

it("keeps the real empty-group error when automatic membership is explicitly disabled", async () => {
  const profile = fixture({});
  profile.ir.groups[0].members = [];
  mount(profile);
  await screen.findByText("2 个有效连接");
  expect(screen.queryByText(/请添加固定成员或开启自动加入连接/)).toBeNull();
  await userEvent.click(group().getByRole("switch", { name: "自动加入连接" }));
  expect(screen.getByText(/请添加固定成员或开启自动加入连接/)).toBeTruthy();
  expect(group().getByText("仅固定成员")).toBeTruthy();
});

it("retains exact fixed references and independent policy parameters while toggling automatic members", async () => {
  const profile = fixture({ region: "HK" });
  profile.ir.groups[0] = {
    ...profile.ir.groups[0],
    kind: "load-balance",
    members: [
      { kind: "endpoint", ref: "north" },
      { kind: "endpoint", ref: "north" },
      { kind: "endpoint", ref: "unknown:id:123" },
    ],
    testUrl: "https://probe.example.test",
    intervalSeconds: 123,
    strategy: "round-robin",
  };
  const { writes } = mount(profile);
  await screen.findByText("2 个有效连接");
  await userEvent.click(group().getByRole("switch", { name: "自动加入连接" }));
  await userEvent.click(group().getByRole("button", { name: "策略参数" }));
  expect(
    (group().getByRole("textbox", { name: "测试地址" }) as HTMLInputElement)
      .value,
  ).toBe("https://probe.example.test");
  const saved = await save(writes);
  expect(saved.ir.groups[0]).toEqual({
    ...profile.ir.groups[0],
    dynamic: undefined,
  });
  expect(saved.ir.defaultAction).toEqual(profile.ir.defaultAction);
});


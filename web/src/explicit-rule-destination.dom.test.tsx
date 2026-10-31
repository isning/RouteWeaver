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
import {
  rememberOutputComparison,
  outputInputSequence,
  useOutputComparison,
} from "./output-comparison";
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
function ComparisonWitness({ output }: { output: Output }) {
  return (
    <output aria-label="已保存比较观察">
      {useOutputComparison(output).text}
    </output>
  );
}
function mount(
  profile: Profile = fixture(),
  options: {
    output?: Output;
    outputs?: Output[];
    inputFailure?: boolean;
    validation?: unknown;
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
      if (path.endsWith("/preview") && options.validation)
        return json(
          {
            detail: "defaultAction: endpoint reference missing",
            validation: options.validation,
          },
          422,
        );
      if (path.endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "checked-phone",
          outputId: options.output?.id,
          artifacts: [{ path: "config.json", content: "checked exact client" }],
        });
      return json(body);
    }
    return json(
      path.endsWith("/sources")
        ? savedSources
        : path.endsWith("/outputs") && (options.outputs || options.output)
          ? options.outputs || [options.output]
          : [],
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const witness: Output = {
    id: "observed-device",
    name: "Observed device",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
    revision: "published-1",
  };
  rememberOutputComparison(
    client,
    witness,
    { ...witness, draftComparison: { state: "unchanged" } },
    Date.now(),
    outputInputSequence(client, profile.id),
  );
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ComparisonWitness output={witness} />
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={options.output}
          onClose={onClose}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    client,
    writes,
    fetcher,
    onClose,
    unmount: view.unmount,
    editor: within(view.container),
  };
}

async function addIncomplete(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "分流规则" }));
  await user.click(screen.getByRole("button", { name: "添加规则" }));
  await user.click(
    screen.getAllByRole("textbox", { name: "规则匹配值" }).at(-1)!,
  );
  await user.paste("example.com");
}
async function openJSON(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "运行设置" }));
  await user.click(screen.getByText("高级：配置意图与目标版本", {}));
  await user.click(screen.getByRole("button", { name: "编辑配置意图 JSON" }));
  return screen.getByRole("textbox", {
    name: "配置意图 JSON 文本",
  });
}
it.each(["保存草稿", "保存并检查", "预览配置"])(
  "%s blocks an incomplete rule before requests or invalidation and focuses its field",
  async (entry) => {
    const user = userEvent.setup();
    const { writes } = mount();
    const observation = screen.getByLabelText("已保存比较观察").textContent;
    await addIncomplete(user);
    const action = screen.getByRole("combobox", {
      name: "规则 1 的流量去向",
    });
    expect(action.getAttribute("aria-invalid")).not.toBe("true");
    expect(screen.queryByText("请选择此规则的流量去向", {})).toBeNull();
    if (entry === "预览配置")
      await user.click(screen.getByRole("tab", { name: "检查与预览" }));
    await user.click(screen.getByRole("button", { name: entry }));
    expect(writes).toEqual([]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", {
          name: "规则 1 的流量去向",
        }),
      ),
    );
    expect(
      screen
        .getByRole("combobox", { name: "规则 1 的流量去向" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByText("请选择此规则的流量去向", {})).toBeTruthy();
    expect(screen.getByLabelText("已保存比较观察").textContent).toBe(
      observation,
    );
    expect(screen.queryByRole("dialog", { name: "发布客户端订阅" })).toBeNull();
  },
);
it.each([
  ["直连", { kind: "direct" }],
  ["Tokyo accepted", { kind: "endpoint", ref: "tokyo" }],
] as const)(
  "saves an explicitly chosen %s without inheriting default",
  async (label, action) => {
    const user = userEvent.setup();
    const profile = fixture();
    profile.ir.defaultAction = { kind: "endpoint", ref: "london" };
    const { writes } = mount(profile);
    await screen.findByText("2 个有效连接");
    await addIncomplete(user);
    await user.click(
      screen.getByRole("combobox", { name: "规则 1 的流量去向" }),
    );
    await user.click(await screen.findByRole("option", { name: label }));
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.ir.rules[0].action).toEqual(action);
    expect(writes[0].body.ir.defaultAction).toEqual({
      kind: "endpoint",
      ref: "london",
    });
  },
);
it("reorders incomplete rules by identity and deletion restores saving without losing loaded intent", async () => {
  const user = userEvent.setup();
  const profile = fixture();
  const saved = {
    id: "saved-rule",
    match: { op: "domain", value: "existing.example" },
    action: { kind: "reject" },
  };
  profile.ir.rules = [saved];
  const { writes } = mount(profile);
  await addIncomplete(user);
  await user.click(screen.getByRole("button", { name: "上移规则 2" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  expect(writes).toEqual([]);
  await user.click(screen.getByRole("button", { name: "删除规则 1" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([saved]);
});
it("retains incomplete local action in JSON and returns its exact rule for explicit completion", async () => {
  const user = userEvent.setup();
  const { writes } = mount();
  await addIncomplete(user);
  const text = await openJSON(user);
  const ir = JSON.parse((text as HTMLTextAreaElement).value);
  expect(ir.rules[0].action).toBeNull();
  const id = ir.rules[0].id;
  ir.rules[0].match.value = "edited.example";
  await user.click(text);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(JSON.stringify(ir));
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  expect(writes).toEqual([]);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  await user.click(screen.getByRole("combobox", { name: "规则 1 的流量去向" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0].body.ir.rules).toEqual([
    {
      id,
      match: { op: "domain-suffix", value: "edited.example" },
      action: { kind: "direct" },
    },
  ]);
});
it("keeps action-absent JSON text and the prior complete draft instead of dropping its rule", async () => {
  const user = userEvent.setup();
  const profile = fixture();
  profile.ir.rules = [
    {
      id: "saved",
      match: { op: "domain", value: "old.example" },
      action: { kind: "reject" },
    },
  ];
  const { writes } = mount(profile);
  const text = await openJSON(user);
  const ir = JSON.parse((text as HTMLTextAreaElement).value);
  delete ir.rules[0].action;
  const invalid = JSON.stringify(ir);
  await user.click(text);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(invalid);
  await user.click(screen.getByRole("button", { name: "应用到草稿" }));
  expect((text as HTMLTextAreaElement).value).toBe(invalid);
  expect(writes).toEqual([]);
  expect(screen.getByRole("dialog", { name: "配置意图 JSON" })).toBeTruthy();
  expect(await screen.findByText(/规则 1 的 action 需为动作对象/)).toBeTruthy();
});
it("marks a newly incomplete rule dirty and keeps it when navigation is canceled", async () => {
  const user = userEvent.setup();
  const { onClose, writes } = mount();
  await addIncomplete(user);
  await user.click(screen.getByRole("button", { name: "返回" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await user.click(within(dialog).getByRole("button", { name: "继续编辑" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("textbox", {
        name: "规则匹配值",
      }) as HTMLInputElement
    ).value,
  ).toBe("example.com");
  expect(
    screen
      .getByRole("combobox", { name: "规则 1 的流量去向" })
      .getAttribute("aria-invalid"),
  ).toBe("false");
  expect(writes).toEqual([]);
});

it("shows errors only for rules present at a failed submission, then clears a completed field", async () => {
  const user = userEvent.setup();
  mount();
  await addIncomplete(user);
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("combobox", { name: "规则 1 的流量去向" })
        .getAttribute("aria-invalid"),
    ).toBe("true"),
  );
  await user.click(screen.getByRole("button", { name: "添加规则" }));
  expect(
    screen
      .getByRole("combobox", { name: "规则 2 的流量去向" })
      .getAttribute("aria-invalid"),
  ).toBe("false");
  await user.click(screen.getByRole("combobox", { name: "规则 1 的流量去向" }));
  await user.click(await screen.findByRole("option", { name: "直连" }));
  expect(screen.queryByText("请选择此规则的流量去向", {})).toBeNull();
  expect(
    screen
      .getByRole("combobox", { name: "规则 2 的流量去向" })
      .getAttribute("aria-invalid"),
  ).toBe("false");
});

it("retains explicitly selected Android review while an incomplete repair rule is edited and saved", async () => {
  const user = userEvent.setup();
  const profile = fixture();
  profile.ir.defaultAction = { kind: "endpoint", ref: "removed" };
  const mac: Output = {
    id: "mac",
    name: "MacBook",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  const android: Output = { ...mac, id: "android", name: "Android" };
  const { writes, editor } = mount(profile, {
    output: mac,
    outputs: [mac, android],
    validation: {
      code: "missing_action_reference",
      reference: { kind: "endpoint", id: "removed" },
      location: { kind: "default" },
    },
  });
  const toolbar = within(editor.getByRole("group", { name: "保存与检查配置" }));
  await user.click(toolbar.getByRole("button", { name: "检查发布" }));
  const chooser = within(
    await screen.findByRole("dialog", { name: "选择客户端订阅" }),
  );
  await user.click(
    await chooser.findByRole("radio", { name: /更新「Android」/ }),
  );
  await user.click(chooser.getByRole("button", { name: "检查所选订阅" }));
  const dialog = await screen.findByRole("dialog", {
    name: "检查订阅更新「Android」",
  });
  const failure = await within(dialog).findByRole("alert", {
    name: /^无法检查：/,
  });
  await user.click(
    within(failure).getByRole("button", { name: "调整默认流量去向" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const defaultDestination = editor.getByRole("combobox", {
    name: "默认流量行为",
  });
  await user.click(defaultDestination);
  const defaultList = document.getElementById(
    defaultDestination.getAttribute("aria-controls")!,
  );
  const defaultPopup = defaultList?.closest('[data-slot="popover-content"]');
  expect(defaultPopup).not.toBeNull();
  await user.click(
    await within(defaultPopup as HTMLElement).findByRole("option", {
      name: "直连",
    }),
  );
  await user.click(editor.getByRole("tab", { name: "分流规则" }));
  await user.click(editor.getByRole("button", { name: "添加规则" }));
  await user.click(
    editor.getAllByRole("textbox", { name: "规则匹配值" }).at(-1)!,
  );
  await user.paste("example.com");
  const before = writes.length;
  await user.click(toolbar.getByRole("button", { name: "保存并检查" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      editor.getByRole("combobox", { name: "规则 1 的流量去向" }),
    ),
  );
  expect(writes).toHaveLength(before);
  expect(screen.queryByRole("dialog")).toBeNull();
  const destination = editor.getByRole("combobox", {
    name: "规则 1 的流量去向",
  });
  await user.click(destination);
  const ownedList = document.getElementById(
    destination.getAttribute("aria-controls")!,
  );
  const ownedPopup = ownedList?.closest('[data-slot="popover-content"]');
  expect(ownedPopup).not.toBeNull();
  await user.click(
    within(ownedPopup as HTMLElement).getByRole("option", {
      name: "Tokyo accepted",
    }),
  );
  await user.click(toolbar.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(before + 1));
  await waitFor(() =>
    expect(toolbar.getByRole("status").textContent).toBe("草稿已保存"),
  );
  await user.click(toolbar.getByRole("button", { name: "检查发布" }));
  const returned = await screen.findByRole("dialog", {
    name: "检查订阅更新「Android」",
  });
  expect(
    within(await within(returned).findByRole("alert")).getByText(
      "defaultAction: endpoint reference missing",
    ),
  ).toBeTruthy();
  expect(
    (
      within(returned).getByRole("button", {
        name: "确认更新「Android」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.queryByRole("dialog", { name: "检查订阅更新「MacBook」" }),
  ).toBeNull();
  expect(writes.map((w) => w.path)).toEqual([
    "/api/me/profiles/intent-profile/preview",
    "/api/me/profiles/intent-profile",
    "/api/me/profiles/intent-profile/preview",
  ]);
  expect(
    writes.filter((w) => w.path.endsWith("/preview")).map((w) => w.body),
  ).toEqual([
    { outputId: "android", target: android.target, mode: android.mode },
    { outputId: "android", target: android.target, mode: android.mode },
  ]);
  await user.click(
    within(returned).getByRole("button", { name: "预览此订阅更新" }),
  );
  await waitFor(() => expect(writes).toHaveLength(4));
  expect(
    within(await within(returned).findByRole("alert")).getByText(
      "defaultAction: endpoint reference missing",
    ),
  ).toBeTruthy();
  expect(writes.map((w) => w.path)).toEqual([
    "/api/me/profiles/intent-profile/preview",
    "/api/me/profiles/intent-profile",
    "/api/me/profiles/intent-profile/preview",
    "/api/me/profiles/intent-profile/preview",
  ]);
  expect(
    writes.filter((w) => w.path.endsWith("/preview")).map((w) => w.body),
  ).toEqual([
    { outputId: "android", target: android.target, mode: android.mode },
    { outputId: "android", target: android.target, mode: android.mode },
    { outputId: "android", target: android.target, mode: android.mode },
  ]);
  expect(writes.at(-1)).toMatchObject({
    path: "/api/me/profiles/intent-profile/preview",
    body: { outputId: "android" },
  });
  expect(writes.some((w) => w.path.endsWith("/publish"))).toBe(false);
});

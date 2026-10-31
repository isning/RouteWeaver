// @vitest-environment jsdom
import { SOURCE_IMPORT_JOURNEY_TIMEOUT_MS } from "./test-support/source-import-journey";
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
import { CollectionsPage } from "./Sources";
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { Collection, Profile, Source } from "./types";
const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const accepted = (id: string, extra: Partial<Source> = {}): Source => ({
  id,
  name: id,
  kind: "text",
  enabled: true,
  revision: "r1",
  snapshot: { endpoints: [] },
  ...extra,
});
const recipe: Collection = {
  id: "collection",
  name: "Original collection",
  sources: [
    {
      sourceId: "Paused",
      steps: [
        {
          id: "rename",
          kind: "rename",
          enabled: true,
          template: "{name}-saved",
        },
      ],
    },
    { sourceId: "Available", steps: [] },
  ],
  steps: [{ id: "merge", kind: "deduplicate", enabled: true }],
};
function mount(sources: Source[], profile?: Profile, catalogError = false) {
  let inventory = structuredClone(sources);
  const writes: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url).replace(/^.*\/api/, "");
      const method = init?.method || "GET";
      if (method !== "GET") {
        const body = JSON.parse(String(init?.body));
        writes.push({ path, body });
        if (path.startsWith("/me/sources/")) {
          const saved = accepted(body.id, { ...body, revision: "r2" });
          inventory = inventory.map((s) => (s.id === saved.id ? saved : s));
          return json(saved);
        }
        if (path.endsWith("/preview"))
          return json({ endpoints: [], stages: [] });
        return json(body);
      }
      if (path === "/me/sources")
        return catalogError
          ? json({ error: "Inventory unavailable" }, 503)
          : json(inventory);
      if (path === "/me/collections") return json([recipe]);
      if (path === "/me/platform-entries")
        return json([
          {
            id: "platform",
            name: "Assigned entry",
            routeId: "route",
            credentialVersion: "v1",
            status: "configured-unverified",
          },
        ]);
      if (path.endsWith("/reveal"))
        return json({
          ...inventory.find((s) => path.includes(`/${s.id}/`)),
          content: "socks5://synthetic.example:1080#Example",
        });
      if (path.startsWith("/me/sources/")) {
        const summary = inventory.find((s) => path === `/me/sources/${s.id}`);
        return summary
          ? json({ ...summary, content: undefined, url: undefined })
          : json({ detail: "source not found" }, 404);
      }
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {profile ? (
          <ProfileEditor initial={profile} isNew={false} onClose={() => {}} />
        ) : (
          <CollectionsPage />
        )}
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, client };
}
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
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!this.isConnected) return null;
      for (
        let node: HTMLElement | null = this;
        node;
        node = node.parentElement
      ) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden")
          return null;
      }
      return this.parentElement;
    },
  );
});
afterEach(async () => {
  await act(async () => {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
  });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it(
  "names an unavailable selected source and repairs it without saving or replacing the rich collection draft",
  async () => {
    const { writes } = mount([
      accepted("Paused", { enabled: false }),
      accepted("Available"),
    ]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Original collection/ }),
    );
    let parent = within(
      await screen.findByRole("dialog", { name: "Original collection" }),
    );
    fireEvent.change(parent.getByLabelText("集合名称"), {
      target: { value: "Unsaved collection" },
    });
    await userEvent.click(parent.getByRole("button", { name: "下移来源 1" }));
    await userEvent.click(
      parent.getByRole("button", { name: /2\. Paused.*来源处理/ }),
    );
    fireEvent.change(parent.getByLabelText("步骤 1 命名模板"), {
      target: { value: "unsaved-{name}" },
    });
    const issues = within(
      await parent.findByRole("region", { name: "需要处理的来源" }),
    );
    expect(issues.getByText("Paused · 已暂停")).toBeTruthy();
    expect(
      (parent.getByRole("button", { name: "保存集合" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await userEvent.click(
      issues.getByRole("button", { name: "编辑来源 Paused" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await waitFor(() =>
      expect(
        (editor.getByLabelText("来源名称") as HTMLInputElement).value,
      ).toBe("Paused"),
    );
    await userEvent.click(
      await editor.findByRole("button", { name: /取\s*消/ }),
    );
    parent = within(
      await screen.findByRole("dialog", { name: "Unsaved collection" }),
    );
    expect(screen.queryByText("来源尚未加入集合")).toBeNull();
    expect((parent.getByLabelText("集合名称") as HTMLInputElement).value).toBe(
      "Unsaved collection",
    );
    await userEvent.click(
      parent.getByRole("button", { name: "编辑来源 Paused" }),
    );
    const again = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await waitFor(() =>
      expect((again.getByLabelText("来源名称") as HTMLInputElement).value).toBe(
        "Paused",
      ),
    );
    await userEvent.click(
      await again.findByRole("switch", { name: "启用来源" }),
    );
    await userEvent.click(again.getByRole("button", { name: "导入来源" }));
    parent = within(
      await screen.findByRole("dialog", { name: "Unsaved collection" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "需要处理的来源" }),
      ).toBeNull(),
    );
    expect(
      (parent.getByLabelText("步骤 1 命名模板") as HTMLInputElement).value,
    ).toBe("unsaved-{name}");
    expect(
      writes.filter(
        (w) =>
          w.path.includes("/me/collections") || w.path.includes("/me/profiles"),
      ),
    ).toEqual([]);
    await userEvent.click(parent.getByRole("button", { name: "预览处理结果" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/collections/preview")).toBe(
        true,
      ),
    );
    const body = writes.find((w) => w.path === "/me/collections/preview")!.body;
    expect(body.name).toBe("Unsaved collection");
    expect(body.sources.map((s: any) => s.sourceId)).toEqual([
      "Available",
      "Paused",
    ]);
    expect(body.sources[1].steps[0].template).toBe("unsaved-{name}");
    expect(body.steps).toEqual(recipe.steps);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "repairs a source inside a Profile's collection without changing its input mode or rich intent",
  async () => {
    const profile = {
      ...emptyProfile(),
      id: "profile",
      name: "Original profile",
      collectionId: recipe.id,
      sourceIds: ["Hidden"],
      platformEntryIds: ["platform"],
    };
    profile.ir.groups = [
      {
        id: "kept-group",
        name: "Kept group",
        kind: "select",
        members: [],
        dynamic: {},
      },
    ];
    profile.ir.defaultAction = { kind: "group", ref: "kept-group" };
    profile.ir.rules = [
      {
        id: "kept-rule",
        match: { op: "domain-suffix", value: "example.com" },
        action: { kind: "group", ref: "kept-group" },
      },
    ];
    const { writes } = mount(
      [
        accepted("Paused", { enabled: false }),
        accepted("Available"),
        accepted("Hidden"),
      ],
      profile,
    );
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "Unsaved profile" },
    });
    const issues = within(
      await screen.findByRole("region", { name: "需要处理的来源" }),
    );
    expect(
      (screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await userEvent.click(
      issues.getByRole("button", { name: "编辑来源 Paused" }),
    );
    const editor = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await userEvent.click(
      await editor.findByRole("button", { name: /取\s*消/ }),
    );
    expect(screen.queryByText("来源已保存，尚未加入此草稿")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "编辑来源 Paused" }),
    );
    const again = within(
      await screen.findByRole("dialog", { name: "编辑来源" }),
    );
    await userEvent.click(
      await again.findByRole("switch", { name: "启用来源" }),
    );
    await userEvent.click(again.getByRole("button", { name: "导入来源" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "需要处理的来源" }),
      ).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
    expect(
      screen
        .getByRole("radio", { name: "使用节点集合" })
        .getAttribute("aria-checked") === "true",
    ).toBe(true);
    expect(writes.filter((w) => w.path.startsWith("/me/profiles"))).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
    );
    const saved = writes.find((w) => w.path === "/me/profiles/profile")!.body;
    expect(saved.collectionId).toBe(recipe.id);
    expect(saved.sourceIds).toEqual(["Hidden"]);
    expect(saved.name).toBe("Unsaved profile");
    expect(saved.ir.groups).toEqual(profile.ir.groups);
    expect(saved.ir.rules).toEqual(profile.ir.rules);
    expect(saved.ir.defaultAction).toEqual(profile.ir.defaultAction);
    expect(saved.platformEntryIds).toEqual(["platform"]);
    expect(screen.getByText(/另有 1 个平台入口/)).toBeTruthy();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

const materializedNode = {
  id: "old-node",
  name: "Old collection node",
  origin: "imported",
  connection: { protocol: "socks", host: "synthetic.example", port: 1080 },
};
it(
  "explicitly removes a blocked collection without activating hidden direct Sources or materialized endpoints",
  async () => {
    const profile = {
      ...emptyProfile(),
      id: "profile",
      name: "Collection removal",
      collectionId: recipe.id,
      sourceIds: ["Hidden"],
      platformEntryIds: ["platform"],
    };
    profile.ir.endpoints = [materializedNode];
    profile.ir.groups = [
      {
        id: "kept",
        name: "Kept references",
        kind: "select",
        members: [{ kind: "endpoint", ref: "old-node" }],
      },
    ];
    const { writes } = mount(
      [
        accepted("Paused", { enabled: false }),
        accepted("Available"),
        accepted("Hidden"),
      ],
      profile,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "移除此集合" }),
    );
    expect(
      screen
        .getByRole("radio", { name: "使用节点集合" })
        .getAttribute("aria-checked") === "true",
    ).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "复用节点集合" }),
    );
    expect(screen.queryByText("1 个有效连接")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
    );
    const saved = writes.find((w) => w.path === "/me/profiles/profile")!.body;
    expect(saved.collectionId).toBeUndefined();
    expect(saved.sourceIds).toEqual([]);
    expect(saved.ir.endpoints).toEqual([]);
    expect(saved.platformEntryIds).toEqual(["platform"]);
    expect(screen.getByText(/另有 1 个平台入口/)).toBeTruthy();
    expect(saved.ir.groups).toEqual(profile.ir.groups);
    expect(
      writes.filter(
        (w) =>
          w.path.startsWith("/me/sources") ||
          w.path === "/me/collections/collection",
      ),
    ).toEqual([]);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it.each(["remove-action", "selection-clear", "mode-change"])(
  "clears materialized endpoints when the last direct Source is removed via %s",
  async (method) => {
    const profile = {
      ...emptyProfile(),
      id: "profile",
      name: "Direct source removal",
      sourceIds: ["Paused"],
      platformEntryIds: ["platform"],
    };
    profile.ir.endpoints = [materializedNode];
    const { writes } = mount([accepted("Paused", { enabled: false })], profile);
    await screen.findByRole("region", { name: "需要处理的来源" });
    if (method === "remove-action") {
      await userEvent.click(
        screen.getByRole("button", { name: "移除来源 Paused" }),
      );
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", { name: "使用的订阅来源" }),
      );
    } else if (method === "selection-clear") {
      await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
      await userEvent.click(
        screen.getByRole("button", { name: /^移除 Paused/ }),
      );
    } else {
      await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
      await userEvent.click(
        screen.getByRole("radio", { name: "使用节点集合" }),
      );
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "需要处理的来源" }),
      ).toBeNull(),
    );
    expect(screen.queryByText("1 个有效连接")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
    );
    const saved = writes.find((w) => w.path === "/me/profiles/profile")!.body;
    expect(saved.sourceIds).toEqual([]);
    expect(saved.collectionId).toBeUndefined();
    expect(saved.ir.endpoints).toEqual([]);
    expect(saved.platformEntryIds).toEqual(["platform"]);
    expect(screen.getByText(/另有 1 个平台入口/)).toBeTruthy();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it.each(["failed", "candidate"])(
  "keeps an enabled accepted snapshot usable despite a newer %s import, and still saves an incomplete draft",
  async (state) => {
    const source = accepted(
      "Available",
      state === "failed"
        ? { lastError: "Latest import failed", refreshStatus: "failed" }
        : {
            candidate: {
              id: "candidate",
              createdAt: "2026-10-23",
              diff: {
                beforeCount: 0,
                afterCount: 1,
                added: [],
                removed: [],
                renamed: [],
                connectionChanged: [],
              },
              affected: [],
            },
          },
    );
    const profile = {
      ...emptyProfile(),
      id: "profile",
      name: "Incomplete draft",
      sourceIds: [source.id],
    };
    profile.ir.defaultAction = { kind: "group", ref: "not-configured" };
    const { writes } = mount([source], profile);
    await screen.findByText("0 个有效连接");
    expect(screen.queryByRole("region", { name: "需要处理的来源" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
    );
    expect(
      writes.find((w) => w.path === "/me/profiles/profile")!.body.ir
        .defaultAction,
    ).toEqual(profile.ir.defaultAction);
  },
);

it("preserves deliberate manual JSON endpoints when no input reference was selected", async () => {
  const profile = {
    ...emptyProfile(),
    id: "profile",
    name: "Manual connections",
  };
  profile.ir.endpoints = [materializedNode];
  const { writes } = mount([], profile);
  await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
  await userEvent.click(screen.getByRole("radio", { name: "使用节点集合" }));
  await userEvent.click(screen.getByRole("radio", { name: "直接选择来源" }));
  expect(await screen.findByText("1 个有效连接")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
  );
  expect(
    writes.find((w) => w.path === "/me/profiles/profile")!.body.ir.endpoints,
  ).toEqual([materializedNode]);
});

it("does not diagnose a paused Source when its inventory read failed", async () => {
  const profile = {
    ...emptyProfile(),
    id: "profile",
    name: "Unknown inputs",
    sourceIds: ["Paused"],
  };
  mount([accepted("Paused", { enabled: false })], profile, true);
  await screen.findByRole("button", { name: "重新加载来源" });
  expect(screen.queryByRole("region", { name: "需要处理的来源" })).toBeNull();
  expect(screen.queryByText(/Paused · 已暂停/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" })).toBeTruthy();
});

it(
  "uses the same explicit clearing contract for the collection Select's clear control",
  async () => {
    const profile = {
      ...emptyProfile(),
      id: "profile",
      name: "Clear selected collection",
      collectionId: recipe.id,
      sourceIds: ["Hidden"],
      platformEntryIds: ["platform"],
    };
    profile.ir.endpoints = [materializedNode];
    const { writes } = mount(
      [
        accepted("Paused", { enabled: false }),
        accepted("Available"),
        accepted("Hidden"),
      ],
      profile,
    );
    await screen.findByRole("region", { name: "需要处理的来源" });
    await userEvent.click(screen.getByRole("button", { name: "编辑来源" }));
    await userEvent.click(
      screen.getByRole("combobox", { name: "复用节点集合" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "清除选择" }));
    expect(
      screen
        .getByRole("radio", { name: "使用节点集合" })
        .getAttribute("aria-checked") === "true",
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/me/profiles/profile")).toBe(true),
    );
    const saved = writes.find((w) => w.path === "/me/profiles/profile")!.body;
    expect(saved.sourceIds).toEqual([]);
    expect(saved.collectionId).toBeUndefined();
    expect(saved.ir.endpoints).toEqual([]);
    expect(saved.platformEntryIds).toEqual(["platform"]);
    expect(screen.getByText(/另有 1 个平台入口/)).toBeTruthy();
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it("labels an incomplete Source summary as awaiting verification rather than paused or accepted", async () => {
  const profile = {
    ...emptyProfile(),
    id: "profile",
    name: "Unknown Source summary",
    sourceIds: ["Unknown"],
  };
  mount(
    [{ id: "Unknown", name: "Unknown provider", kind: "text" } as Source],
    profile,
  );
  await screen.findByText("Unknown provider · 状态待核对");
  expect(screen.queryByRole("region", { name: "需要处理的来源" })).toBeNull();
});

it("returns focus to the Collection source selector after removing its unavailable source", async () => {
  const { writes } = mount([
    accepted("Paused", { enabled: false }),
    accepted("Available"),
  ]);
  await userEvent.click(
    await screen.findByRole("button", { name: /Original collection/ }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "移除来源 Paused" }),
  );
  expect(document.activeElement).toBe(
    screen.getByRole("combobox", { name: "订阅来源" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await waitFor(() =>
    expect(writes.some((w) => w.path === "/me/collections/collection")).toBe(
      true,
    ),
  );
  const saved = writes.find(
    (w) => w.path === "/me/collections/collection",
  )!.body;
  expect(saved.sources).toEqual([recipe.sources[1]]);
  expect(saved.steps).toEqual(recipe.steps);
});

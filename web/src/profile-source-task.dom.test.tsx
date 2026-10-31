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
import { ProfileEditor } from "./Profiles";
import { emptyProfile } from "./model";
import type { Profile, Source } from "./types";
const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const endpoints = [
  {
    id: "one-endpoint",
    name: "North",
    origin: "imported",
    connection: { protocol: "socks", host: "synthetic.example", port: 1080 },
  },
];
const sources: Source[] = ["one", "two"].map((id) => ({
  id,
  name: `Provider ${id}`,
  kind: "text",
  enabled: true,
  revision: `source-${id}`,
  snapshot: { endpoints },
}));
function fixture(): Profile {
  const profile = {
    ...emptyProfile(),
    id: "rich-source-profile",
    name: "Original profile",
    sourceIds: ["two", "one"],
  };
  profile.ir.name = profile.name;
  profile.ir.groups = [
    {
      id: "group-one",
      name: "Chosen group",
      kind: "select",
      members: [{ kind: "endpoint", ref: "one-endpoint" }],
      dynamic: {},
    },
  ];
  profile.ir.defaultAction = { kind: "group", ref: "group-one" };
  profile.ir.rules = [
    {
      id: "rule-one",
      match: { op: "domain-suffix", value: "example.com" },
      action: { kind: "group", ref: "group-one" },
    },
  ];
  return profile;
}
function mount(
  initial = fixture(),
  {
    holdSave = false,
    failSource = false,
    pendingImport = false,
  }: {
    holdSave?: boolean;
    failSource?: boolean;
    pendingImport?: boolean;
  } = {},
) {
  let finishSave: (() => void) | undefined;
  let savedSources = [...sources];
  const writes: { path: string; body: any }[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    if (path.startsWith("/me/collections/") && path.endsWith("/preview"))
      return json({ endpoints, stages: [] });
    if (init?.method === "POST" || init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path === "/me/sources") {
        if (failSource)
          return json(
            {
              detail: "private-source-token",
              source: {
                ...body,
                revision: "retained-r1",
                refreshStatus: "failed",
                lastError: "private-source-token",
                lastErrorCode: "source_url_not_allowed",
              },
            },
            422,
          );
        const saved = {
          ...body,
          revision: pendingImport ? "review-r1" : "ready-r1",
          refreshStatus: pendingImport ? "review-required" : "accepted",
          ...(pendingImport
            ? {}
            : {
                snapshot: { endpoints },
                diagnostics: [{ code: "connection-extraction" }],
              }),
          candidate: pendingImport
            ? {
                id: "new-candidate",
                createdAt: "2026-10-23",
                diff: {
                  beforeCount: 0,
                  afterCount: 1,
                  added: [{ id: "imported-endpoint", name: "London" }],
                  removed: [],
                  renamed: [],
                  connectionChanged: [],
                },
                diagnostics: [{ code: "connection-extraction" }],
                affected: [],
              }
            : undefined,
        };
        savedSources.push(saved);
        return json(saved);
      }
      if (path.endsWith("/apply") || path.endsWith("/candidate/reject")) {
        const prior = savedSources[savedSources.length - 1];
        const saved = {
          ...prior,
          candidate: undefined,
          revision: "decided-r2",
          refreshStatus: path.endsWith("/apply") ? "accepted" : "rejected",
          ...(path.endsWith("/apply")
            ? {
                snapshot: { endpoints },
                diagnostics: prior.candidate?.diagnostics,
              }
            : {}),
        };
        savedSources[savedSources.length - 1] = saved;
        return json(saved);
      }
      if (holdSave && path.includes("/me/profiles/"))
        return new Promise<Response>((resolve) => {
          finishSave = () => resolve(json(body));
        });
      return json(body);
    }
    return json(
      path === "/me/sources"
        ? savedSources
        : path === "/me/collections"
          ? [
              {
                id: "retained-collection",
                name: "Retained collection",
                sources: [{ sourceId: "one", steps: [] }],
                steps: [],
              },
            ]
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
        <ProfileEditor initial={initial} isNew={false} onClose={() => {}} />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { writes, finishSave: () => finishSave?.() };
}
async function importSource() {
  const disclosure = screen.queryByRole("button", { name: "编辑来源" });
  if (disclosure) await userEvent.click(disclosure);
  fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
  const editor = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  fireEvent.change(editor.getByLabelText("来源名称"), {
    target: { value: "Full client source" },
  });
  fireEvent.change(editor.getByLabelText("节点链接或配置内容"), {
    target: { value: '{"outbounds":[],"route":{}}' },
  });
  fireEvent.click(editor.getByRole("button", { name: /导入来源|添加来源/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
  // JSDOM has no layout; give the nested-dialog focus trap visible elements.
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
  "keeps a rich Profile draft through a ready first import without a review or parent save until asked",
  async () => {
    const profile = fixture();
    const { writes } = mount(profile);
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "Unsaved profile" },
    });
    await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
    fireEvent.change(screen.getByLabelText("策略组名称"), {
      target: { value: "Unsaved group" },
    });
    await importSource();
    expect(writes.map(({ path }) => path)).toEqual(["/me/sources"]);
    expect(writes[0].body.applyMode).toBe("auto");
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "应用更新" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "添加来源" }),
      ),
    );
    expect((screen.getByLabelText("配置名称") as HTMLInputElement).value).toBe(
      "Unsaved profile",
    );
    expect(
      (screen.getByLabelText("策略组名称") as HTMLInputElement).value,
    ).toBe("Unsaved group");
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].path).toBe(`/me/profiles/${profile.id}`);
    expect(writes[1].body).toMatchObject({
      name: "Unsaved profile",
      sourceIds: ["two", "one", writes[0].body.id],
      ir: {
        defaultAction: profile.ir.defaultAction,
        rules: profile.ir.rules,
        groups: [{ ...profile.ir.groups[0], name: "Unsaved group" }],
      },
    });
    expect(writes.some(({ path }) => path.includes("/outputs"))).toBe(false);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it(
  "keeps collection input and rich Profile edits when an import is deferred, resumed and declined",
  async () => {
    const profile = { ...fixture(), collectionId: "retained-collection" };
    const { writes } = mount(profile, { pendingImport: true });
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "Keep collection draft" },
    });
    await userEvent.click(screen.getByRole("tab", { name: "策略组" }));
    fireEvent.change(screen.getByLabelText("策略组名称"), {
      target: { value: "Keep group draft" },
    });
    await importSource();
    await screen.findByText("来源已保存，尚未加入此草稿");
    expect(screen.queryByRole("dialog", { name: "查看导入变化" })).toBeNull();
    expect(screen.getByLabelText("复用节点集合")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "添加来源" }),
    );
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "查看变化" }));
    let review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    await userEvent.click(review.getByRole("button", { name: "稍后处理" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes).toHaveLength(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "查看变化" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "查看变化" }));
    review = within(
      await screen.findByRole("dialog", { name: "查看导入变化" }),
    );
    await userEvent.click(review.getByRole("button", { name: "忽略本次更新" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("复用节点集合")).toBeTruthy();
    expect((screen.getByLabelText("配置名称") as HTMLInputElement).value).toBe(
      "Keep collection draft",
    );
    expect(
      (screen.getByLabelText("策略组名称") as HTMLInputElement).value,
    ).toBe("Keep group draft");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      path: `/me/sources/${writes[0].body.id}/candidate/reject`,
      body: { candidateId: "new-candidate", sourceRevision: "review-r1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2].body).toMatchObject({
      collectionId: "retained-collection",
      sourceIds: ["two", "one"],
      ir: {
        defaultAction: profile.ir.defaultAction,
        rules: profile.ir.rules,
        groups: [{ ...profile.ir.groups[0], name: "Keep group draft" }],
      },
    });
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

it("names the publishing check without decorative loading text before, during and after saving", async () => {
  const { writes, finishSave } = mount(fixture(), { holdSave: true });
  expect(
    screen.getByRole("button", { name: "检查发布" }).getAttribute("aria-busy"),
  ).not.toBe("true");
  fireEvent.change(screen.getByLabelText("配置名称"), {
    target: { value: "New saved name" },
  });
  expect(screen.getByRole("button", { name: "保存并检查" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(
    screen
      .getByRole("button", { name: "保存并检查" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  await act(async () => finishSave());
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "检查发布" })
        .getAttribute("aria-busy"),
    ).not.toBe("true"),
  );
});

it(
  "keeps typed URL failure private while returning to the unsaved Profile",
  async () => {
    const { writes } = mount(fixture(), { failSource: true });
    fireEvent.change(screen.getByLabelText("配置名称"), {
      target: { value: "Unsaved URL profile" },
    });
    const disclosure = screen.queryByRole("button", { name: "编辑来源" });
    if (disclosure) await userEvent.click(disclosure);
    await userEvent.click(screen.getByRole("button", { name: "添加来源" }));
    const editor = within(
      await screen.findByRole("dialog", { name: "添加订阅来源" }),
    );
    fireEvent.change(editor.getByLabelText("来源名称"), {
      target: { value: "URL fixture" },
    });
    await userEvent.click(editor.getByRole("radio", { name: "订阅 URL" }));
    fireEvent.change(editor.getByLabelText("订阅地址"), {
      target: { value: "https://localhost/synthetic" },
    });
    await userEvent.click(editor.getByRole("button", { name: "导入来源" }));
    await editor.findByText("输入已保存，导入未完成");
    await userEvent.click(editor.getByRole("button", { name: /^取\s*消$/ }));
    await screen.findByText("来源已保存，尚未加入此草稿");
    expect(
      screen.getByText(
        "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("private-source-token")).toBeNull();
    expect((screen.getByLabelText("配置名称") as HTMLInputElement).value).toBe(
      "Unsaved URL profile",
    );
    expect(writes).toHaveLength(1);
  },
  SOURCE_IMPORT_JOURNEY_TIMEOUT_MS,
);

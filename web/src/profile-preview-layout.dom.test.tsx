// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ProfileEditor } from "./Profiles";
import type { Output } from "./types";
import { CollectionsPage } from "./Sources";
import { emptyProfile } from "./model";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "keeps requested preview (valid=%s) separate and preserves edits when closed",
  async (valid) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("/preview")
                ? {
                    valid,
                    content: "preview result",
                    diagnostics: valid ? [] : ["fix this draft"],
                  }
                : [],
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const profile = emptyProfile();
    profile.name = "Draft";
    mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
    expect(screen.queryByText("草稿配置预览")).toBeNull();
    const name = screen.getByRole("textbox", { name: "配置名称" });
    fireEvent.change(name, { target: { value: "Changed draft" } });
    await userEvent.click(screen.getByRole("tab", { name: "检查与预览" }));
    await userEvent.click(screen.getByRole("button", { name: "预览配置" }));
    await screen.findByRole("dialog", { name: "草稿配置预览" });
    expect(await screen.findByText("preview result")).toBeTruthy();
    if (!valid) expect(screen.getByText("fix this draft")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect((name as HTMLInputElement).value).toBe("Changed draft");
    expect(screen.queryByRole("dialog", { name: "草稿配置预览" })).toBeNull();
  },
);

it.each(["failure", "success"])(
  "ignores a stale preview %s after editing the same draft",
  async (outcome) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.method === "POST" || init?.method === "PUT") {
          requests.push({ url: String(url), body: JSON.parse(init.body) });
          return pending;
        }
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const profile = emptyProfile();
    profile.name = "Original draft";
    mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
    await userEvent.click(screen.getByRole("tab", { name: "检查与预览" }));
    await userEvent.click(screen.getByRole("button", { name: "预览配置" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const name = screen.getByRole("textbox", { name: "配置名称" });
    fireEvent.change(name, { target: { value: "Newer draft" } });
    await userEvent.click(
      screen.getByRole("combobox", { name: "草稿检查与新订阅默认客户端" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "sing-box" }));
    finish(
      new Response(
        JSON.stringify(
          outcome === "failure"
            ? { detail: "Old draft preview rejected" }
            : {
                valid: true,
                content: "Old draft preview result",
                diagnostics: [],
              },
        ),
        {
          status: outcome === "failure" ? 422 : 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "预览配置" })
          .getAttribute("aria-busy"),
      ).not.toBe("true"),
    );
    expect(screen.queryByText("Old draft preview rejected")).toBeNull();
    expect(screen.queryByText("Old draft preview result")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "草稿配置预览" })).toBeNull();
    expect((name as HTMLInputElement).value).toBe("Newer draft");
    expect(
      screen
        .getByRole("combobox", { name: "草稿检查与新订阅默认客户端" })
        .closest('[role="combobox"]')?.textContent,
    ).toContain("sing-box");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/me/profiles/preview");
    expect(requests[0].body.name).toBe("Original draft");
    expect(requests[0].body.target.adapterId).toBe("mihomo");
  },
);

it("shows a current preview failure and retries without saving or publishing", async () => {
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST" || init?.method === "PUT") {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify(
            requests.length === 1
              ? { detail: "Current draft preview rejected" }
              : {
                  valid: true,
                  content: "Retried draft preview",
                  diagnostics: [],
                },
          ),
          {
            status: requests.length === 1 ? 422 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("[]", {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const profile = emptyProfile();
  profile.name = "Retry draft";
  mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Edited retry draft" },
  });
  await userEvent.click(screen.getByRole("tab", { name: "检查与预览" }));
  await userEvent.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("Current draft preview rejected");
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Edited retry draft");
  await userEvent.click(screen.getByRole("button", { name: "预览配置" }));
  await screen.findByText("Retried draft preview");
  expect(screen.queryByText("Current draft preview rejected")).toBeNull();
  expect(requests.map((request) => request.url)).toEqual([
    "/api/me/profiles/preview",
    "/api/me/profiles/preview",
  ]);
  expect(requests.map((request) => request.body.name)).toEqual([
    "Edited retry draft",
    "Edited retry draft",
  ]);
});

it("associates each editor tab with its actual controls", async (context) => {
  const owner = ownedClickScenario(context);
  let phase = "entry";
  let firstAbortPhase: string | undefined;
  const captureAbortPhase = () => {
    firstAbortPhase ??= phase;
  };
  context.signal.addEventListener("abort", captureAbortPhase, { once: true });
  if (context.signal.aborted) captureAbortPhase();
  context.onTestFinished(() => {
    context.signal.removeEventListener("abort", captureAbortPhase);
  });
  context.onTestFailed(() => {
    console.error("[profile-tab-controls failure]", {
      phase: firstAbortPhase ?? phase,
      capturedAt:
        firstAbortPhase === undefined ? "failure-hook" : "native-abort",
    });
  });
  owner.assertActive();
  phase = "fetch-fixture";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("[]", {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  owner.assertActive();
  phase = "mount";
  mount(<ProfileEditor initial={emptyProfile()} isNew onClose={() => {}} />);
  phase = "user-setup";
  const user = userEvent.setup();
  phase = "connection-region-query";
  const intent = screen.getByRole("region", { name: "连接与流量" });
  phase = "source-control-assertion";
  expect(
    within(intent).getByRole("combobox", { name: "使用的订阅来源" }),
  ).toBeTruthy();
  phase = "no-input-tab-assertion";
  expect(screen.queryByRole("tab", { name: "输入来源" })).toBeNull();
  for (const [tab, role, name] of [
    ["策略组", "button", "添加策略组"],
    ["分流规则", "button", "添加规则"],
    ["运行设置", "heading", "客户端运行设置"],
    ["检查与预览", "heading", "检查配置草稿"],
  ]) {
    owner.assertActive();
    phase = `${tab}:tab-query-and-click`;
    await user.click(screen.getByRole("tab", { name: tab }));
    owner.assertActive();
    phase = `${tab}:panel-query`;
    const panel = screen.getByRole("tabpanel", { name: tab });
    phase = `${tab}:control-assertion`;
    expect(within(panel).getByRole(role, { name })).toBeTruthy();
    phase = `${tab}:single-panel-assertion`;
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  }
  phase = "body-complete";
});

it("keeps a newly saved draft open and updates the same identity on subsequent saves", async (context) => {
  const owner = ownedClickScenario(context);
  let phase = "entry";
  let firstAbortPhase: string | undefined;
  const captureAbortPhase = () => {
    firstAbortPhase ??= phase;
  };
  context.signal.addEventListener("abort", captureAbortPhase, { once: true });
  if (context.signal.aborted) captureAbortPhase();
  context.onTestFinished(() => {
    context.signal.removeEventListener("abort", captureAbortPhase);
  });
  context.onTestFailed(() => {
    console.error("[profile-saved-draft failure]", {
      phase: firstAbortPhase ?? phase,
      capturedAt:
        firstAbortPhase === undefined ? "failure-hook" : "native-abort",
    });
  });
  owner.assertActive();
  phase = "fetch-fixture";
  const writes: {
    method: string;
    body: { id: string; ir: { nativeOverride?: { content: string } } };
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "POST" || init?.method === "PUT") {
        const body = JSON.parse(init.body);
        writes.push({ method: init.method, body });
        return new Response(
          JSON.stringify({
            ...body,
            ir: {
              ...body.ir,
              nativeOverride: { ...body.ir.nativeOverride, content: "" },
            },
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response("[]", {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  phase = "draft-fixture";
  const profile = emptyProfile();
  profile.name = "Continuing draft";
  profile.ir.nativeOverride = {
    schemaVersion: "1",
    namespace: "routeweaver/native-client",
    target: profile.target,
    format: "json",
    ruleMode: "prepend",
    content: '{"dns":{"nameserver":["https://private.test/query"]}}',
  };
  const close = vi.fn();
  owner.assertActive();
  phase = "mount";
  mount(<ProfileEditor initial={profile} isNew onClose={close} />);
  owner.assertActive();
  phase = "first-save:query-and-click";
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  owner.assertActive();
  phase = "first-save:click-returned/waiting-for-one-write";
  await waitFor(() => expect(writes).toHaveLength(1));
  owner.assertActive();
  phase = "first-save:write-wait-returned/checking-state";
  expect(screen.getByRole("status").textContent).toContain("草稿已保存");
  expect(close).not.toHaveBeenCalled();
  phase = "name:query-and-type";
  await userEvent.type(
    screen.getByRole("textbox", { name: "配置名称" }),
    " revised",
  );
  owner.assertActive();
  phase = "name:type-returned/second-save-query-and-click";
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  owner.assertActive();
  phase = "second-save:click-returned/waiting-for-two-writes";
  await waitFor(() => expect(writes).toHaveLength(2));
  owner.assertActive();
  phase =
    "second-save:write-wait-returned/checking-saved-identity-and-native-override";
  expect(writes.map((write) => write.method)).toEqual(["POST", "PUT"]);
  expect(writes.map((write) => write.body.id)).toEqual([
    profile.id,
    profile.id,
  ]);
  expect(writes[1].body.ir.nativeOverride?.content).toBe(
    profile.ir.nativeOverride.content,
  );
  phase = "body-complete";
});

it("preserves source choices across explicit collection switches and submits only the active input", async () => {
  const writes: Record<string, unknown>[] = [];
  const inputPreviews: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      let value: unknown = [];
      if (
        String(url) === "/api/me/collections/preview" &&
        init?.method === "POST"
      ) {
        inputPreviews.push(JSON.parse(init.body));
        value = { endpoints: [], stages: [] };
      } else if (init?.method === "POST" || init?.method === "PUT") {
        value = JSON.parse(init.body);
        writes.push(value as Record<string, unknown>);
      } else if (String(url).endsWith("/sources"))
        value = [
          {
            id: "source-a",
            name: "Source A",
            kind: "url",
            enabled: true,
            snapshot: { endpoints: [] },
          },
        ];
      else if (String(url).endsWith("/collections"))
        value = [
          { id: "collection-a", name: "Collection A", sources: [], steps: [] },
        ];
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const profile = emptyProfile();
  profile.name = "Input choice";
  profile.sourceIds = ["source-a"];
  mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
  const sourceField = screen
    .getByRole("combobox", { name: "使用的订阅来源" })
    .closest("label")!;
  await within(sourceField).findByText("Source A", { exact: true });
  await userEvent.click(screen.getByRole("radio", { name: "使用节点集合" }));
  expect(screen.queryByText("Source A")).toBeNull();
  await userEvent.click(screen.getByRole("radio", { name: "直接选择来源" }));
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" })).toBeTruthy();
  const restoredSourceField = screen
    .getByRole("combobox", { name: "使用的订阅来源" })
    .closest("label")!;
  expect(
    within(restoredSourceField).getByText("Source A", { exact: true }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(inputPreviews.length).toBeGreaterThan(0);
  expect(
    inputPreviews.every(
      (request) =>
        JSON.stringify(request.sources) ===
          JSON.stringify([{ sourceId: "source-a", steps: [] }]) &&
        Array.isArray(request.steps) &&
        request.steps.length === 0,
    ),
  ).toBe(true);
  expect(writes[0].sourceIds).toEqual(["source-a"]);
  expect(writes[0].collectionId).toBeUndefined();
});

it("continues an existing subscription through its output-scoped update preview", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST")
        requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify(
          init?.method === "POST"
            ? {
                valid: false,
                diagnostics: ["Review fixture"],
                ...(JSON.parse(init.body).outputId
                  ? {
                      outputId: JSON.parse(init.body).outputId,
                      previewScope: "output-update",
                      previewDigest: "a".repeat(64),
                    }
                  : {}),
              }
            : String(url) === "/api/me/outputs"
              ? [output]
              : [],
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const profile = emptyProfile();
  profile.name = "Daily routing";
  const output = {
    id: "existing-output",
    name: "Daily",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  } as Output;
  mount(
    <ProfileEditor
      initial={profile}
      isNew={false}
      output={output}
      onClose={() => {}}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "检查所选订阅" }),
  );
  await screen.findByText("Review fixture");
  expect(requests).toEqual([
    {
      url: `/api/me/profiles/${profile.id}/preview`,
      body: {
        outputId: "existing-output",
        target: profile.target,
        mode: "full",
      },
    },
  ]);
});

it("reorders collection sources without losing source processing steps", async () => {
  const sources = [
    {
      sourceId: "a",
      steps: [
        { id: "step-a", kind: "sort", enabled: true, sort: { by: "name" } },
      ],
    },
    { sourceId: "b", steps: [] },
  ];
  let saved: { sources: unknown[] } | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      let value: unknown = String(url).endsWith("/collections")
        ? [{ id: "collection", name: "Daily nodes", sources, steps: [] }]
        : [
            {
              id: "a",
              name: "Alpha",
              kind: "url",
              enabled: true,
              snapshot: { endpoints: [] },
            },
            {
              id: "b",
              name: "Beta",
              kind: "url",
              enabled: true,
              snapshot: { endpoints: [] },
            },
          ];
      if (init?.method === "PUT") value = saved = JSON.parse(init.body);
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  mount(<CollectionsPage />);
  await userEvent.click(await screen.findByText("Daily nodes"));
  await userEvent.click(screen.getByRole("button", { name: "下移来源 1" }));
  expect(screen.getByText("1. Beta")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "保存集合" }));
  await screen.findByText("集合已保存");
  expect(saved?.sources).toEqual([sources[1], sources[0]]);
});

it("binds the newly published subscription to the open editor instead of creating another output", async () => {
  const writes: { url: string; body: any }[] = [];
  const published: Output[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (init?.method === "POST") writes.push({ url: path, body });
      let value: unknown = [];
      if (path.endsWith("/outputs/preview"))
        value = {
          valid: true,
          previewDigest: "creation",
          previewScope: "new-output",
          outputId: body.id,
          artifacts: [{ path: "config", content: "creation checked" }],
        };
      else if (path === "/api/me/outputs" && init?.method === "POST") {
        const result = {
          ...body,
          status: "published",
          creationReviewDigest: body.previewDigest,
        };
        published.push(result);
        value = result;
      } else if (path === "/api/me/outputs" && !init?.method) value = published;
      else if (path.endsWith("/access"))
        value = { delivery: "bundle", downloadPath: "/download/bundle.zip" };
      else if (path.endsWith("/preview"))
        value = {
          valid: false,
          diagnostics: ["Existing output reviewed"],
          ...(body.outputId
            ? {
                outputId: body.outputId,
                previewScope: "output-update",
                previewDigest: "a".repeat(64),
              }
            : {}),
        };
      else if (init?.method === "PUT") value = body;
      return new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  const profile = emptyProfile();
  profile.name = "New subscription";
  mount(<ProfileEditor initial={profile} isNew={false} onClose={() => {}} />);
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(screen.queryByRole("dialog", { name: "选择客户端订阅" })).toBeNull();
  expect(writes).toHaveLength(0);
  await waitFor(() =>
    expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
      "New subscription",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "技术配置（可选查看）" }),
  );
  await screen.findByText("creation checked");
  await userEvent.click(
    screen.getByRole("button", { name: "创建并发布「New subscription」" }),
  );
  const access = await screen.findByRole("dialog", {
    name: "获取「New subscription」",
  });
  await userEvent.click(within(access).getByRole("button", { name: "关闭" }));
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "Revised subscription" },
  });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await userEvent.click(
    await screen.findByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "检查所选订阅" }),
  );
  await screen.findByText("Existing output reviewed");
  const creation = writes.filter((write) => write.url.endsWith("/outputs"));
  expect(creation).toHaveLength(1);
  expect(writes[writes.length - 1]?.body.outputId).toBe(creation[0].body.id);
});

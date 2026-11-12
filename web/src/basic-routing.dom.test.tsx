// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
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
  focusManager,
} from "@tanstack/react-query";
import { BasicRouting } from "./BasicRouting";
import { emptyProfile } from "./model";
import { basicProfile } from "./basic-routing-model";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount(props: Partial<React.ComponentProps<typeof BasicRouting>> = {}) {
  const published = vi.fn();
  const advanced = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <UIProviders>
        <BasicRouting
          onClose={vi.fn()}
          onPublished={published}
          onAdvanced={advanced}
          onSources={vi.fn()}
          {...props}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  return { published, advanced };
}
let requests: { path: string; method: string; body: any }[];
let previewFails = false;
beforeEach(() => {
  requests = [];
  previewFails = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET",
        body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (path.endsWith("/platform-entries"))
        return json([
          {
            id: "entry",
            name: "FRA → UK",
            routeId: "route",
            credentialVersion: "1",
            status: "configured-unverified",
          },
        ]);
      if (path.endsWith("/sources"))
        return json([
          {
            id: "airport",
            name: "My airport",
            kind: "text",
            enabled: true,
            snapshot: {
              endpoints: [
                {
                  id: "tokyo",
                  name: "Tokyo",
                  origin: "imported",
                  connection: {
                    protocol: "socks",
                    host: "fixture.test",
                    port: 1080,
                  },
                },
              ],
            },
          },
        ]);
      if (path.endsWith("/overview"))
        return json({
          routes: [{ id: "route", name: "FRA → UK", rateMicros: 2000000 }],
        });
      if (path.endsWith("/preview"))
        return previewFails
          ? json({ detail: "所选入口已停用，请重新选择。" }, 422)
          : json({
              valid: true,
              routingSummary: {
                version: 1,
                kind: "basic",
                chatGPT: { endpointId: "entry", label: "FRA → UK · 2×" },
                default: { endpointId: "tokyo", label: "My airport · Tokyo" },
              },
              artifacts: [{ path: "config.json", content: '{"proxies":[]}' }],
              previewDigest: "reviewed-digest",
              previewScope:
                path === "/api/me/outputs/preview"
                  ? "new-output"
                  : "output-update",
              outputId: body.id || body.outputId,
            });
      if (path.endsWith("/outputs"))
        return json({
          id: body.id,
          name: body.name,
          profileId: body.profileId,
          status: "published",
          target: body.target,
          mode: body.mode,
        });
      return json(body || {});
    }),
  );
});
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function select(label: string, choice: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: choice }));
}
it("sets ChatGPT to an actual entitled route and other traffic to an owned endpoint, reviews before explicit publication", async () => {
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  const review = await screen.findByRole("region", { name: "发布前确认" });
  await waitFor(() => expect(document.activeElement).toBe(within(review).getByRole("heading", { name: "发布前确认" })));
  expect(within(review).getByText("FRA → UK · 2×")).toBeTruthy();
  expect(within(review).getByText("My airport · Tokyo")).toBeTruthy();
  const saved = requests.find(
    (r) => r.method === "POST" && r.path.endsWith("/profiles"),
  )!.body;
  expect(saved.platformEntryIds).toEqual(["entry"]);
  expect(saved.sourceIds).toEqual(["airport"]);
  expect(saved.ir.defaultAction).toEqual({
    kind: "group",
    ref: "basic_default",
  });
  expect(requests.some((r) => r.path.endsWith("/outputs"))).toBe(false);
  await userEvent.click(within(review).getByRole("button", { name: "继续调整" }));
  const inspect = screen.getByRole("button", { name: "保存并查看修改" });
  expect(document.activeElement).toBe(inspect);
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  const normalFetch = fetch;
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const response = await normalFetch(url, init);
    if (String(url).endsWith("/preview")) await previewGate;
    return response;
  }));
  const back = screen.getByRole("button", { name: "返回" });
  try {
    await userEvent.click(inspect);
    await waitFor(() => expect(requests.filter((r) => r.path.endsWith("/preview"))).toHaveLength(2));
    await userEvent.click(inspect);
    expect(requests.filter((r) => r.path.endsWith("/preview"))).toHaveLength(2);
    // A deliberate move elsewhere while the response is pending owns focus.
    await userEvent.click(back);
  } finally {
    await act(async () => releasePreview());
  }
  const returnedReview = await screen.findByRole("region", { name: "发布前确认" });
  expect(document.activeElement).toBe(back);
  await userEvent.click(
    within(returnedReview).getByRole("button", { name: "发布并获取订阅" }),
  );
  await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
  const creation = requests.find((r) => r.path.endsWith("/outputs"))!.body;
  expect(requests.find((r) => r.path.endsWith("/preview"))).toEqual({
    path: "/api/me/outputs/preview",
    method: "POST",
    body: {
      id: creation.id,
      name: "日常订阅",
      profileId: saved.id,
      target: { adapterId: "mihomo", version: "1.19.32" },
      mode: "full",
    },
  });
  expect(creation).toEqual({
    ...requests.find((r) => r.path.endsWith("/preview"))!.body,
    previewDigest: "reviewed-digest",
  });
  expect(requests.filter((r) => r.path.endsWith("/outputs"))).toHaveLength(1);
});
it("keeps selected values after a failed preview and never publishes or shows an invented review", async () => {
  previewFails = true;
  mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByText("所选入口已停用，请重新选择。");
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "其他流量使用的线路" }).textContent).toContain("Tokyo 来源 My airport");
  expect(requests.some((r) => r.path.endsWith("/outputs"))).toBe(false);
});
it("hands arbitrary advanced profiles to the full editor without rebuilding them", async () => {
  const profile = emptyProfile();
  profile.name = "Existing advanced";
  profile.ir.rules = [
    {
      id: "work",
      match: { op: "domain-suffix", value: "work.example" },
      action: { kind: "reject" },
    },
  ];
  const { advanced } = mount({ initial: profile });
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑完整配置" }),
  );
  expect(advanced).toHaveBeenCalledWith(profile, false, false);
  expect(requests.some((r) => r.method !== "GET")).toBe(false);
});

it("does not require a private airport when a platform route is available", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url).endsWith("/sources")
        ? Promise.resolve(json([]))
        : original(url, init),
    ),
  );
  mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "FRA → UK 额度倍率 2×");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  expect(
    requests.find((r) => r.method === "POST" && r.path.endsWith("/profiles"))!
      .body.sourceIds,
  ).toEqual([]);
});
it("allows a private-airport-only draft without platform entitlement", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      String(url).endsWith("/platform-entries")
        ? Promise.resolve(json([]))
        : original(url, init),
    ),
  );
  mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "Tokyo 来源 My airport");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  expect(
    requests.find((r) => r.method === "POST" && r.path.endsWith("/profiles"))!
      .body.platformEntryIds,
  ).toEqual([]);
});
it("invalidates a review after selection changes and retains edits when closing is canceled", async () => {
  mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await select("ChatGPT 使用的线路", "Tokyo 来源 My airport");
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findAllByText("放弃尚未保存的分流修改？");
  await userEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(
    screen
      .getByRole("combobox", { name: "ChatGPT 使用的线路" })
      .closest('[role="combobox"]')?.textContent,
  ).toContain("Tokyo 来源 My airport");
  expect(requests.some((r) => r.path.endsWith("/outputs"))).toBe(false);
});
it("keeps an unavailable saved choice visible instead of substituting another route", async () => {
  const profile = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "retired",
      defaultEndpointId: "tokyo",
    },
    [
      {
        id: "retired",
        label: "Old route",
        section: "平台线路",
        platformEntryId: "retired",
      },
      { id: "tokyo", label: "Tokyo", section: "我的机场", sourceId: "airport" },
    ],
  );
  mount({ initial: profile });
  await screen.findByText(
    "原选线路当前不可选。已保留原选择，请明确替换后再保存。",
  );
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByText("原选线路当前不可用，请明确选择替代线路后再保存。");
  expect(requests.some((r) => r.method !== "GET")).toBe(false);
});
it("fences an existing subscription update with its preview digest and keeps edits after conflict", async () => {
  const profile = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "entry",
      defaultEndpointId: "tokyo",
    },
    [
      {
        id: "entry",
        label: "UK",
        section: "平台线路",
        platformEntryId: "entry",
      },
      { id: "tokyo", label: "Tokyo", section: "我的机场", sourceId: "airport" },
    ],
  );
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      if (String(url).endsWith("/publish")) {
        requests.push({
          path: String(url),
          method: init?.method || "GET",
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(
          json({ detail: "配置已变化，请重新预览。" }, 409),
        );
      }
      return original(url, init);
    }),
  );
  mount({
    initial: profile,
    output: {
      id: "current",
      name: "Daily",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    },
  });
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  expect(requests.find((r) => r.path.endsWith("/preview"))!.body.outputId).toBe(
    "current",
  );
  await userEvent.click(screen.getByRole("button", { name: "发布修改" }));
  await screen.findByText("配置已变化，请重新预览。");
  expect(requests.find((r) => r.path.endsWith("/publish"))!.body).toEqual({
    previewDigest: "reviewed-digest",
  });
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  expect(
    screen
      .getByRole("combobox", { name: "其他流量使用的线路" })
      .closest('[role="combobox"]')?.textContent,
  ).toContain("Tokyo 来源 My airport");
});
it("keeps an existing output with a different pinned target in the full editor", async () => {
  const profile = basicProfile(
    emptyProfile(),
    {
      name: "Pinned daily",
      adapterId: "mihomo",
      chatEndpointId: "entry",
      defaultEndpointId: "tokyo",
    },
    [
      {
        id: "entry",
        label: "UK",
        section: "平台线路",
        platformEntryId: "entry",
      },
      { id: "tokyo", label: "Tokyo", section: "我的机场", sourceId: "airport" },
    ],
  );
  const { advanced } = mount({
    initial: profile,
    output: {
      id: "pinned",
      name: "Pinned daily",
      profileId: profile.id,
      target: { adapterId: "mihomo", version: "1.18.0" },
      mode: "full",
      status: "published",
    },
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑完整配置" }),
  );
  expect(advanced).toHaveBeenCalledWith(profile, false, false);
  expect(requests.some((r) => r.method !== "GET")).toBe(false);
});
it("reconciles a lost creation response using the authoritative output without creating a duplicate", async () => {
  const original = fetch;
  let created: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/outputs")) {
        const method = init?.method || "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: String(url), method, body });
        if (method === "POST") {
          created = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
            feedPath: "/feed/authorized-result",
          };
          throw new TypeError("Lost response");
        }
        return json([created]);
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await waitFor(() => expect(published).toHaveBeenCalledWith(created));
  expect(
    requests.filter((r) => r.path.endsWith("/outputs") && r.method === "POST"),
  ).toHaveLength(1);
});

it("retains basic creation choices after a stale review and reviews the same identity before retrying", async () => {
  const original = fetch;
  let previews = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET",
        body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview") {
        requests.push({ path, method, body });
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `creation-${++previews}`,
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      }
      if (path === "/api/me/outputs") {
        requests.push({ path, method, body });
        return method === "POST"
          ? json({ detail: "配置已变化，请重新预览。" }, 409)
          : json([]);
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByText("配置已变化，请重新预览。");
  expect(published).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "日常订阅",
  );
  expect(
    screen
      .getByRole("combobox", { name: "ChatGPT 使用的线路" })
      .closest('[role="combobox"]')?.textContent,
  ).toContain("FRA → UK 额度倍率 2×");
  expect(
    screen
      .getByRole("combobox", { name: "其他流量使用的线路" })
      .closest('[role="combobox"]')?.textContent,
  ).toContain("Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  const reviews = requests.filter(
    (request) => request.path === "/api/me/outputs/preview",
  );
  expect(reviews[1].body).toEqual(reviews[0].body);
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      ),
    ).toHaveLength(2),
  );
  expect(
    requests
      .filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      )
      .map((request) => request.body.previewDigest),
  ).toEqual(["creation-1", "creation-2"]);
});

it.each([
  ["missing receipt", { creationReviewDigest: undefined }],
  ["different review receipt", { creationReviewDigest: "unrelated-review" }],
  ["different output", { id: "unrelated-output" }],
  ["different profile", { profileId: "unrelated-profile" }],
  ["unpublished output", { status: "revoked" }],
])(
  "does not accept a lost basic creation response with %s",
  async (_case, mismatch) => {
    const original = fetch;
    let existing: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url) === "/api/me/outputs") {
          const method = init?.method || "GET",
            body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ path: String(url), method, body });
          if (method === "POST") {
            existing = {
              ...body,
              status: "published",
              creationReviewDigest: body.previewDigest,
              ...mismatch,
            };
            throw new TypeError("Lost response");
          }
          return json([existing]);
        }
        return original(url, init);
      }),
    );
    const { published } = mount();
    await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
    await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
    await select("其他流量使用的线路", "Tokyo 来源 My airport");
    await userEvent.click(
      screen.getByRole("button", { name: "保存并查看修改" }),
    );
    await screen.findByRole("region", { name: "发布前确认" });
    await userEvent.click(
      screen.getByRole("button", { name: "发布并获取订阅" }),
    );
    await screen.findByText("无法连接服务。请检查网络后重试，当前输入已保留。");
    expect(published).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "发布前确认" })).toBeTruthy();
    expect(
      screen
        .getByRole("combobox", { name: "其他流量使用的线路" })
        .closest('[role="combobox"]')?.textContent,
    ).toContain("Tokyo 来源 My airport");
    expect(
      requests.filter(
        (request) =>
          request.path === "/api/me/outputs" && request.method === "POST",
      ),
    ).toHaveLength(1);
  },
);

it("keeps a basic creation review retryable after its response and first lookup are unavailable", async () => {
  const original = fetch;
  let existing: any;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        const method = init?.method || "GET",
          body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: String(url), method, body });
        if (method === "POST") {
          if (existing) return json({ detail: "Output already exists" }, 409);
          existing = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          };
          throw new TypeError("Lost creation response");
        }
        if (++reads === 1) throw new TypeError("Lookup unavailable");
        return json([existing]);
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByRole("alert");
  expect(published).not.toHaveBeenCalled();
  const retry = screen.getByRole("button", { name: "发布并获取订阅" });
  expect((retry as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(retry);
  await waitFor(() => expect(published).toHaveBeenCalledWith(existing));
  const attempts = requests.filter(
    (request) =>
      request.path === "/api/me/outputs" && request.method === "POST",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual(attempts[0].body);
  expect(
    requests.filter((request) => request.path === "/api/me/outputs/preview"),
  ).toHaveLength(1);
});

it("keeps a definite basic stale-review rejection distinct from an unavailable output lookup", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url) === "/api/me/outputs") {
        if (init?.method === "POST")
          return json({ detail: "Review is stale; preview again" }, 409);
        throw new TypeError("Lookup unavailable");
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Review is stale; preview again");
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  expect(published).not.toHaveBeenCalled();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "日常订阅",
  );
});

it("preserves reconciliation after source data changes during an unresolved accepted creation", async () => {
  const original = fetch;
  let existing: any;
  let reads = 0;
  let changed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/me/outputs") {
        const method = init?.method || "GET",
          body = init?.body ? JSON.parse(String(init.body)) : null;
        if (method === "POST") {
          if (existing) return json({ detail: "Output already exists" }, 409);
          existing = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          };
          throw new TypeError("Lost creation response");
        }
        if (++reads === 1) throw new TypeError("Lookup unavailable");
        return json([existing]);
      }
      if (path === "/api/me/sources" && changed) {
        const response = await original(url, init),
          sources = await response.json();
        sources[0].name = "Airport renamed after creation";
        return json(sources);
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByRole("alert");
  expect(published).not.toHaveBeenCalled();
  changed = true;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await waitFor(() =>
    expect(
      screen.queryByText("线路信息已变化，请先核对上次发布结果。"),
    ).not.toBeNull(),
  );
  // A committed prior creation remains reconcilable even though its old inputs changed.
  const retry = screen.queryByRole("button", { name: "核对上次发布结果" });
  expect(retry).not.toBeNull();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).disabled).toBe(
    true,
  );
  await userEvent.click(retry!);
  await waitFor(() => expect(published).toHaveBeenCalledWith(existing));
});

it("retries only the frozen basic creation after request loss, empty lookup and source refetch", async () => {
  const original = fetch;
  const attempts: any[] = [];
  let changed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/me/outputs") {
        if (init?.method !== "POST") return json([]);
        const body = JSON.parse(String(init.body));
        attempts.push(body);
        if (attempts.length === 1)
          throw new TypeError("Request never accepted");
        return json(
          {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          },
          201,
        );
      }
      if (path === "/api/me/sources" && changed) {
        const sources = await (await original(url, init)).json();
        sources[0].name = "Airport renamed after request";
        return json(sources);
      }
      return original(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByRole("alert");
  changed = true;
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await screen.findByText("线路信息已变化，请先核对上次发布结果。");
  await userEvent.click(
    screen.getByRole("button", { name: "核对上次发布结果" }),
  );
  await screen.findByText("尚未确认上次发布结果，请稍后继续核对。");
  expect(published).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "重试上次发布" }));
  await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});

it("releases a rejected unresolved creation but never reconciles its late original receipt as a revised review", async () => {
  const originalFetch = fetch;
  const attempts: any[] = [];
  let previews = 0;
  let reads = 0;
  let original: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/outputs/preview")
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `creation-${++previews}`,
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      if (path === "/api/me/outputs") {
        if (init?.method !== "POST") {
          if (++reads === 1) throw new TypeError("Lookup unavailable");
          return json(reads === 2 ? [] : [original]);
        }
        attempts.push(body);
        if (attempts.length === 1) {
          original = {
            ...body,
            status: "published",
            creationReviewDigest: body.previewDigest,
          };
          throw new TypeError("Original creation still unresolved");
        }
        return json(
          {
            detail:
              attempts.length === 2
                ? "Review is stale; preview again"
                : "output id already exists",
          },
          409,
        );
      }
      return originalFetch(url, init);
    }),
  );
  const { published } = mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "重试上次发布" }));
  await screen.findByText("Review is stale; preview again");
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).disabled).toBe(
    false,
  );
  expect(screen.queryByRole("button", { name: "重试上次发布" })).toBeNull();
  expect(published).not.toHaveBeenCalled();
  await userEvent.clear(screen.getByLabelText("订阅名称"));
  await userEvent.type(screen.getByLabelText("订阅名称"), "Revised daily");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  await screen.findByRole("region", { name: "发布前确认" });
  await userEvent.click(screen.getByRole("button", { name: "发布并获取订阅" }));
  await screen.findByText("output id already exists");
  expect(reads).toBe(3);
  expect(published).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "发布前确认" })).toBeNull();
  expect((screen.getByLabelText("订阅名称") as HTMLInputElement).value).toBe(
    "Revised daily",
  );
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual({
    ...attempts[0],
    name: "Revised daily",
    previewDigest: "creation-2",
  });
  expect(original.creationReviewDigest).toBe("creation-1");
});

it("shows the frozen published route beside the candidate before publishing a basic update", async () => {
  const profile = basicProfile(
    emptyProfile(),
    {
      name: "Daily",
      adapterId: "mihomo",
      chatEndpointId: "entry",
      defaultEndpointId: "tokyo",
    },
    [
      {
        id: "entry",
        label: "UK",
        section: "平台线路",
        platformEntryId: "entry",
      },
      { id: "tokyo", label: "Tokyo", section: "我的机场", sourceId: "airport" },
    ],
  );
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/preview"))
        return json({
          valid: true,
          previewDigest: "review",
          artifacts: [{ path: "config.yaml", content: "safe" }],
          publishedRoutingSummary: {
            version: 1,
            kind: "basic",
            chatGPT: { endpointId: "old", label: "Frozen London" },
            default: { endpointId: "old-default", label: "Frozen Seoul" },
          },
          routingSummary: {
            version: 1,
            kind: "basic",
            chatGPT: { endpointId: "entry", label: "Candidate UK" },
            default: { endpointId: "tokyo", label: "Candidate Tokyo" },
          },
        });
      return original(url, init);
    }),
  );
  mount({
    initial: profile,
    output: {
      id: "one",
      name: "Daily",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    },
  });
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  const review = await screen.findByRole("region", { name: "分流摘要" });
  expect(within(review).getByText("Frozen London → Candidate UK")).toBeTruthy();
  expect(
    within(review).getByText("Frozen Seoul → Candidate Tokyo"),
  ).toBeTruthy();
  expect(requests.some((r) => r.path.endsWith("/publish"))).toBe(false);
});

it("does not infer a missing creation summary from selected source labels", async () => {
  const original = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/outputs/preview")) {
        const body = JSON.parse(String(init?.body));
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "review",
          artifacts: [{ path: "config.yaml", content: "reviewed-config" }],
        });
      }
      return original(url, init);
    }),
  );
  mount();
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  await userEvent.click(screen.getByRole("button", { name: "保存并查看修改" }));
  const review = await screen.findByRole("region", { name: "发布前确认" });
  expect(within(review).getByText("这份订阅暂无可用的分流摘要。")).toBeTruthy();
  expect(within(review).queryByText("FRA → UK · 2×")).toBeNull();
  expect(within(review).queryByText("My airport · Tokyo")).toBeNull();
  expect(
    (
      within(review).getByRole("button", {
        name: "发布并获取订阅",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("carries each accepted basic draft revision into its next save and keeps stale form values", async () => {
  const original = fetch;
  const writes: { headers: Headers; body: any; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (
        /\/api\/me\/profiles(?:\/[^/]+)?$/.test(path) &&
        ["POST", "PUT"].includes(init?.method || "")
      ) {
        const body = JSON.parse(String(init?.body));
        writes.push({
          headers: new Headers(init?.headers),
          body,
          method: init!.method!,
        });
        return writes.length < 3
          ? json({ ...body, revisionToken: `saved-${writes.length}` })
          : json(
              { code: "PROFILE_DRAFT_CHANGED", message: "Changed elsewhere" },
              409,
            );
      }
      return original(url, init);
    }),
  );
  const onClose = vi.fn();
  mount({ onClose });
  await screen.findByRole("combobox", { name: "ChatGPT 使用的线路" });
  await select("ChatGPT 使用的线路", "FRA → UK 额度倍率 2×");
  await select("其他流量使用的线路", "Tokyo 来源 My airport");
  const save = screen.getByRole("button", { name: "保存草稿" });
  await userEvent.click(save);
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(save);
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0].method).toBe("POST");
  expect(writes[0].headers.has("If-Match")).toBe(false);
  expect(writes[1].method).toBe("PUT");
  expect(writes[1].headers.get("If-Match")).toBe("saved-1");
  expect(writes[1].body).not.toHaveProperty("revisionToken");
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  const name = screen.getByRole("textbox", { name: "订阅名称" });
  await userEvent.clear(name);
  await userEvent.type(name, "Retained basic draft");
  await userEvent.click(save);
  const discard = await screen.findByRole("button", { name: "放弃修改并返回" });
  expect(writes[2].headers.get("If-Match")).toBe("saved-2");
  expect((name as HTMLInputElement).value).toBe("Retained basic draft");
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "保存并查看修改",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(discard);
  const confirm = await screen.findByRole("alertdialog", {
    name: "放弃当前修改并返回？",
  });
  await userEvent.click(
    within(confirm).getByRole("button", { name: "保留当前输入" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((name as HTMLInputElement).value).toBe("Retained basic draft");
  expect(onClose).not.toHaveBeenCalled();
  expect(writes).toHaveLength(3);
});

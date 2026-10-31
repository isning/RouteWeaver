// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { flushSync } from "react-dom";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateOutput } from "./Subscriptions";
import type { ReactNode } from "react";
import realOwnerPreview from "./test-fixtures/platform-entry-refresh-owner-preview.json?raw";
const summary = (chat: string, other: string) => ({
  version: 1 as const,
  kind: "basic" as const,
  chatGPT: { endpointId: "chat", label: chat },
  default: { endpointId: "other", label: other },
});
const output = {
  id: "one",
  name: "Daily",
  profileId: "profile",
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  status: "published",
  routingSummary: summary("Published UK", "Published Tokyo"),
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <UIProviders>{children}</UIProviders>
    </QueryClientProvider>
  );
  return render(node, { wrapper: Wrapper });
}
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
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
});

const digest = "a".repeat(64);
const checked = (link: "preserve" | "replace", extra = {}) => ({
  valid: true,
  outputId: output.id,
  previewScope: "output-update",
  previewDigest: digest,
  publicationEffect: { version: 1, link },
  artifacts: [],
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const check = async () => {
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("兼容检查通过。");
};
it.each(["preserve", "replace"] as const)(
  "uses authoritative %s effect rather than cached lifecycle",
  async (link) => {
    const onPublished = vi.fn();
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      json(String(url).endsWith("/publish") ? output : checked(link)),
    );
    vi.stubGlobal("fetch", fetch);
    mount(
      <UpdateOutput
        output={{
          ...output,
          status: link === "preserve" ? "revoked" : "published",
        }}
        onClose={() => {}}
        onPublished={onPublished}
      />,
    );
    expect(screen.queryByText(/链接不变/)).toBeNull();
    await check();
    const label = link === "replace" ? "重新发布并生成新链接" : "确认更新";
    const confirm = screen.getByRole("button", { name: `${label}「Daily」` });
    expect(confirm).toHaveProperty("disabled", false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.dblClick(confirm);
    await waitFor(() =>
      expect(onPublished).toHaveBeenCalledWith(output, link === "replace"),
    );
    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith("/publish")),
    ).toHaveLength(1);
  },
);
it.each([
  ["missing", { publicationEffect: undefined }],
  ["null", { publicationEffect: null }],
  ["unknown version", { publicationEffect: { version: 2, link: "preserve" } }],
  ["unknown effect", { publicationEffect: { version: 1, link: "rotate" } }],
  ["wrong output", { outputId: "another" }],
  ["wrong scope", { previewScope: "new-output" }],
  ["invalid digest", { previewDigest: "old" }],
])(
  "blocks %s review metadata with local recheck recovery",
  async (_name, extra) => {
    const fetch = vi.fn(async () => json(checked("preserve", extra)));
    vi.stubGlobal("fetch", fetch);
    mount(<UpdateOutput output={output} onClose={() => {}} />);
    const unbound = ["wrong output", "wrong scope", "invalid digest"].includes(
      _name,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "预览此订阅更新" }),
    );
    if (unbound) {
      await screen.findByText("检查结果与此订阅不匹配，请重新检查。");
      expect(screen.queryByText("兼容检查通过。")).toBeNull();
    } else {
      await screen.findByText("无法确认链接变化，请重新检查。");
      expect(screen.getByRole("button", { name: /^取\s*消$/ })).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: "确认更新「Daily」" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText(/链接不变/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", {
        name: unbound ? "预览此订阅更新" : "重新检查",
      }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  },
);
it("keeps the approved consequence and name while same-output props change during publication", async () => {
  const pending = deferred<Response>();
  const onPublished = vi.fn(),
    onClose = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: RequestInfo | URL) =>
      String(url).endsWith("/publish")
        ? pending.promise
        : Promise.resolve(json(checked("replace"))),
    ),
  );
  const view = mount(
    <UpdateOutput
      output={output}
      onClose={onClose}
      onPublished={onPublished}
    />,
  );
  await check();
  await userEvent.click(
    screen.getByRole("button", { name: "重新发布并生成新链接「Daily」" }),
  );
  view.rerender(
    <UpdateOutput
      output={{ ...output, status: "published", name: "New name" }}
      onClose={onClose}
      onPublished={onPublished}
    />,
  );
  await act(async () =>
    pending.resolve(json({ ...output, name: "Server response" })),
  );
  await waitFor(() =>
    expect(onPublished).toHaveBeenCalledWith(
      { ...output, name: "Server response" },
      true,
    ),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});
it.each(["suspend", "replace", "unmount"] as const)(
  "expires a late publication continuation after %s",
  async (operation) => {
    const pending = deferred<Response>();
    const onPublished = vi.fn(),
      onClose = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL) =>
        String(url).endsWith("/publish")
          ? pending.promise
          : Promise.resolve(json(checked("replace"))),
      ),
    );
    const view = mount(
      <UpdateOutput
        output={output}
        onClose={onClose}
        onPublished={onPublished}
      />,
    );
    await check();
    await userEvent.click(
      screen.getByRole("button", { name: "重新发布并生成新链接「Daily」" }),
    );
    if (operation === "unmount") view.unmount();
    else
      view.rerender(
        <UpdateOutput
          output={operation === "replace" ? { ...output, id: "two" } : output}
          suspended={operation === "suspend"}
          onClose={onClose}
          onPublished={onPublished}
        />,
      );
    await act(async () => pending.resolve(json(output)));
    expect(onPublished).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/已更新，其他客户端/)).toBeNull();
  },
);
it("does not restore a late inspection after suspension and resume", async () => {
  const pending = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => pending.promise),
  );
  const view = mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  view.rerender(<UpdateOutput output={output} suspended onClose={() => {}} />);
  view.rerender(<UpdateOutput output={output} onClose={() => {}} />);
  await act(async () => pending.resolve(json(checked("replace"))));
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
});
it("clears stale approval on 409 and rechecks before an intentional retry", async () => {
  let writes = 0;
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/publish")) {
      writes++;
      return new Response(JSON.stringify({ detail: "review is stale" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    return json(checked("preserve"));
  });
  vi.stubGlobal("fetch", fetch);
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await check();
  await userEvent.click(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  );
  await screen.findByText("review is stale");
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
  expect(screen.queryByText(/链接不变/)).toBeNull();
  expect(writes).toBe(1);
  await check();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", false);
  expect(writes).toBe(1);
});
it("keeps review on a network failure and publishes again only on intentional retry", async () => {
  let writes = 0;
  const onPublished = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).endsWith("/publish")) return json(checked("replace"));
      if (++writes === 1) throw new TypeError("Network offline");
      return json(output);
    }),
  );
  mount(
    <UpdateOutput
      output={output}
      onClose={() => {}}
      onPublished={onPublished}
    />,
  );
  await check();
  const confirm = screen.getByRole("button", {
    name: "重新发布并生成新链接「Daily」",
  });
  await userEvent.click(confirm);
  await screen.findByText("无法连接服务。请检查网络后重试，当前输入已保留。");
  expect(writes).toBe(1);
  expect(confirm).toHaveProperty("disabled", false);
  await userEvent.click(confirm);
  await waitFor(() => expect(onPublished).toHaveBeenCalledWith(output, true));
  expect(writes).toBe(2);
});
it("never enables a compatibility-blocked review even with a known effect", async () => {
  const fetch = vi.fn(async () =>
    json(
      checked("replace", {
        valid: false,
        diagnostics: ["Unsupported routing option"],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("Unsupported routing option");
  expect(
    screen.getByRole("button", { name: "重新发布并生成新链接「Daily」" }),
  ).toHaveProperty("disabled", true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("rejects a wholly malformed preview without displaying success or content", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(null)),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("检查结果与此订阅不匹配，请重新检查。");
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
});
it("rechecking discards the former effect and requires the latest explicit approval", async () => {
  const next = deferred<Response>();
  let reads = 0;
  const onPublished = vi.fn();
  const fetch = vi.fn((url: RequestInfo | URL) => {
    if (String(url).endsWith("/publish")) return Promise.resolve(json(output));
    return ++reads === 1
      ? Promise.resolve(json(checked("preserve")))
      : next.promise;
  });
  vi.stubGlobal("fetch", fetch);
  mount(
    <UpdateOutput
      output={output}
      onClose={() => {}}
      onPublished={onPublished}
    />,
  );
  await check();
  await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
  expect(screen.queryByText(/链接不变/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
  await act(async () =>
    next.resolve(json(checked("replace", { previewDigest: "b".repeat(64) }))),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "重新发布并生成新链接「Daily」",
    }),
  );
  await waitFor(() => expect(onPublished).toHaveBeenCalledWith(output, true));
  const write = fetch.mock.calls.find(([url]) =>
    String(url).endsWith("/publish"),
  );
  expect(write).toBeTruthy();
});
it("dismissal expires an inspection even when the parent keeps its component mounted", async () => {
  const pending = deferred<Response>();
  const onClose = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => pending.promise),
  );
  mount(<UpdateOutput output={output} onClose={onClose} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await userEvent.click(screen.getByRole("button", { name: /^取\s*消$/ }));
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(json(checked("replace"))));
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
});

it("groups the bounded comparison conclusion before evidence and keeps a named decision target", async () => {
  const intent = {
    version: 1,
    kind: "portable",
    ruleCount: 0,
    rules: [],
    defaultAction: { kind: "direct" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        checked("replace", {
          publishedRoutingIntent: intent,
          routingIntent: intent,
        }),
      ),
    ),
  );
  mount(
    <UpdateOutput
      output={output}
      profileName="Everyday routing"
      onClose={() => {}}
    />,
  );
  await check();
  const comparison = screen.getByRole("group", { name: "比较结论与范围" });
  expect(comparison.textContent).toContain("分流规则和默认去向未变化");
  expect(comparison.textContent).toContain(
    "未比较规则文件内容和客户端运行设置。",
  );
  expect(
    screen.getByText(
      "此版本没有可用的策略组和连接比较。可查看待发布技术配置。",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("dialog", { name: "检查订阅更新「Daily」" }),
  ).toBeTruthy();
  expect(screen.getByText("更新订阅：").textContent).toContain("Daily");
  const confirm = screen.getByRole("button", {
    name: "重新发布并生成新链接「Daily」",
  });
  expect(confirm.textContent).toBe("重新发布并生成新链接");
  expect(
    screen.getByText("发布后请在客户端换用新链接，其他订阅不受影响。"),
  ).toBeTruthy();
});

it.each([
  ["positive", { version: 1, count: 2 }, true],
  ["absent", undefined, false],
  ["zero", { version: 1, count: 0 }, false],
  ["negative", { version: 1, count: -1 }, false],
  ["fractional", { version: 1, count: 1.5 }, false],
  ["unsafe", { version: 1, count: Number.MAX_SAFE_INTEGER + 1 }, false],
  ["string", { version: 1, count: "2" }, false],
  ["unknown-version", { version: 2, count: 2 }, false],
] as const)(
  "keeps %s platform-input metadata separate from nodes-only comparison and approval",
  async (_, refresh, shown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          checked("preserve", {
            platformEntryRefresh: refresh,
            publishedRoutingIntent: { version: 1, kind: "nodes-only" },
            routingIntent: { version: 1, kind: "nodes-only" },
          }),
        ),
      ),
    );
    // The selected mode must match the server preview this regression exercises.
    mount(
      <UpdateOutput
        output={{ ...output, mode: "nodes-only" }}
        onClose={() => {}}
      />,
    );
    await check();
    expect(
      screen.getByText(
        "纯节点订阅不包含分流规则；节点及连接设置的变化不在此摘要中。",
      ),
    ).toBeTruthy();
    expect(!!screen.queryByText("将采用 2 个平台入口的最新连接信息。")).toBe(
      shown,
    );
    expect(screen.queryByText(/将采用 0/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "确认更新「Daily」" }),
    ).toHaveProperty("disabled", false);
  },
);

it("does not offer platform-input reassurance or approval on an invalid review", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        checked("preserve", {
          valid: false,
          platformEntryRefresh: { version: 1, count: 2 },
        }),
      ),
    ),
  );
  mount(<UpdateOutput output={output} onClose={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("兼容检查未通过，已发布内容保持不变。");
  expect(screen.queryByText(/将采用/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", true);
});

it("expires a cancelled inspection before dismissal and leaves newer focus alone", async () => {
  const pending = deferred<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => pending.promise),
  );
  const origin = document.createElement("button");
  const next = document.createElement("button");
  origin.textContent = "Open review";
  next.textContent = "New task";
  document.body.append(origin, next);
  origin.focus();
  const onClose = vi.fn();
  try {
    mount(
      <UpdateOutput
        output={output}
        openingTrigger={origin}
        autoInspect
        onClose={onClose}
      />,
    );
    await act(async () => {
      // Commit dismissal before a newer task claims external focus: a real
      // Radix modal correctly traps outside focus until its scope is released.
      // The old request is still unresolved, so its late result must not steal it.
      flushSync(() => {
        screen.getByRole("button", { name: /^取\s*消$/ }).click();
      });
      next.focus();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(next);
    await act(async () => pending.resolve(json(checked("replace"))));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryByText("发布后请在客户端换用新链接，其他订阅不受影响。"),
    ).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(next);
  } finally {
    origin.remove();
    next.remove();
  }
});

it("does not restore the old opener after the closing callback opens the next task", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(checked("preserve"))),
  );
  const origin = document.createElement("button");
  const next = document.createElement("button");
  origin.textContent = "Open review";
  next.textContent = "Next task";
  document.body.append(origin, next);
  origin.focus();
  const onClose = vi.fn(() => next.focus());
  try {
    mount(
      <UpdateOutput
        output={output}
        openingTrigger={origin}
        onClose={onClose}
      />,
    );
    await check();
    await userEvent.click(screen.getByRole("button", { name: /^取\s*消$/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(next);
  } finally {
    origin.remove();
    next.remove();
  }
});

it("replays the actual captured owner preview without replacing its comparison or approval facts", async () => {
  // Actual backend bytes from synthetic managed-entry rotation; transport here
  // is mocked replay, not a live rotation or client-application test.
  // Byte equality and SHA-256 are verified by the frozen lane receipt:
  // a4533f57410b9beb52ce230777dbf36f02135ecfc3391902b035467531472460.
  const requests: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const path = String(input);
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path !== "/api/me/profiles/rotation-profile/preview")
        throw new Error("Unexpected request before explicit approval");
      return new Response(realOwnerPreview, {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  mount(
    <UpdateOutput
      output={{
        id: "refresh-phone",
        name: "Phone",
        profileId: "rotation-profile",
        target: { adapterId: "mihomo", version: "1.19.32" },
        mode: "nodes-only",
        status: "published",
      }}
      onClose={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "预览此订阅更新" }));
  await screen.findByText("将采用 1 个平台入口的最新连接信息。");
  expect(
    screen.getByText(
      "纯节点订阅不包含分流规则；节点及连接设置的变化不在此摘要中。",
    ),
  ).toBeTruthy();
  const consequence = screen.getByText("链接不变，其他订阅不受影响。");
  expect(
    screen.getByRole("group", { name: "更新确认" }).contains(consequence),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "确认更新「Phone」" }),
  ).toHaveProperty("disabled", false);
  expect(requests).toEqual([
    {
      path: "/api/me/profiles/rotation-profile/preview",
      body: {
        outputId: "refresh-phone",
        target: { adapterId: "mihomo", version: "1.19.32" },
        mode: "nodes-only",
      },
    },
  ]);
  expect(requests.some(({ path }) => path.endsWith("/publish"))).toBe(false);
});

it("identifies exported node changes in the selected nodes-only decision without changing platform input counts", async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) =>
    json(
      checked("preserve", {
        routingSummary: { version: 1, kind: "nodes-only" },
        publishedRoutingSummary: { version: 1, kind: "nodes-only" },
        nodeChanges: {
          version: 1,
          state: "available",
          beforeCount: 2,
          afterCount: 3,
          addedCount: 1,
          removedCount: 0,
          modifiedCount: 1,
          affectedNodeCount: 2,
          orderChanged: false,
          omittedRowCount: 0,
          rows: [
            { kind: "added", label: "Gamma" },
            { kind: "modified", label: "Alpha", settingsChanged: true },
          ],
        },
        platformEntryRefresh: { version: 1, count: 1 },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  mount(
    <UpdateOutput
      output={{ ...output, mode: "nodes-only" }}
      onClose={() => {}}
    />,
  );
  await check();
  expect(screen.getByRole("region", { name: "节点变化" })).toBeTruthy();
  expect(screen.getByText("Gamma")).toBeTruthy();
  expect(screen.getByText("连接设置变化")).toBeTruthy();
  expect(screen.getByText("将采用 1 个平台入口的最新连接信息。")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "确认更新「Daily」" }),
  ).toHaveProperty("disabled", false);
  expect(
    fetch.mock.calls.filter(([url]) => String(url).endsWith("/publish")),
  ).toHaveLength(0);
});

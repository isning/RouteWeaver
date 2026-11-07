// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionOriginSettings } from "./SubscriptionOriginSettings";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (e) => original(e);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
});
function mount(client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
})) {
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionOriginSettings />
      </UIProviders>
    </QueryClientProvider>,
  );
}
const initial = {
  revision: 4,
  configuredRevision: 2,
  draftOrigin: "https://old.example",
  effectiveRevision: 2,
  effectiveOrigin: "https://old.example",
  defaultOrigin: "",
  verificationStatus: "expired",
  verifiedAt: "2026-01-01T00:00:00Z",
  currentLinkExample: "https://old.example/feed/{existing-token}",
  proposedLinkExample: "https://old.example/feed/{existing-token}",
  tokensUnchanged: true,
};
describe("subscription domain tasks", () => {
  it("pairs current-address labels with their values without substituting the pending draft", async () => {
    const fetcher = vi.fn(async () =>
      json({
        ...initial,
        configuredRevision: 3,
        draftOrigin: "https://draft.example",
        proposedLinkExample: "https://draft.example/feed/{existing-token}",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    mount();
    const label = await screen.findByText("当前订阅地址");
    const summary = label.closest("dl");
    expect(summary).not.toBeNull();
    const pairs = Array.from(summary!.querySelectorAll("dt")).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(pairs).toEqual([
      ["当前订阅地址", initial.effectiveOrigin],
      ["当前链接示例", initial.currentLinkExample],
    ]);
    expect(
      (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
    ).toBe("https://draft.example");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("shows DNS and TLS prerequisites before the draft-save decision", async () => {
    const fetcher = vi.fn(async () => json(initial));
    vi.stubGlobal("fetch", fetcher);
    mount();
    const save = await screen.findByRole("button", { name: "保存域名草稿" });
    const prerequisite = screen.getByText(/请先由运维配置 DNS、有效 HTTPS/);
    expect(prerequisite.textContent).toContain(
      "证书与反向代理。这里仅保存并验证链接地址，DNS 与证书由运维管理。",
    );
    expect(
      prerequisite.compareDocumentPosition(save) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText(/请先由运维配置 DNS、有效 HTTPS/)).toHaveLength(
      1,
    );
    expect(
      (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
    ).toBe(initial.draftOrigin);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("explains when an empty domain takes effect and the verification lifetime before enable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(initial)),
    );
    mount();
    await screen.findByRole("button", { name: "保存域名草稿" });
    expect(screen.getByText(/留空并启用后使用默认地址/)).toBeTruthy();
    const lifetime = screen.getByText(
      "验证已超过 5 分钟有效期，请重新验证后再启用。",
    );
    const activate = screen.getByRole("button", { name: "启用已保存草稿" });
    expect(
      lifetime.compareDocumentPosition(activate) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("retains a rejected draft, then requires verification before explicitly activating a saved replacement", async () => {
    let state: typeof initial & { activatedAt?: string } = { ...initial };
    const writes: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (!init?.method) return json(state);
        const body = JSON.parse(init.body);
        writes.push({ url: String(url), body });
        if (init.method === "PUT") {
          if (body.origin === "not-an-origin")
            return json({ error: "HTTPS origin required" }, 400);
          state = {
            ...state,
            revision: 5,
            configuredRevision: 5,
            draftOrigin: body.origin,
            verificationStatus: "unverified",
            proposedLinkExample: `${body.origin}/feed/{existing-token}`,
          };
          return json(state);
        }
        if (String(url).endsWith("/verify")) {
          state = { ...state, revision: 6, verificationStatus: "verified" };
          return json(state);
        }
        state = {
          ...state,
          revision: 7,
          effectiveRevision: 5,
          effectiveOrigin: state.draftOrigin,
          activatedAt: "2026-11-06T00:00:00Z",
          currentLinkExample: state.proposedLinkExample,
        };
        return json(state);
      }),
    );
    mount();
    const user = userEvent.setup();
    await screen.findByText("https://old.example");
    fireEvent.change(screen.getByLabelText("订阅域名草稿"), {
      target: { value: "not-an-origin" },
    });
    await user.click(screen.getByRole("button", { name: "保存域名草稿" }));
    await screen.findByText("HTTPS origin required");
    expect(
      (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
    ).toBe("not-an-origin");
    fireEvent.change(screen.getByLabelText("订阅域名草稿"), {
      target: { value: "https://new.example" },
    });
    await user.click(screen.getByRole("button", { name: "保存域名草稿" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "验证 HTTPS 与实例",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "启用已保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "验证 HTTPS 与实例" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "启用已保存草稿",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "启用已保存草稿" }));
    await user.click(screen.getByRole("checkbox", { name: /我已确认域名/ }));
    await user.click(screen.getByRole("button", { name: "确认启用" }));
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({
        url: "/api/admin/subscription-origin/activate",
        body: { expectedRevision: 6 },
      }),
    );
    expect(writes[2]).toEqual({
      url: "/api/admin/subscription-origin/verify",
      body: { expectedRevision: 5 },
    });
  });
});
it("refreshes a failed verification without replacing the active domain or losing typed input on stale activation", async () => {
  let state = {
    ...initial,
    draftOrigin: "https://new.example",
    configuredRevision: 4,
    verificationStatus: "unverified",
    proposedLinkExample: "https://new.example/feed/{existing-token}",
  };
  let verifies = 0,
    reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (!init?.method) {
        reads++;
        return json(state);
      }
      if (String(url).endsWith("/verify")) {
        verifies++;
        state = {
          ...state,
          revision: 5 + verifies,
          verificationStatus: verifies === 1 ? "failed" : "verified",
        };
        return verifies === 1
          ? json({ error: "Check HTTPS and instance routing" }, 422)
          : json(state);
      }
      state = {
        ...state,
        revision: 20,
        draftOrigin: "https://other.example",
        proposedLinkExample: "https://other.example/feed/{existing-token}",
        configuredRevision: 20,
        verificationStatus: "unverified",
      };
      return json({ error: "Settings changed; reload before continuing" }, 409);
    }),
  );
  mount();
  const user = userEvent.setup();
  await screen.findByText("https://old.example");
  await user.click(screen.getByRole("button", { name: "验证 HTTPS 与实例" }));
  await screen.findByText("Check HTTPS and instance routing");
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByText("https://old.example")).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "启用已保存草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "验证 HTTPS 与实例" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "启用已保存草稿",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "启用已保存草稿" }));
  await user.click(screen.getByRole("checkbox", { name: /我已确认域名/ }));
  await user.click(screen.getByRole("button", { name: "确认启用" }));
  await screen.findByText("Settings changed; reload before continuing");
  expect(
    (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
  ).toBe("https://new.example");
  expect(screen.queryByRole("button", { name: "确认启用" })).toBeNull();
  expect(screen.getByText("https://old.example")).toBeTruthy();
});
it("keeps unsaved domain text when a stale write is followed by a failed state refresh", async () => {
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (!init?.method) {
        return ++reads === 1
          ? json(initial)
          : json({ error: "State refresh unavailable" }, 503);
      }
      return json({ error: "Settings changed" }, 409);
    }),
  );
  mount();
  const user = userEvent.setup();
  await screen.findByText("https://old.example");
  fireEvent.change(screen.getByLabelText("订阅域名草稿"), {
    target: { value: "https://keep-this.example" },
  });
  await user.click(screen.getByRole("button", { name: "保存域名草稿" }));
  await screen.findByText("State refresh unavailable");
  expect(
    (screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value,
  ).toBe("https://keep-this.example");
});

it.each([
  [
    "subscription origin must be HTTPS without credentials, path, query or fragment",
    "请使用 HTTPS 域名，可带端口；移除用户名、密码、路径、查询参数和片段。",
  ],
  [
    "subscription origin must use a public HTTPS address",
    "请填写公开可访问的 HTTPS 域名，不要使用本机或私有网络地址。",
  ],
  [
    "subscription origin is too long",
    "地址过长，请缩短域名或移除多余内容后重试。",
  ],
])(
  "explains rejected input locally without discarding technical evidence: %s",
  async (detail, repair) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) =>
        init?.method ? json({ detail }, 400) : json(initial),
      ),
    );
    mount();
    const input = await screen.findByLabelText("订阅域名草稿");
    fireEvent.change(input, {
      target: { value: "http://invalid.example/path" },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存域名草稿" }));
    const message = await screen.findByText(repair);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const error = document.getElementById(
      input.getAttribute("aria-describedby")!,
    )!;
    expect(error.contains(message)).toBe(true);
    expect(
      input.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (screen.getByText(detail).closest("details") as HTMLDetailsElement).open,
    ).toBe(false);
    await userEvent.click(screen.getByText("技术详情"));
    expect(
      (screen.getByText(detail).closest("details") as HTMLDetailsElement).open,
    ).toBe(true);
    expect(input).toHaveProperty("value", "http://invalid.example/path");
  },
);
it("keeps unknown server errors visible and does not classify them as invalid input", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) =>
      init?.method
        ? json({ detail: "Unknown storage fault ABC" }, 503)
        : json(initial),
    ),
  );
  mount();
  const input = await screen.findByLabelText("订阅域名草稿");
  await userEvent.click(screen.getByRole("button", { name: "保存域名草稿" }));
  const message = await screen.findByText("Unknown storage fault ABC");
  expect(message.closest("details")).toBeNull();
  expect(input.getAttribute("aria-invalid")).not.toBe("true");
});

it.each(["verified", "expired", "unverified", "failed", "not-required"])(
  "provides state-specific guidance and paired proposed-link semantics: %s",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ...initial,
          verificationStatus: status,
          verificationExpiresAt: ["verified", "expired"].includes(status)
            ? "2026-11-03T12:05:00Z"
            : undefined,
          lastFailure: status === "failed" ? "probe detail" : undefined,
        }),
      ),
    );
    mount();
    const term = await screen.findByText("拟用链接");
    expect(term.tagName).toBe("DT");
    expect(term.nextElementSibling?.textContent).toBe(
      initial.proposedLinkExample,
    );
    if (status === "verified")
      expect(
        screen.getByText(/^本次验证有效至 .*过期后需重新验证再启用。$/),
      ).toBeTruthy();
    if (status === "expired")
      expect(
        screen.getByText(/^验证已于 .*过期，请重新验证后再启用。$/),
      ).toBeTruthy();
    if (status === "unverified")
      expect(
        screen.getByText(
          "验证 HTTPS 与实例后才能启用；验证结果在通过后的 5 分钟内有效。",
        ),
      ).toBeTruthy();
    if (status === "failed") {
      expect(screen.getByText("probe detail")).toBeTruthy();
      expect(
        screen.getByText("检查域名解析、HTTPS 证书与 /feed 路由后重试"),
      ).toBeTruthy();
    }
    if (["failed", "not-required"].includes(status))
      expect(screen.queryByText(/5 分钟/)).toBeNull();
    expect(screen.queryByText(/上次验证|不代表持续可用性/)).toBeNull();
  },
);

it.each([
  [
    409,
    "settings changed or no draft exists; reload before continuing",
    "请核对重新读取的草稿，再继续验证或启用。",
  ],
  [
    422,
    "Could not verify this instance. Check public DNS, the HTTPS certificate and /feed routing, then verify again.",
    "请检查公开 DNS、HTTPS 证书和 /feed 路由，然后重新验证。",
  ],
])(
  "keeps verification recovery explicit for known HTTP %s responses",
  async (status, detail, repair) => {
    const fetcher = vi.fn(async (_url, init) =>
      init?.method ? json({ detail }, Number(status)) : json(initial),
    );
    vi.stubGlobal("fetch", fetcher);
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "验证 HTTPS 与实例" }),
    );
    await screen.findByText(repair);
    expect(screen.getByText(detail).closest("details")).not.toBeNull();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("订阅域名草稿")).toHaveProperty(
      "value",
      initial.draftOrigin,
    );
    expect(screen.getByText(initial.effectiveOrigin)).toBeTruthy();
  },
);

// Candidate reconstruction: behavioral verification UNRUN.
it.each(["lost response", "server error", "invalid JSON", "incomplete JSON", "wrong target"])(
  "reconciles %s activation with a read and requires fresh review without replay",
  async (failure) => {
    const staged = {
      ...initial, configuredRevision: 4, draftOrigin: "https://new.example",
      verificationStatus: "verified",
      proposedLinkExample: "https://new.example/feed/{existing-token}",
    };
    let reads = 0;
    let writes = 0;
    let readMode = "failed";
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (!init?.method) {
        reads++;
        if (reads === 1) return json(staged);
        if (readMode === "failed") return json({ detail: "Read unavailable" }, 503);
        if (readMode === "malformed") return json({ revision: 99 });
        return json(staged);
      }
      writes++;
      if (failure === "lost response") throw new TypeError("connection lost");
      if (failure === "server error") return json({ detail: "Write unavailable" }, 503);
      if (failure === "invalid JSON") return new Response("{", { status: 200 });
      if (failure === "incomplete JSON") return json({ revision: 5 });
      return json({ ...staged, revision: 5 });
    }));
    mount();
    const user = userEvent.setup();
    const activate = await screen.findByRole("button", { name: "启用已保存草稿" });
    // Modal review correctly hides the background from accessible-role queries.
    const save = screen.getByRole("button", { name: "保存域名草稿" });
    const verify = screen.getByRole("button", { name: "验证 HTTPS 与实例" });
    await user.click(activate);
    await user.click(screen.getByRole("checkbox", { name: /我已确认域名/ }));
    await user.click(screen.getByRole("button", { name: "确认启用" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("域名启用结果尚未确认");
    if (failure === "incomplete JSON")
      expect(within(dialog).getByText("启用请求：域名设置响应不完整，请重新读取设置。")).toBeTruthy();
    expect(within(dialog).queryByText(/^重新读取失败：/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认启用" })).toHaveProperty("disabled", true);
    expect(save).toHaveProperty("isConnected", true);
    expect(save).toHaveProperty("disabled", true);
    expect(verify).toHaveProperty("isConnected", true);
    expect(verify).toHaveProperty("disabled", true);
    await user.click(within(dialog).getByRole("button", { name: "重新读取设置" }));
    await within(dialog).findByText("重新读取失败：Read unavailable");
    expect(writes).toBe(1);
    readMode = "malformed";
    await user.click(within(dialog).getByRole("button", { name: "重新读取设置" }));
    await within(dialog).findByText("重新读取失败：域名设置响应不完整，请重新读取设置。");
    expect(within(dialog).queryByText("重新读取失败：Read unavailable")).toBeNull();
    expect(reads).toBe(3);
    expect(writes).toBe(1);
    expect(within(dialog).getByRole("button", { name: "确认启用" })).toHaveProperty("disabled", true);
    readMode = "valid";
    await user.click(within(dialog).getByRole("button", { name: "重新读取设置" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes).toBe(1);
    expect(reads).toBe(4);
    await user.click(screen.getByRole("button", { name: "启用已保存草稿" }));
    expect(screen.getByRole("button", { name: "确认启用" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("订阅域名草稿")).toHaveProperty("value", staged.draftOrigin);
  },
);

it("keeps uncertain activation blocked after dismissal and reads an already-applied domain without replay", async () => {
  const staged = { ...initial, configuredRevision: 4, draftOrigin: "https://new.example",
    verificationStatus: "verified", proposedLinkExample: "https://new.example/feed/{existing-token}" };
  let writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method) { writes++; throw new TypeError("lost"); }
    return json(writes ? { ...staged, revision: 5, effectiveRevision: 4,
      effectiveOrigin: staged.draftOrigin, currentLinkExample: staged.proposedLinkExample,
      activatedAt: "2026-11-06T00:00:00Z" } : staged);
  }));
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "启用已保存草稿" }));
  await user.click(screen.getByRole("checkbox", { name: /我已确认域名/ }));
  await user.click(screen.getByRole("button", { name: "确认启用" }));
  await screen.findByText("域名启用结果尚未确认");
  await user.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "启用已保存草稿" })).toHaveProperty("disabled", true);
  await user.click(screen.getByRole("button", { name: "重新读取设置" }));
  await waitFor(() => expect(screen.queryByText("域名启用结果尚未确认")).toBeNull());
  expect(screen.getByText("https://new.example")).toBeTruthy();
  expect(screen.getByRole("button", { name: "启用已保存草稿" })).toHaveProperty("disabled", true);
  expect(writes).toBe(1);
});

it.each(["保存域名草稿", "验证 HTTPS 与实例"])(
  "rejects malformed %s acknowledgments without replacing displayed settings or input",
  async (action) => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) =>
      init?.method ? json({ revision: 5 }) : json(initial),
    ));
    mount();
    const input = await screen.findByLabelText("订阅域名草稿");
    await userEvent.click(screen.getByRole("button", { name: action }));
    await screen.findByText("域名设置响应不完整，请重新读取设置。");
    expect(input).toHaveProperty("value", initial.draftOrigin);
    expect(screen.getByText(initial.effectiveOrigin)).toBeTruthy();
    expect(screen.queryByText("新复制的订阅链接将使用所选地址")).toBeNull();
  },
);

it("rejects malformed shared-cache views at the consumer boundary", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () => json(initial)));
  mount(client);
  await screen.findByLabelText("订阅域名草稿");
  act(() => { client.setQueryData(["subscription-origin"], { revision: 99, draftOrigin: "poison" }); });
  await screen.findByText("域名设置响应不完整，请重新读取设置。");
  expect(screen.queryByDisplayValue("poison")).toBeNull();
  const save = screen.queryByRole("button", { name: "保存域名草稿" });
  if (save) expect(save).toHaveProperty("disabled", true);
});

it("does not dispatch a paused activation after the authoritative source revision changes", async () => {
  const staged = { ...initial, configuredRevision: 4, draftOrigin: "https://new.example",
    verificationStatus: "verified", proposedLinkExample: "https://new.example/feed/{existing-token}" };
  let state = staged;
  let writes = 0;
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false }, mutations: { retry: false },
  } });
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method) writes++;
    return json(state);
  }));
  mount(client);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "启用已保存草稿" }));
  await user.click(screen.getByRole("checkbox", { name: /我已确认域名/ }));
  onlineManager.setOnline(false);
  await user.click(screen.getByRole("button", { name: "确认启用" }));
  state = { ...staged, revision: 5 };
  act(() => { client.setQueryData(["subscription-origin"], state); });
  onlineManager.setOnline(true);
  await screen.findByText("请核对重新读取的草稿，再继续验证或启用。");
  expect(writes).toBe(0);
});

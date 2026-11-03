// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
});
function mount() {
  return render(
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
  it("shows DNS and TLS prerequisites before the draft-save decision", async () => {
    const fetcher = vi.fn(async () => json(initial));
    vi.stubGlobal("fetch", fetcher);
    mount();
    const save = await screen.findByRole("button", { name: "保存域名草稿" });
    const prerequisite = screen.getByText(/请先由运维配置 DNS、有效 HTTPS/);
    expect(prerequisite.textContent).toContain("证书与反向代理。这里仅保存并验证链接地址，不修改 DNS 或证书。");
    expect(prerequisite.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/请先由运维配置 DNS、有效 HTTPS/)).toHaveLength(1);
    expect((screen.getByLabelText("订阅域名草稿") as HTMLInputElement).value).toBe(initial.draftOrigin);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains a rejected draft, then requires verification before explicitly activating a saved replacement", async () => {
    let state = { ...initial };
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

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
  onlineManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import type { Output } from "./types";
import { setToken, setCSRF, installSessionTransport } from "./api";
import { SessionLifecycle } from "./SessionLifecycle";
import { AccessSubscription } from "./Subscriptions";
import { emptyProfile } from "./model";
function mount(node: ReactNode, seed?: { id: string; access: unknown }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  if (seed) client.setQueryData(["output-access", seed.id], seed.access);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  onlineManager.setOnline(true);
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
  onlineManager.setOnline(true);
  cleanup();
  setToken("");
  setCSRF("");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Synthetic public DOM regressions only; all execution is UNRUN in recovery.
const output: Output = {
  id: "phone", name: "Phone", profileId: "shared",
  target: emptyProfile().target, mode: "full", status: "published", delivery: "bundle",
};
function fixture(body?: () => Promise<Blob>, failure?: string) {
  const create = vi.fn(() => "blob:synthetic-bundle");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = vi.fn();
  });
  const saves: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saves.push(this.href);
  });
  const downloads: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/access")) return json({
      delivery: "bundle", downloadPath: "https://untrusted.invalid/collect",
    });
    downloads.push({ path, init });
    if (failure === "network") throw new Error("synthetic network interruption");
    if (failure === "unauthorized") return json({ error: "expired" }, 401);
    if (failure === "wrong media type") return json({ unexpected: true });
    const response = new Response(new Uint8Array([80, 75, 5, 6, ...Array(18).fill(0)]), {
      headers: { "Content-Type": "application/zip" },
    });
    if (body) response.blob = body;
    return response;
  }));
  return { create, saves, downloads };
}
it("keeps cookie downloads as fixed same-origin links and explains unchanged rotation contents", async () => {
  setToken("");
  const f = fixture();
  mount(<AccessSubscription output={output} onClose={() => {}} replacement />);
  const link = await screen.findByRole("link", { name: "下载配置与规则文件" });
  expect(link.getAttribute("href")).toBe("/api/me/outputs/phone/bundle");
  expect(screen.getByText(/配置包内容不变，无需因此重新导入/)).toBeTruthy();
  expect(f.downloads).toEqual([]);
});
it("downloads for a token operator through authenticated fixed GET without trusting metadata", async () => {
  setToken("synthetic-operator");
  const f = fixture();
  mount(<AccessSubscription output={output} onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "下载配置与规则文件" }));
  await waitFor(() => expect(f.saves).toEqual(["blob:synthetic-bundle"]));
  expect(f.downloads).toHaveLength(1);
  expect(f.downloads[0].path).toBe("/api/me/outputs/phone/bundle");
  expect(new Headers(f.downloads[0].init?.headers).get("Authorization")).toBe("Bearer synthetic-operator");
  expect(f.downloads[0].init?.redirect).toBe("error");
  expect(f.downloads[0].init?.credentials).toBe("same-origin");
  expect(f.downloads[0].init?.body).toBeUndefined();
});
it.each(["token ABA", "account", "close", "revision", "direct unmount"])(
  "discards bundle bytes after %s changes during body read", async (change) => {
    setToken("synthetic-operator");
    let finish!: (value: Blob) => void;
    let started = false;
    const f = fixture(() => {
      started = true;
      return new Promise<Blob>((resolve) => { finish = resolve; });
    });
    const lifecycle = new SessionLifecycle();
    lifecycle.accept({ user: { id: "operator", name: "Operator", role: "admin" }, csrfToken: "" });
    lifecycle.commit(lifecycle.getSnapshot().generation);
    const remove = installSessionTransport(lifecycle);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (value: Output | null) => <QueryClientProvider client={client}>
      <UIProviders><AccessSubscription output={value} onClose={() => {}} /></UIProviders>
    </QueryClientProvider>;
    try {
      const ui = render(view(output));
      const button = await screen.findByRole("button", { name: "下载配置与规则文件" });
      await userEvent.click(button);
      await waitFor(() => expect(started).toBe(true));
      await userEvent.click(button);
      expect(f.downloads).toHaveLength(1);
      await act(async () => {
        if (change === "token ABA") { setToken("synthetic-other"); setToken("synthetic-operator"); }
        if (change === "account") {
          lifecycle.accept({ user: { id: "other", name: "Other", role: "admin" }, csrfToken: "" });
          lifecycle.commit(lifecycle.getSnapshot().generation);
        }
        if (change === "close") ui.rerender(view(null));
        if (change === "direct unmount") ui.unmount();
        if (change === "revision") ui.rerender(view({ ...output, revision: "new-revision" }));
      });
      await act(async () => { finish(new Blob(["synthetic bytes"])); });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.saves).toEqual([]);
    } finally { remove(); }
  },
);
it("keeps uncertain rotation distinct from confirmed rotation for bundles", async () => {
  setToken("");
  fixture();
  mount(<AccessSubscription output={output} onClose={() => {}} replacement rotationUncertain />);
  await screen.findByRole("link", { name: "下载配置与规则文件" });
  expect(screen.getByText(/不能确认上次更换是否完成/)).toBeTruthy();
  expect(screen.queryByText(/配置包内容不变，无需因此重新导入/)).toBeNull();
});
it.each(["network", "unauthorized", "wrong media type", "body failure"])(
  "offers retry without a download when the bundle has %s", async (failure) => {
    setToken("synthetic-operator");
    const f = fixture(failure === "body failure" ? async () => { throw new Error("synthetic body interruption"); } : undefined, failure);
    mount(<AccessSubscription output={output} onClose={() => {}} />);
    const button = await screen.findByRole("button", { name: "下载配置与规则文件" });
    await userEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.saves).toEqual([]);
    await userEvent.click(button);
    await waitFor(() => expect(f.downloads).toHaveLength(2));
  },
);

it("does not revive a pending download after entering and cancelling nested review", async () => {
  setToken("synthetic-operator");
  let finish!: (value: Blob) => void;
  let started = false;
  const f = fixture(() => {
    started = true;
    return new Promise<Blob>((resolve) => { finish = resolve; });
  });
  // A server readiness change arrives through the normal reconnect refetch.
  const bundleFetch = globalThis.fetch;
  let republishRequired = false;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).endsWith("/access") && republishRequired)
      return json({ code: "OUTPUT_REPUBLISH_REQUIRED" }, 409);
    if (String(url).endsWith("/preview"))
      return json({ error: "synthetic preview unavailable" }, 503);
    return bundleFetch(url, init);
  }));
  mount(<AccessSubscription output={output} onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: "下载配置与规则文件" }));
  await waitFor(() => expect(started).toBe(true));
  republishRequired = true;
  act(() => onlineManager.setOnline(false));
  act(() => onlineManager.setOnline(true));
  await userEvent.click(await screen.findByRole("button", { name: "检查更新" }));
  const review = await screen.findByRole("dialog", { name: "检查订阅更新「Phone」" });
  await userEvent.click(within(review).getByRole("button", { name: "取消" }));
  const returned = await screen.findByRole("dialog", { name: "获取「Phone」" });
  await within(returned).findByRole("button", { name: "检查更新" });
  await act(async () => { finish(new Blob(["synthetic bytes"])); });
  expect(f.create).not.toHaveBeenCalled();
  expect(f.saves).toEqual([]);
  expect(f.downloads).toHaveLength(1);
});

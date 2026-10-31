// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  cleanup,
  render,
  screen,
  within,
  waitFor,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// The rendered-box seam enables rc focusable selection in jsdom, not browser geometry.
it.each(["feed", "bundle"] as const)(
  "wraps the rendered %s access task around its native download link without activating it",
  async (delivery) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        let shown = true;
        for (
          let node: HTMLElement | null = this;
          node;
          node = node.parentElement
        ) {
          if (node.hidden || getComputedStyle(node).display === "none")
            shown = false;
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: shown ? 100 : 0,
          bottom: shown ? 40 : 0,
          width: shown ? 100 : 0,
          height: shown ? 40 : 0,
          toJSON() {
            return {};
          },
        };
      },
    );
    const output: Output = {
      id: "phone",
      name: "Phone",
      profileId: "shared",
      target: emptyProfile().target,
      mode: "full",
      status: "published",
      delivery,
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const method = init?.method || "GET";
        requests.push(`${method} ${String(url)}`);
        if (method !== "GET" || !String(url).endsWith("/phone/access"))
          throw new Error(`Unexpected request ${method} ${url}`);
        return json(
          delivery === "bundle"
            ? { delivery, downloadPath: "/bundles/synthetic.zip" }
            : { delivery, feedPath: "/feeds/synthetic" },
        );
      }),
    );
    const onClose = vi.fn();
    mount(<AccessSubscription output={output} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "获取「Phone」" });
    const download = await within(dialog).findByRole("link", {
      name: delivery === "bundle" ? "下载配置与规则文件" : "下载配置",
    });
    const activate = vi.fn();
    download.addEventListener("click", activate);
    const close = within(dialog).getByRole("button", { name: "关闭" });
    expect(close).toBeTruthy();
    download.focus();
    expect(fireEvent.keyDown(download, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(
      false,
    );
    expect(document.activeElement).toBe(download);
    expect(activate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(requests).toEqual(["GET /api/me/outputs/phone/access"]);
  },
);

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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

it.each(
  (["feed", "bundle"] as const).flatMap((delivery) =>
    [false, true].map((cached) => ({ delivery, cached })),
  ),
)(
  "keeps paused $delivery access explicit (cached=$cached) until the read resumes",
  async ({ delivery, cached }) => {
    const output: Output = {
      id: "phone",
      name: "Phone",
      profileId: "shared",
      target: emptyProfile().target,
      mode: "full",
      status: "published",
      delivery,
    };
    const requests: { path: string; method: string }[] = [];
    let finishAccess!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({ path: String(url), method: init?.method || "GET" });
        return new Promise<Response>((resolve) => {
          finishAccess = resolve;
        });
      }),
    );
    function Task() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>获取订阅</button>
          <AccessSubscription
            output={open ? output : null}
            replacement="publication"
            onClose={() => setOpen(false)}
          />
        </>
      );
    }
    // Opposite delivery in old cached data must not override the completed operation's metadata.
    mount(
      <Task />,
      cached
        ? {
            id: output.id,
            access:
              delivery === "bundle"
                ? { delivery: "feed", feedPath: "/feeds/obsolete" }
                : { delivery: "bundle", downloadPath: "/bundles/obsolete.zip" },
          }
        : undefined,
    );
    act(() => window.dispatchEvent(new Event("offline")));
    await userEvent.click(screen.getByRole("button", { name: "获取订阅" }));
    const dialog = await screen.findByRole("dialog", { name: "获取「Phone」" });
    expect(await within(dialog).findByText("当前离线")).toBeTruthy();
    expect(within(dialog).getByText("恢复网络后会继续获取订阅。")).toBeTruthy();
    expect(
      within(dialog).queryByRole("textbox", { name: "订阅链接" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("link", { name: "下载配置与规则文件" }),
    ).toBeNull();
    expect(within(dialog).queryByLabelText("正在加载")).toBeNull();
    expect(requests).toEqual([]);
    expect(
      within(dialog).getByText(
        delivery === "bundle"
          ? /重新下载配置包并导入客户端/
          : /将新链接重新添加到客户端/,
      ),
    ).toBeTruthy();
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() =>
      expect(requests).toEqual([
        { path: "/api/me/outputs/phone/access", method: "GET" },
      ]),
    );
    expect(
      within(dialog).queryByRole("textbox", { name: "订阅链接" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("link", { name: "下载配置与规则文件" }),
    ).toBeNull();
    await act(async () =>
      finishAccess(
        json(
          delivery === "bundle"
            ? { delivery, downloadPath: "/bundles/current.zip" }
            : { delivery, feedPath: "/feeds/current" },
        ),
      ),
    );
    if (delivery === "bundle")
      expect(
        (
          await within(dialog).findByRole("link", {
            name: "下载配置与规则文件",
          })
        ).getAttribute("href"),
      ).toBe("/api/me/outputs/phone/bundle");
    else
      expect(
        (
          (await within(dialog).findByRole("textbox", {
            name: "订阅链接",
          })) as HTMLInputElement
        ).value,
      ).toContain("/feeds/current");
    expect(within(dialog).queryByText("当前离线")).toBeNull();
    expect(requests).toHaveLength(1);
  },
);

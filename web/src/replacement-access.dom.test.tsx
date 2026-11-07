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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ProfileEditor } from "./Profiles";
import type { Output } from "./types";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
function mount(node: ReactNode, staleTime = 0) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
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
  ["workspace", "editor"].flatMap((entry) =>
    ["feed", "bundle"].map((delivery) => ({ entry, delivery })),
  ),
)(
  "opens the exact restored $entry $delivery subscription and retries access without publishing again",
  async ({ entry, delivery }) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const links: Output[] = ["Laptop", "Phone"].map((name, i) => ({
      id: `link-${i}`,
      name,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: i ? "revoked" : "published",
      delivery: delivery as "feed" | "bundle",
    }));
    const writes: string[] = [],
      reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push(path);
          if (path.endsWith("/preview"))
            return json({
              valid: true,
              previewDigest: "a".repeat(64),
              outputId: "link-1",
              previewScope: "output-update",
              publicationEffect: { version: 1, link: "replace" },
              artifacts: [],
            });
          if (path.endsWith("/link-1/publish"))
            return json({ ...links[1], status: "published" });
          throw new Error(`Unexpected write ${path}`);
        }
        if (path.endsWith("/access")) {
          reads.push(path);
          return reads.length === 1
            ? json({ error: "Access temporarily unavailable" }, 503)
            : json(
                delivery === "bundle"
                  ? {
                      delivery: "bundle",
                      downloadPath: "/bundles/replacement-phone.zip",
                    }
                  : { feedPath: "/feeds/replacement-phone" },
              );
        }
        if (path.endsWith("/outputs")) return json(links);
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        return json([]);
      }),
    );
    if (entry === "workspace") {
      mount(<SubscriptionsPage />);
      await userEvent.click(
        await screen.findByRole("button", { name: "检查重新发布" }),
      );
    } else {
      mount(
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={links[0]}
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "检查发布" }));
      const chooser = await screen.findByRole("dialog", {
        name: "选择客户端订阅",
      });
      await userEvent.click(
        await within(chooser).findByRole("radio", { name: /Phone/ }),
      );
      await userEvent.click(
        within(chooser).getByRole("button", { name: "检查所选订阅" }),
      );
    }
    const review = await screen.findByRole("dialog", {
      name: "检查订阅更新「Phone」",
    });
    const publish = within(review).getByRole("button", {
      name: "重新发布并生成新链接「Phone」",
    });
    await waitFor(() =>
      expect((publish as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(publish);
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    if (delivery === "bundle") {
      expect(
        within(access).getByText(/重新下载配置包并导入客户端/),
      ).toBeTruthy();
      expect(within(access).queryByText(/配置包内容不变/)).toBeNull();
      expect(within(access).queryByText(/将新链接重新添加/)).toBeNull();
    } else expect(within(access).getByText(/旧链接已失效/)).toBeTruthy();
    await userEvent.click(
      await within(access).findByRole("button", { name: /重试/ }),
    );
    if (delivery === "bundle") {
      expect(
        (
          await within(access).findByRole("link", {
            name: "下载配置与规则文件",
          })
        ).getAttribute("href"),
      ).toBe("/api/me/outputs/link-1/bundle");
      expect(
        within(access).queryByRole("textbox", { name: "订阅链接" }),
      ).toBeNull();
    } else {
      expect(
        (
          (await within(access).findByRole("textbox", {
            name: "订阅链接",
          })) as HTMLInputElement
        ).value,
      ).toContain("/feeds/replacement-phone");
    }
    expect(reads).toEqual([
      "/api/me/outputs/link-1/access",
      "/api/me/outputs/link-1/access",
    ]);
    expect(writes).toEqual([
      "/api/me/profiles/shared/preview",
      "/api/me/outputs/link-1/publish",
    ]);
  },
);

it.each(["feed", "bundle"])(
  "opens a rotated %s for the exact subscription; cancel and access retries never rotate again",
  async (delivery) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const links: Output[] = ["Laptop", "Phone"].map((name, i) => ({
      id: `link-${i}`,
      name,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    }));
    const writes: string[] = [],
      reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push(path);
          if (path.endsWith("/link-1/rotate")) return json(links[1]);
          throw new Error(`Unexpected write ${path}`);
        }
        if (path.endsWith("/access")) {
          reads.push(path);
          return reads.length === 1
            ? json({ error: "Access temporarily unavailable" }, 503)
            : json(
                delivery === "bundle"
                  ? {
                      delivery: "bundle",
                      downloadPath: "/bundles/rotated-phone.zip",
                    }
                  : { delivery: "feed", feedPath: "/feeds/rotated-phone" },
              );
        }
        if (path.endsWith("/outputs")) return json(links);
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        if (path.endsWith("/link-1/status")) return json(links[1]);
        return json([]);
      }),
    );
    mount(<SubscriptionsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "查看订阅 Phone" }),
    );
    const openRotation = async () => {
      await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "更换订阅链接" }),
      );
      return screen.findByRole("alertdialog", {
        name: "更换「Phone」的订阅链接？",
      });
    };
    let confirmation = await openRotation();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "保留旧链接" }),
    );
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
    confirmation = await openRotation();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "更换链接" }),
    );
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    expect(within(access).getByText(/旧链接已失效/)).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Phone 的订阅详情" }),
    ).toBeNull();
    await userEvent.click(
      await within(access).findByRole("button", { name: /重试/ }),
    );
    if (delivery === "bundle") {
      expect(
        (
          await within(access).findByRole("link", {
            name: "下载配置与规则文件",
          })
        ).getAttribute("href"),
      ).toBe("/api/me/outputs/link-1/bundle");
      expect(
        within(access).getByText(/配置包内容不变，无需因此重新导入/),
      ).toBeTruthy();
      expect(within(access).queryByText(/将新链接重新添加/)).toBeNull();
      expect(
        within(access).queryByRole("textbox", { name: "订阅链接" }),
      ).toBeNull();
    } else {
      expect(
        (
          (await within(access).findByRole("textbox", {
            name: "订阅链接",
          })) as HTMLInputElement
        ).value,
      ).toContain("/feeds/rotated-phone");
    }
    expect(reads).toEqual([
      "/api/me/outputs/link-1/access",
      "/api/me/outputs/link-1/access",
    ]);
    expect(writes).toEqual(["/api/me/outputs/link-1/rotate"]);
    await userEvent.click(within(access).getByRole("button", { name: "关闭" }));
    expect(
      await screen.findByRole("dialog", { name: "Phone 的订阅详情" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "获取「Phone」" })).toBeNull();
  },
);

it("does not reopen replacement access after accepted navigation while rotation is pending", async () => {
  const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
  const output: Output = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  let finishRotation!: (response: Response) => void;
  const accessReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST" && path.endsWith("/rotate"))
        return new Promise<Response>((resolve) => {
          finishRotation = resolve;
        });
      if (path.endsWith("/access")) {
        accessReads.push(path);
        return json({ feedPath: "/feeds/new-phone" });
      }
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/status")) return json(output);
      return json([]);
    }),
  );
  mount(<SubscriptionsPage />);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Phone" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "更换订阅链接" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "更换「Phone」的订阅链接？",
  });
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "更换链接" }),
  );
  await waitFor(() => expect(finishRotation).toBeTypeOf("function"));
  location.hash = "#subscriptions?profile=shared";
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Phone 的订阅详情" }),
    ).toBeNull(),
  );
  finishRotation(json(output));
  await waitFor(() =>
    expect(
      screen.queryByRole("alertdialog", { name: "更换「Phone」的订阅链接？" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("dialog", { name: "获取「Phone」" })).toBeNull();
  expect(accessReads).toEqual([]);
});

it.each(["workspace", "editor"])(
  "does not reopen %s replacement access after leaving a pending republish",
  async (entry) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const output: Output = {
      id: "phone",
      name: "Phone",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "revoked",
    };
    let finishPublish!: (response: Response) => void;
    let restored = false;
    const accessReads: string[] = [],
      writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push(path);
          if (path.endsWith("/preview"))
            return json({
              valid: true,
              previewDigest: "a".repeat(64),
              outputId: "phone",
              previewScope: "output-update",
              publicationEffect: { version: 1, link: "replace" },
              artifacts: [],
            });
          if (path.endsWith("/publish"))
            return new Promise<Response>((resolve) => {
              finishPublish = resolve;
            });
          throw new Error(`Unexpected write ${path}`);
        }
        if (path.endsWith("/access")) {
          accessReads.push(path);
          return json({ feedPath: "/feeds/new-phone" });
        }
        if (path.endsWith("/outputs"))
          return json([
            { ...output, status: restored ? "published" : "revoked" },
          ]);
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/reveal")) return json(profile);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        if (path.endsWith("/status")) return json(output);
        return json([]);
      }),
    );
    mount(<SubscriptionsPage />);
    if (entry === "workspace") {
      await userEvent.click(
        await screen.findByRole("button", { name: "检查重新发布" }),
      );
    } else {
      await userEvent.click(
        await screen.findByRole("button", { name: "查看订阅 Phone" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "编辑关联分流配置" }),
      );
      await userEvent.click(
        await screen.findByRole("button", { name: "检查发布" }),
      );
      const chooser = await screen.findByRole("dialog", {
        name: "选择客户端订阅",
      });
      const inspect = within(chooser).getByRole("button", {
        name: "检查所选订阅",
      });
      await waitFor(() =>
        expect((inspect as HTMLButtonElement).disabled).toBe(false),
      );
      await userEvent.click(inspect);
    }
    const review = await screen.findByRole("dialog", {
      name: "检查订阅更新「Phone」",
    });
    const publish = within(review).getByRole("button", {
      name: "重新发布并生成新链接「Phone」",
    });
    await waitFor(() =>
      expect((publish as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(publish);
    await waitFor(() => expect(finishPublish).toBeTypeOf("function"));
    location.hash = "#subscriptions?profile=shared";
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "检查订阅更新「Phone」" }),
      ).toBeNull(),
    );
    await act(async () => {
      restored = true;
      finishPublish(json({ ...output, status: "published" }));
    });
    expect(
      await screen.findByRole("button", { name: "检查更新" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "获取「Phone」" })).toBeNull();
    expect(accessReads).toEqual([]);
    expect(writes).toEqual([
      "/api/me/profiles/shared/preview",
      "/api/me/outputs/phone/publish",
    ]);
  },
);

it.each(
  ["workspace", "editor"].map((entry) => ({ entry, delivery: "bundle" })),
)(
  "opens the exact normally updated $entry $delivery subscription and retries access without publishing again",
  async ({ entry, delivery }) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const links: Output[] = ["Laptop", "Phone"].map((name, i) => ({
      id: `link-${i}`,
      name,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
      delivery: delivery as "feed" | "bundle",
    }));
    const writes: string[] = [],
      reads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push(path);
          if (path.endsWith("/preview"))
            return json({
              valid: true,
              previewDigest: "a".repeat(64),
              outputId: "link-1",
              previewScope: "output-update",
              publicationEffect: { version: 1, link: "preserve" },
              artifacts: [],
            });
          if (path.endsWith("/link-1/publish"))
            return json({ ...links[1], status: "published" });
          throw new Error(`Unexpected write ${path}`);
        }
        if (path.endsWith("/access")) {
          reads.push(path);
          return reads.length === 1
            ? json({ error: "Access temporarily unavailable" }, 503)
            : json(
                delivery === "bundle"
                  ? {
                      delivery: "bundle",
                      downloadPath: "/bundles/replacement-phone.zip",
                    }
                  : { feedPath: "/feeds/replacement-phone" },
              );
        }
        if (path.endsWith("/outputs")) return json(links);
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/link-1/status")) return json(links[1]);
        if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
        return json([]);
      }),
    );
    if (entry === "workspace") {
      mount(<SubscriptionsPage />);
      await userEvent.click(
        await screen.findByRole("button", { name: "查看订阅 Phone" }),
      );
      const detail = await screen.findByRole("dialog", {
        name: "Phone 的订阅详情",
      });
      await userEvent.click(
        within(detail).getByRole("button", { name: "检查更新" }),
      );
    } else {
      mount(
        <ProfileEditor
          initial={profile}
          isNew={false}
          output={links[0]}
          onClose={() => {}}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "检查发布" }));
      const chooser = await screen.findByRole("dialog", {
        name: "选择客户端订阅",
      });
      await userEvent.click(
        await within(chooser).findByRole("radio", { name: /Phone/ }),
      );
      await userEvent.click(
        within(chooser).getByRole("button", { name: "检查所选订阅" }),
      );
    }
    const review = await screen.findByRole("dialog", {
      name: "检查订阅更新「Phone」",
    });
    const publish = within(review).getByRole("button", {
      name: "确认更新「Phone」",
    });
    await waitFor(() =>
      expect((publish as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(publish);
    const access = await screen.findByRole("dialog", { name: "获取「Phone」" });
    expect(within(access).queryByText(/旧.*链接已失效/)).toBeNull();
    await userEvent.click(
      await within(access).findByRole("button", { name: /重试/ }),
    );
    if (delivery === "bundle") {
      expect(
        (
          await within(access).findByRole("link", {
            name: "下载配置与规则文件",
          })
        ).getAttribute("href"),
      ).toBe("/api/me/outputs/link-1/bundle");
      expect(
        within(access).queryByRole("textbox", { name: "订阅链接" }),
      ).toBeNull();
    } else {
      expect(
        (
          (await within(access).findByRole("textbox", {
            name: "订阅链接",
          })) as HTMLInputElement
        ).value,
      ).toContain("/feeds/replacement-phone");
    }
    expect(reads).toEqual([
      "/api/me/outputs/link-1/access",
      "/api/me/outputs/link-1/access",
    ]);
    expect(writes).toEqual([
      "/api/me/profiles/shared/preview",
      "/api/me/outputs/link-1/publish",
    ]);
  },
);

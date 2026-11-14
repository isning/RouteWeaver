// @vitest-environment jsdom
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { abortDOMDiagnostics } from "./test-support/abort-dom-diagnostics";
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
import Workspace from "./App";
import {
  SubscriptionsPage,
  PublishOutput,
  UpdateOutput,
} from "./Subscriptions";
import { emptyProfile } from "./model";
const clients: QueryClient[] = [];
function mount(node: ReactNode, staleTime = 0) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime },
      mutations: { retry: false },
    },
  });
  clients.push(client);
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("requires an explicit client link when editing an unbound shared configuration", async () => {
  const writes: string[] = [];
  const profile = {
    ...emptyProfile(),
    id: "shared",
    name: "Shared configuration",
  };
  const outputs = ["Laptop", "Phone"].map((name, i) => ({
    id: `output-${i}`,
    name,
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") writes.push(String(url));
      return new Response(
        JSON.stringify(String(url).endsWith("/outputs") ? outputs : []),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  mount(<ProfileEditor initial={profile} isNew={false} onClose={() => {}} />);
  await userEvent.click(
    await screen.findByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "选择客户端订阅",
  });
  expect(within(dialog).getByRole("radio", { name: /Laptop/ })).toBeTruthy();
  expect(within(dialog).getByRole("radio", { name: /Phone/ })).toBeTruthy();
  expect(
    within(dialog).getByRole("radio", { name: "创建新的客户端订阅" }),
  ).toBeTruthy();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "检查所选订阅",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(writes).toEqual([]);
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const overview = { user: {}, routes: [] };

it("returns a canceled link decision to its persistent menu trigger and supports keyboard reopening", async () => {
  const profile = { ...emptyProfile(), id: "shared", name: "Shared routing" };
  const output = {
    id: "phone",
    name: "Phone",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
    accessRevision: "synthetic-opened-revision",
  };
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method && init.method !== "GET") writes.push(path);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/profiles")) return json([profile]);
      return json([]);
    }),
  );
  mount(<SubscriptionsPage view="outputs" />);
  const trigger = await screen.findByRole("button", {
    name: "管理 Phone",
  });
  const user = userEvent.setup();
  trigger.focus();
  for (let attempt = 0; attempt < 2; attempt++) {
    await user.keyboard("{Enter}");
    const first = await screen.findByRole("menuitem", {
      name: "查看已发布内容",
    });
    await waitFor(() => expect(document.activeElement).toBe(first));
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "编辑关联分流配置" }),
      ),
    );
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "更换订阅链接" }),
      ),
    );
    await user.keyboard("{Enter}");
    const decision = await screen.findByRole("alertdialog", {
      name: "更换「Phone」的订阅链接？",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(decision).getByRole("button", {
          name: "保留旧链接",
        }),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
  expect(writes).toEqual([]);
});
it.each([false, true])(
  "updates only the chosen link regardless of entry binding (%s)",
  async (bound) => {
    const profile = {
      ...emptyProfile(),
      id: "shared",
      name: "Shared configuration",
    };
    const links: Output[] = [
      {
        id: "laptop",
        name: "Laptop",
        profileId: profile.id,
        target: profile.target,
        mode: "full",
        status: "published",
      },
      {
        id: "phone",
        name: "Phone",
        profileId: profile.id,
        target: { adapterId: "sing-box", version: "1.14.3" },
        mode: "nodes-only",
        status: "published",
      },
    ];
    const writes: { path: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          const body = JSON.parse(init.body);
          writes.push({ path, body });
          if (path.endsWith("/preview"))
            return json({
              valid: true,
              previewDigest: "a".repeat(64),
              previewScope: "output-update",
              publicationEffect: { version: 1, link: "preserve" },
              outputId: "phone",
              artifacts: [{ path: "config.json", content: "phone candidate" }],
            });
          if (path.endsWith("/phone/publish")) return json(links[1]);
          throw new Error(`Unexpected write ${path}`);
        }
        return json(path.endsWith("/outputs") ? links : []);
      }),
    );
    mount(
      <ProfileEditor
        initial={profile}
        isNew={false}
        output={bound ? links[0] : undefined}
        onClose={() => {}}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^(保存并检查|检查发布)$/ }),
    );
    const choose = await screen.findByRole("dialog", {
      name: "选择客户端订阅",
    });
    await userEvent.click(
      within(choose).getByRole("radio", { name: /更新「Phone」/ }),
    );
    await userEvent.click(
      within(choose).getByRole("button", { name: "检查所选订阅" }),
    );
    const review = await screen.findByRole("dialog", {
      name: "检查订阅更新「Phone」",
    });
    await userEvent.click(
      await within(review).findByRole("button", {
        name: "查看待发布技术配置",
      }),
    );
    await within(review).findByText("phone candidate");
    expect(review.textContent).toContain("sing-box");
    expect(review.textContent).toContain("纯节点");
    await userEvent.click(
      within(review).getByRole("button", { name: "确认更新「Phone」" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes).toEqual([
      {
        path: "/api/me/profiles/shared/preview",
        body: {
          outputId: "phone",
          target: links[1].target,
          mode: "nodes-only",
        },
      },
      {
        path: "/api/me/outputs/phone/publish",
        body: { previewDigest: "a".repeat(64) },
      },
    ]);
  },
);

it("keeps a failed save in the editor and never advances to publication", async () => {
  const profile = { ...emptyProfile(), name: "Keep my draft" };
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push({ path: String(url), body: JSON.parse(init.body) });
        return json({ error: "Draft save failed" }, 422);
      }
      return json([]);
    }),
  );
  mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "配置名称" }), {
    target: { value: "My unsaved choice" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  await screen.findByText("Draft save failed");
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("My unsaved choice");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toBe("/api/me/profiles");
  expect(writes[0].body.id).toBe(profile.id);
});

it("keeps unpublished configurations and revoked links visible without conflating them", async () => {
  const draft = { ...emptyProfile(), id: "draft", name: "Never published" };
  const reused = { ...emptyProfile(), id: "reused", name: "Previously used" };
  const revoked: Output = {
    id: "retired",
    name: "Retired phone",
    profileId: reused.id,
    target: reused.target,
    mode: "full",
    status: "revoked",
  };
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/profiles")) return json([draft, reused]);
      if (path.endsWith("/outputs")) return json([revoked]);
      if (path.endsWith("/draft/reveal")) return json(draft);
      return json([]);
    }),
  );
  mount(<SubscriptionsPage />);
  const row = await screen.findByRole("article", {
    name: "分流配置 Never published",
  });
  expect(within(row).getByText(/尚未关联客户端订阅/)).toBeTruthy();
  const other = screen.getByRole("article", {
    name: "分流配置 Previously used",
  });
  expect(within(other).getByText("Retired phone")).toBeTruthy();
  expect(within(other).queryByText(/尚未关联客户端订阅/)).toBeNull();
  expect(
    (
      within(other).getByRole("button", {
        name: "获取订阅",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(within(row).getByRole("button", { name: "继续配置" }));
  await screen.findByRole("textbox", { name: "配置名称" });
  expect(paths).toContain("/api/me/profiles/draft/reveal");
});

for (const page of ["profiles", "outputs"]) {
  it(
    `preserves configuration scope on legacy #${page} links and workspace view changes`,
    async (context) => {
      const scenario = ownedClickScenario(context);
      const mark = abortDOMDiagnostics(context);
      mark("start");
      history.replaceState(null, "", `#${page}?profile=one`);
      const profiles = ["one", "two"].map((id) => ({
        ...emptyProfile(),
        id,
        name: `Configuration ${id}`,
      }));
      const links = profiles.map((profile) => ({
        id: `link-${profile.id}`,
        name: `Link ${profile.id}`,
        profileId: profile.id,
        target: profile.target,
        mode: "full",
        status: "published",
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
          const path = String(url);
          if (path.endsWith("/auth/me"))
            return json({ user: { role: "member", name: "Member" } });
          if (path.endsWith("/overview")) return json(overview);
          if (path.endsWith("/profiles")) return json(profiles);
          if (path.endsWith("/outputs")) return json(links);
          return json([]);
        }),
      );
      mount(<Workspace />);
      mark("mounted");
      await screen.findByRole("heading", { name: "我的订阅" });
      scenario.assertActive();
      mark("heading-ready");
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(
        await screen.findByRole("article", {
          name: "分流配置 Configuration one",
        }),
      ).toBeTruthy();
      expect(await screen.findByText("Link one", { exact: true })).toBeTruthy();
      expect(screen.queryByText("Link two", { exact: true })).toBeNull();
      await scenario.click(() => screen.getByRole("button", { name: "查看订阅 Link one" }));
      mark("detail-click-completed");
      const detail = await screen.findByRole("dialog", {
        name: "Link one 的订阅详情",
      });
      scenario.assertActive();
      expect(location.hash).toContain("profile=one");
      await scenario.click(() => within(detail).getByRole("button", { name: "关闭" }));
      mark("detail-close-completed");
      scenario.assertActive();
      expect(location.hash).toContain("profile=one");
      expect(screen.queryByText("Link two", { exact: true })).toBeNull();
      // Wait for the closing modal scope to release background accessibility.
      const navigation = await screen.findByRole("navigation", {
        name: "工作空间导航",
      });
      scenario.assertActive();
      mark("navigation-released");
      expect(
        within(navigation).queryByRole("button", { name: "客户端配置" }),
      ).toBeNull();
      expect(
        within(navigation).queryByRole("button", { name: "发布管理" }),
      ).toBeNull();
      expect(
        within(navigation)
          .getByRole("button", { name: "我的订阅" })
          .getAttribute("aria-current"),
      ).toBe("page");
    },
  );

}

it("does not silently replace an unavailable output deep link with another publication", async () => {
  history.replaceState(null, "", "#subscriptions?output=missing");
  const profile = {
    ...emptyProfile(),
    id: "other",
    name: "Other configuration",
  };
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs"))
        return json([
          {
            id: "unrelated",
            profileId: profile.id,
            name: "Unrelated",
            target: profile.target,
            status: "published",
          },
        ]);
      return json([]);
    }),
  );
  mount(<SubscriptionsPage />);
  await screen.findByText("所选客户端订阅不在当前可访问范围");
  expect(screen.queryByRole("region", { name: "已发布分流" })).toBeNull();
  expect(paths.some((path) => path.includes("/unrelated/status"))).toBe(false);
});

it("adds a source directly to the unsaved selection without saving or publishing the configuration", async () => {
  const profile = { ...emptyProfile(), name: "Local work" };
  let source: any;
  const writes: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        writes.push({ path, body });
        if (path.endsWith("/sources")) {
          source = {
            ...body,
            snapshot: {
              endpoints: [
                { id: "node", name: "Node", connection: { protocol: "socks" } },
              ],
            },
          };
          return json(source);
        }
        if (path.endsWith("/collections/preview"))
          return json({ endpoints: source.snapshot.endpoints });
        throw new Error(`Unexpected write ${path}`);
      }
      return json(path.endsWith("/sources") && source ? [source] : []);
    }),
  );
  mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "添加来源" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "添加订阅来源" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    within(dialog).queryByRole("heading", { name: "订阅来源" }),
  ).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("来源名称"), {
    target: { value: "My airport" },
  });
  fireEvent.change(within(dialog).getByLabelText("节点链接或配置内容"), {
    target: { value: "socks5://proxy.example.com:1080" },
  });
  await userEvent.click(
    within(dialog).getByRole("button", { name: "导入来源" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("combobox", { name: "使用的订阅来源" })).toBeTruthy();
  const sourceField = screen
    .getByRole("combobox", { name: "使用的订阅来源" })
    .closest("label")!;
  expect(
    await within(sourceField).findByText("My airport", { exact: true }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Local work");
  expect(writes.filter((write) => /profiles|outputs/.test(write.path))).toEqual(
    [],
  );
  expect(
    writes.filter((write) => write.path.endsWith("/sources")),
  ).toHaveLength(1);
});

it.each(["missing", "wrong-profile"])(
  "does not resurrect a %s preferred output from stale entry context",
  async (kind) => {
    const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
    const stale = {
      id: "old",
      name: "Old link",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    } as Output;
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (init?.method === "POST") writes.push(String(url));
        return json(
          String(url).endsWith("/outputs") && kind === "wrong-profile"
            ? [{ ...stale, profileId: "other" }]
            : [],
        );
      }),
    );
    mount(
      <ProfileEditor
        initial={profile}
        isNew={false}
        output={stale}
        onClose={() => {}}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "选择客户端订阅",
    });
    await within(dialog).findByText("「Old link」已不在此配置的订阅列表中");
    expect(
      within(dialog).queryByRole("radio", { name: /更新「Old link」/ }),
    ).toBeNull();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "检查所选订阅",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(writes).toEqual([]);
  },
);

it("uses fresh target and mode for a preselected output, including revoked access consequences", async () => {
  const profile = { ...emptyProfile(), id: "shared", name: "Shared" };
  const stale = {
    id: "link",
    name: "Old name",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  } as Output;
  const fresh = {
    ...stale,
    name: "Retired phone",
    target: { adapterId: "sing-box", version: "1.14.3" },
    mode: "nodes-only",
    status: "revoked",
  };
  const writes: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        writes.push({ path: String(url), body: JSON.parse(init.body) });
        return json({
          valid: true,
          previewDigest: "a".repeat(64),
          outputId: fresh.id,
          previewScope: "output-update",
          publicationEffect: { version: 1, link: "replace" },
          artifacts: [{ path: "config", content: "fresh candidate" }],
        });
      }
      return json(String(url).endsWith("/outputs") ? [fresh] : []);
    }),
  );
  mount(
    <ProfileEditor
      initial={profile}
      isNew={false}
      output={stale}
      onClose={() => {}}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  const chooser = await screen.findByRole("dialog", {
    name: "选择客户端订阅",
  });
  expect(
    (
      within(chooser).getByRole("radio", {
        name: /Retired phone/,
      }) as HTMLInputElement
    ).getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(
    within(chooser).getByRole("button", { name: "检查所选订阅" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Retired phone」",
  });
  await userEvent.click(
    await within(review).findByRole("button", { name: "查看待发布技术配置" }),
  );
  await within(review).findByText("fresh candidate");
  expect(review.textContent).toContain(
    "发布后请在客户端换用新链接，其他订阅保留原状。",
  );
  expect(
    within(review).getByRole("button", {
      name: "重新发布并生成新链接「Retired phone」",
    }),
  ).toBeTruthy();
  expect(writes).toEqual([
    {
      path: "/api/me/profiles/shared/preview",
      body: { outputId: "link", target: fresh.target, mode: "nodes-only" },
    },
  ]);
});

it("retains an orphaned frozen link for access and lifecycle management without offering replacement-profile edits", async () => {
  const profile = emptyProfile();
  const orphan = {
    id: "orphan",
    name: "Preserved link",
    profileId: "removed",
    target: profile.target,
    mode: "full",
    status: "published",
  };
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/outputs")) return json([orphan]);
      if (path.endsWith("/access"))
        return json({ delivery: "bundle", downloadPath: "/frozen.zip" });
      return json([]);
    }),
  );
  mount(<SubscriptionsPage view="outputs" />);
  const row = await screen.findByRole("row", {
    name: "客户端订阅 Preserved link",
  });
  expect(
    screen.getByRole("article", { name: "关联配置不可用 removed" }),
  ).toBeTruthy();
  await userEvent.click(within(row).getByRole("button", { name: "获取订阅" }));
  const access = await screen.findByRole("dialog", {
    name: "获取「Preserved link」",
  });
  expect(
    await within(access).findByRole("link", { name: "下载配置与规则文件" }),
  ).toBeTruthy();
  await userEvent.click(within(access).getByRole("button", { name: "关闭" }));
  await userEvent.click(
    within(row).getByRole("button", { name: "管理 Preserved link" }),
  );
  const edit = await screen.findByRole("menuitem", {
    name: "编辑关联分流配置",
  });
  expect(edit.getAttribute("aria-disabled")).toBe("true");
  expect(
    screen
      .getByRole("menuitem", { name: "更换订阅链接" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
  expect(
    screen
      .getByRole("menuitem", { name: "撤销订阅" })
      .getAttribute("aria-disabled"),
  ).not.toBe("true");
  expect(paths.some((path) => path.endsWith("/reveal"))).toBe(false);
});

it("discloses save-before-check and keeps the one saved draft when publication is canceled", async () => {
  const profile = { ...emptyProfile(), name: "Draft to check" };
  const writes: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        writes.push({ path: String(url), body });
        return json(body);
      }
      return json([]);
    }),
  );
  mount(<ProfileEditor initial={profile} isNew onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "保存并检查" })).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  const publication = await screen.findByRole("dialog", {
    name: "新增客户端订阅",
  });
  await userEvent.click(
    within(publication).getByRole("button", { name: /^取\s*消$/ }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("草稿已保存")).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Draft to check");
  expect(screen.getByText("暂无关联订阅")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保存并检查" })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
  );
  await screen.findByRole("dialog", { name: "新增客户端订阅" });
  expect(writes.map((write) => write.path)).toEqual(["/api/me/profiles"]);
  expect(writes[0].body.id).toBe(profile.id);
});

it.each([
  { destination: "#sources", accept: false },
  { destination: "#profiles?profile=two&output=link-two", accept: false },
  { destination: "#profiles?profile=two&output=link-two", accept: true },
])(
  "preserves scope and drafts until hash navigation to $destination is explicitly accepted ($accept)",
  async ({ destination, accept }) => {
    const original = "#profiles?profile=one&output=link-one";
    history.replaceState(null, "", original);
    const profiles = ["one", "two"].map((id) => ({
      ...emptyProfile(),
      id,
      name: `Configuration ${id}`,
    }));
    const links = profiles.map((profile) => ({
      id: `link-${profile.id}`,
      name: `Link ${profile.id}`,
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const path = String(url);
        if (path.endsWith("/auth/me"))
          return json({ user: { role: "member", name: "Member" } });
        if (path.endsWith("/overview")) return json(overview);
        if (path.endsWith("/profiles")) return json(profiles);
        if (path.endsWith("/outputs")) return json(links);
        if (path.endsWith("/one/reveal")) return json(profiles[0]);
        return json([]);
      }),
    );
    mount(<Workspace />);
    await userEvent.click(
      await screen.findByRole("button", { name: "更多操作" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "编辑关联分流配置" }),
    );
    const name = await screen.findByRole("textbox", { name: "配置名称" });
    fireEvent.change(name, { target: { value: "Keep this unsaved edit" } });
    // Real jsdom location assignment dispatches a HashChangeEvent with oldURL/newURL.
    // Do not manually dispatch an incomplete event that could conceal lost query state.
    location.hash = destination;
    const confirmation = await screen.findByRole("alertdialog", {
      name: "放弃未保存的修改？",
    });
    if (accept) {
      await userEvent.click(
        within(confirmation).getByRole("button", { name: "放弃修改并离开" }),
      );
      expect(await screen.findByText("Link two", { exact: true })).toBeTruthy();
      expect(screen.queryByText("Link one", { exact: true })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
      expect(location.hash).toBe(destination);
      return;
    }
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "继续编辑" }),
    );
    expect(location.hash).toBe(original);
    expect(
      (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
        .value,
    ).toBe("Keep this unsaved edit");
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    const discard = await screen.findByRole("alertdialog", {
      name: "放弃未保存的修改？",
    });
    await userEvent.click(
      within(discard).getByRole("button", { name: "放弃修改" }),
    );
    expect(await screen.findByText("Link one", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Link two", { exact: true })).toBeNull();
    expect(location.hash).toBe(original);
    expect(
      screen.getByRole("dialog", { name: "Link one 的订阅详情" }),
    ).toBeTruthy();
  },
);

it("rechecks the selected frozen link immediately after saving, without claiming cached equality or checking other links", async () => {
  const profile = {
    ...emptyProfile(),
    id: "saved-profile",
    name: "Saved configuration",
  };
  const outputs = ["one", "two"].map((id) => ({
    id,
    name: `Link ${id}`,
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  }));
  const statusRequests: string[] = [];
  let saved = false;
  let resolveStatus!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/reveal")) return json(profile);
      if (init?.method === "PUT") {
        saved = true;
        return json(JSON.parse(init.body));
      }
      if (path.endsWith("/status")) {
        statusRequests.push(path);
        if (saved)
          return new Promise<Response>((resolve) => {
            resolveStatus = resolve;
          });
        return json({ ...outputs[0], draftComparison: { state: "unchanged" } });
      }
      return json([]);
    }),
  );
  mount(<SubscriptionsPage />, 15000);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Link one" }),
  );
  await screen.findByText("与已保存草稿一致");
  await userEvent.click(screen.getByRole("button", { name: "更多操作" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "编辑关联分流配置" }),
  );
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), {
    target: { value: "Saved changed configuration" },
  });
  await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存");
  expect(statusRequests).toEqual(["/api/me/outputs/one/status"]);
  await userEvent.click(screen.getByRole("button", { name: "返回" }));
  await waitFor(() => expect(statusRequests).toHaveLength(2));
  expect(screen.getByText("正在核对已保存的修改…")).toBeTruthy();
  expect(screen.queryByText("与已保存草稿一致")).toBeNull();
  resolveStatus(json({ ...outputs[0], draftComparison: { state: "changed" } }));
  await screen.findByText("已保存的修改尚未发布");
  expect(statusRequests).toEqual([
    "/api/me/outputs/one/status",
    "/api/me/outputs/one/status",
  ]);
});

it("rechecks dependencies on explicit detail reentry even within the normal cache freshness window", async () => {
  const profile = {
    ...emptyProfile(),
    id: "dependent-profile",
    name: "Dependent configuration",
  };
  const output = {
    id: "dependent",
    name: "Dependent link",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  let checks = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/status"))
        return json({
          ...output,
          draftComparison: { state: ++checks === 1 ? "unchanged" : "changed" },
        });
      return json([]);
    }),
  );
  mount(<SubscriptionsPage />, 15000);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Dependent link" }),
  );
  await screen.findByText("与已保存草稿一致");
  await userEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(checks).toBe(1);
  await userEvent.click(
    screen.getByRole("button", { name: "查看订阅 Dependent link" }),
  );
  await screen.findByText("已保存的修改尚未发布");
  expect(checks).toBe(2);
});

it("retains the scoped editor when immediate browser Back is canceled after selecting a detail", async () => {
  const original = "#subscriptions?profile=back-profile";
  const scopedProfiles = "#subscriptions?profile=back-profile&output=back-link";
  history.replaceState(null, "", "#sources");
  history.pushState(null, "", original);
  const profile = {
    ...emptyProfile(),
    id: "back-profile",
    name: "Back configuration",
  };
  const output = {
    id: "back-link",
    name: "Back link",
    profileId: profile.id,
    target: profile.target,
    mode: "full",
    status: "published",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/auth/me"))
        return json({ user: { role: "member", name: "Member" } });
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs")) return json([output]);
      if (path.endsWith("/reveal")) return json(profile);
      return json([]);
    }),
  );
  mount(<Workspace />);
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Back link" }),
  );
  expect(location.hash).toBe(scopedProfiles);
  await userEvent.click(
    await screen.findByRole("button", { name: "更多操作" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "编辑关联分流配置" }),
  );
  fireEvent.change(await screen.findByRole("textbox", { name: "配置名称" }), {
    target: { value: "Retain on browser Back" },
  });
  history.back();
  const confirmation = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  await userEvent.click(
    within(confirmation).getByRole("button", { name: "继续编辑" }),
  );
  expect(location.hash).toBe(scopedProfiles);
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("Retain on browser Back");
});

it.each(["revoked", "missing"])(
  "refreshes a %s preferred target despite a fresh outputs cache before allowing review",
  async (state) => {
    const profile = {
      ...emptyProfile(),
      id: "cached-profile",
      name: "Cached configuration",
    };
    const output = {
      id: "cached-link",
      name: "Cached link",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    };
    let outputReads = 0;
    let resolveOutputs!: (response: Response) => void;
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push(path);
          return json({
            valid: true,
            previewDigest: "a".repeat(64),
            outputId: output.id,
            previewScope: "output-update",
            publicationEffect: { version: 1, link: "replace" },
            artifacts: [{ path: "config.json", content: "reviewed" }],
          });
        }
        if (path.endsWith("/outputs")) {
          if (++outputReads === 1) return json([output]);
          return new Promise<Response>((resolve) => {
            resolveOutputs = resolve;
          });
        }
        return json([]);
      }),
    );
    mount(
      <ProfileEditor
        initial={profile}
        isNew={false}
        output={output}
        onClose={() => {}}
      />,
      15000,
    );
    const linked = (await screen.findByText("关联订阅（1）")).closest(
      "details",
    )!;
    const cachedLink = within(linked).getByText("Cached link").closest("li")!;
    expect(within(cachedLink).getByText("mihomo")).toBeTruthy();
    expect(within(cachedLink).getByText("完整配置")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /^(保存并检查|检查发布)$/ }),
    );
    const chooser = await screen.findByRole("dialog", {
      name: "选择客户端订阅",
    });
    await waitFor(() => expect(outputReads).toBe(2));
    expect(
      (
        within(chooser).getByRole("button", {
          name: "检查所选订阅",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(writes).toEqual([]);
    resolveOutputs(
      json(state === "missing" ? [] : [{ ...output, status: "revoked" }]),
    );
    if (state === "missing") {
      await within(chooser).findByText(
        "「Cached link」已不在此配置的订阅列表中",
      );
      expect(
        within(chooser).queryByRole("radio", { name: /更新「Cached link」/ }),
      ).toBeNull();
      expect(
        (
          within(chooser).getByRole("button", {
            name: "检查所选订阅",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(writes).toEqual([]);
    } else {
      await within(chooser).findByRole("radio", {
        name: /已撤销（需重新发布）/,
      });
      await userEvent.click(
        within(chooser).getByRole("button", { name: "检查所选订阅" }),
      );
      const review = await screen.findByRole("dialog", {
        name: "检查订阅更新「Cached link」",
      });
      expect(
        await within(review).findByRole("button", {
          name: "重新发布并生成新链接「Cached link」",
        }),
      ).toBeTruthy();
      expect(review.textContent).toContain(
        "发布后请在客户端换用新链接，其他订阅保留原状。",
      );
      expect(review.textContent).not.toContain("沿用当前链接");
    }
  },
);

it.each([true, false])(
  "uses an explicit known Profile scope for new links without inventing an unscoped target (%s)",
  async (scoped) => {
    const profile = {
      ...emptyProfile(),
      id: "scoped",
      name: "Scoped configuration",
    };
    if (scoped) history.replaceState(null, "", "#outputs?profile=scoped");
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") writes.push(path);
        if (path.endsWith("/overview")) return json(overview);
        if (path.endsWith("/profiles")) return json([profile]);
        return json([]);
      }),
    );
    mount(<SubscriptionsPage view="outputs" />);
    const parent = await screen.findByRole("article", {
      name: "分流配置 Scoped configuration",
    });
    await userEvent.click(
      within(parent).getByRole("button", {
        name: "为 Scoped configuration 新增客户端订阅",
      }),
    );
    const creation = await screen.findByRole("dialog", {
      name: "新增客户端订阅",
    });
    expect(within(creation).getByText("Scoped configuration")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "选择要发布的配置" }),
    ).toBeNull();
    expect(writes).toEqual([]);
  },
);

it.each(["create", "update"])(
  "keeps semantic %s review and final actions visible while technical artifacts are keyboard-expandable",
  async (mode) => {
    const profile = {
      ...emptyProfile(),
      id: "review-profile",
      name: "Review configuration",
    };
    const output = {
      id: "review-link",
      name: "Review link",
      profileId: profile.id,
      target: profile.target,
      mode: "full",
      status: "published",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        return json({
          valid: true,
          previewDigest: "a".repeat(64),
          previewScope: mode === "create" ? "new-output" : "output-update",
          outputId: mode === "create" ? body.id : body.outputId,
          ...(mode === "update"
            ? { publicationEffect: { version: 1, link: "preserve" } }
            : {}),
          diagnostics: ["Compatibility detail"],
          routingSummary: {
            version: 1,
            kind: "basic",
            chatGPT: { kind: "direct", label: "Candidate route" },
            default: { kind: "direct", label: "Direct" },
          },
          artifacts: [
            { path: "config.json", content: "Technical candidate content" },
          ],
        });
      }),
    );
    mount(
      mode === "create" ? (
        <PublishOutput profile={profile} onClose={() => {}} />
      ) : (
        <UpdateOutput output={output} onClose={() => {}} />
      ),
    );
    if (mode === "create")
      await waitFor(() =>
        expect(
          (screen.getByLabelText("订阅名称") as HTMLInputElement).value,
        ).toBe(profile.name),
      );
    await userEvent.click(
      screen.getByRole("button", {
        name: mode === "create" ? "检查发布内容" : "预览此订阅更新",
      }),
    );
    await screen.findByText("Candidate route");
    expect(screen.getByText("Compatibility detail")).toBeTruthy();
    const technical = screen.getByRole("button", {
      name: mode === "create" ? "技术配置（可选查看）" : "查看待发布技术配置",
    });
    expect(technical.getAttribute("aria-expanded")).toBe("false");
    const technicalPanel = screen
      .getByText("Technical candidate content")
      .closest('[data-slot="accordion-content"]')!;
    expect(technicalPanel.getAttribute("data-state")).toBe("closed");
    // jsdom does not load Tailwind; browser geometry verifies that closed content is hidden.
    expect(
      technicalPanel.classList.contains("data-[state=closed]:hidden"),
    ).toBe(true);
    const final = screen.getByRole("button", {
      name:
        mode === "create"
          ? "创建并发布「Review configuration」"
          : "确认更新「Review link」",
    });
    expect((final as HTMLButtonElement).disabled).toBe(false);
    if (mode === "create")
      expect(final.closest('[data-slot="dialog-footer"]')).not.toBeNull();
    else {
      const decision = screen.getByRole("group", { name: "更新确认" });
      expect(decision.contains(final)).toBe(true);
      expect(
        within(decision).getByText("沿用当前链接，其他订阅保留原状。"),
      ).toBeTruthy();
      // Consequence and approval remain one decision outside the independently
      // scrolling evidence body; constrained viewports use the whole-task flow.
      expect(decision.closest("[data-task-overlay-body]")).toBeNull();
      expect(decision.closest('[data-slot="dialog-footer"]')).not.toBeNull();
      expect(final.closest('[data-slot="dialog-footer"]')).not.toBeNull();
    }
    for (const button of [
      final,
      screen.getByRole("button", { name: /取\s*消/ }),
    ]) {
      // jsdom does not compile Tailwind; browser gate verifies the 44px geometry.
      expect(button.classList.contains("min-h-11")).toBe(true);
    }
    const container = final.closest(
      '[data-task-overlay="dialog"]',
    ) as HTMLElement;
    expect(container.classList.contains("flex")).toBe(true);
    expect(container.classList.contains("flex-col")).toBe(true);
    expect(container.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(
      (
        container.querySelector("[data-task-overlay-body]") as HTMLElement
      ).classList.contains("min-h-0"),
    ).toBe(true);
    expect(
      (
        container.querySelector("[data-task-overlay-body]") as HTMLElement
      ).classList.contains("overflow-y-auto"),
    ).toBe(true);
    for (const part of [
      '[data-slot="dialog-header"]',
      '[data-slot="dialog-footer"]',
    ]) {
      expect(
        (container.querySelector(part) as HTMLElement).classList.contains(
          "shrink-0",
        ),
      ).toBe(true);
    }
    technical.focus();
    await userEvent.keyboard("[Enter]");
    expect(await screen.findByText("Technical candidate content")).toBeTruthy();
    expect(technical.getAttribute("aria-expanded")).toBe("true");
  },
);

it("keeps the actual overview task and expanded usage while moving through legacy aliases", async () => {
  const writes: string[] = [];
  const saved = { ...emptyProfile(), id: "layout-shared", name: "Layout routing" };
  const link = { id: "layout-link", name: "Layout phone", profileId: saved.id, target: saved.target, mode: saved.mode, status: "draft" };
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = String(url);
    if (init?.method && init.method !== "GET") writes.push(path);
    if (path.endsWith("/overview")) return json({ ...overview, status: "active", quotaBytes: 100, usage: { weightedBytes: 20, rawBytes: 20 } });
    if (path.endsWith("/outputs")) return json([link]);
    if (path.endsWith("/profiles")) return json([saved]);
    if (path.endsWith("/reveal")) return json(saved);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const task = (view: "overview" | "profiles" | "outputs") => <QueryClientProvider client={client}><UIProviders><SubscriptionsPage view={view} /></UIProviders></QueryClientProvider>;
  const { rerender } = render(task("overview"));
  const details = await screen.findByRole("region", { name: "用量与周期明细" });
  for (const view of ["profiles", "outputs", "overview"] as const) {
    rerender(task(view));
    expect(screen.getByRole("region", { name: "用量与周期明细" })).toBe(details);
    expect(screen.queryByRole("button", { name: "用量与周期明细" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "平台服务用量" })).toHaveLength(1);
  }
  await userEvent.click(screen.getByRole("button", { name: "编辑配置" }));
  const name = await screen.findByRole("textbox", { name: "配置名称" });
  fireEvent.change(name, { target: { value: "Unsubmitted layout draft" } });
  for (const view of ["profiles", "outputs", "overview"] as const) {
    rerender(task(view));
    expect(screen.getByRole("textbox", { name: "配置名称" })).toBe(name);
    expect(name).toHaveProperty("value", "Unsubmitted layout draft");
  }
  expect(writes).toEqual([]);
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";

const profile: Profile = {
  ...emptyProfile(),
  id: "shared",
  name: "Travel configuration",
};
const output = (id: string, name: string, owner = profile.id): Output => ({
  id,
  name,
  profileId: owner,
  target: profile.target,
  mode: "full",
  status: "published",
  routingSummary: {
    version: 1,
    kind: "basic",
    chatGPT: { label: `${name} frozen route`, endpointId: "direct" },
    default: { label: "Direct", endpointId: "direct" },
  },
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}
function inventory(profiles: Profile[], outputs: Output[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith("/overview"))
        return json({ status: "active", routes: [] });
      if (path.endsWith("/profiles")) return json(profiles);
      if (path.endsWith("/outputs")) return json(outputs);
      if (path.endsWith("/status"))
        return json({
          ...outputs.find((o) => path.includes(`/${o.id}/`)),
          draftComparison: { state: "unchanged" },
        });
      return json([]);
    }),
  );
  return calls;
}
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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

it("shows one relational inventory without automatically comparing or selecting a client link", async () => {
  const calls = inventory(
    [profile],
    [output("phone", "Phone"), output("laptop", "Laptop")],
  );
  mount();
  const group = await screen.findByRole("article", {
    name: `分流配置 ${profile.name}`,
  });
  expect(within(group).getByText("Phone")).toBeTruthy();
  expect(within(group).getByText("Laptop")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "已发布分流" })).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(calls.some((path) => path.endsWith("/status"))).toBe(false);
});

it("opens the requested frozen link only and closing returns to its configuration scope", async () => {
  history.replaceState(null, "", "#subscriptions?profile=shared");
  const calls = inventory(
    [profile],
    [output("phone", "Phone"), output("laptop", "Laptop")],
  );
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Laptop" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "订阅详情 · Laptop",
  });
  expect(within(dialog).getByText("Laptop frozen route")).toBeTruthy();
  await within(dialog).findByText("与已保存草稿一致");
  expect(calls.filter((path) => path.endsWith("/status"))).toEqual([
    "/api/me/outputs/laptop/status",
  ]);
  expect(location.hash).toContain("output=laptop");
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(location.hash).toBe("#subscriptions?profile=shared");
  expect(screen.queryByRole("region", { name: "已发布分流" })).toBeNull();
  expect(calls.some((path) => path.includes("/phone/status"))).toBe(false);
});

it("keeps same-prefix long names complete and opens the chosen identity by keyboard", async () => {
  const longProfile = {
    ...profile,
    name: `${"Travel_Work_".repeat(12)}東京`,
  };
  const sharedName = "Phone_for_".repeat(16);
  const phone = output("phone", `${sharedName}東京`);
  const laptop = output("laptop", `${sharedName}大阪`);
  const calls = inventory([longProfile], [phone, laptop]);
  mount();
  const group = await screen.findByRole("article", {
    name: `分流配置 ${longProfile.name}`,
  });
  expect(
    within(group).getByRole("heading", { name: longProfile.name }).textContent,
  ).toBe(longProfile.name);
  for (const link of [phone, laptop]) {
    const row = within(group).getByRole("group", {
      name: `客户端订阅 ${link.name}`,
    });
    expect(
      within(row).getByRole("button", { name: `查看订阅 ${link.name}` })
        .textContent,
    ).toBe(link.name);
    expect(within(row).getByText("已发布")).toBeTruthy();
  }
  within(group)
    .getByRole("button", { name: `查看订阅 ${laptop.name}` })
    .focus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: `订阅详情 · ${laptop.name}`,
  });
  expect(
    within(dialog).getByText(`分流配置：${longProfile.name}`),
  ).toBeTruthy();
  expect(location.hash).toContain("output=laptop");
  expect(calls.some((path) => path.includes("/phone/status"))).toBe(false);
});

it("bounds 100 client links and finds a hidden long client name within its owning configuration", async () => {
  const profiles = Array.from({ length: 25 }, (_, i) => ({
    ...profile,
    id: `profile-${i}`,
    name: `Configuration ${i}`,
  }));
  const outputs = Array.from({ length: 100 }, (_, i) =>
    output(
      `link-${i}`,
      i === 99 ? "Long client name 東京—work-laptop—".repeat(6) : `Client ${i}`,
      i < 20 ? profiles[0].id : profiles[1 + ((i - 20) % 24)].id,
    ),
  );
  const calls = inventory(profiles, outputs);
  mount();
  await screen.findByRole("article", { name: "分流配置 Configuration 0" });
  expect(screen.getAllByRole("article")).toHaveLength(10);
  const first = screen.getByRole("article", {
    name: "分流配置 Configuration 0",
  });
  expect(
    within(first).getAllByRole("group", { name: /^客户端订阅 / }),
  ).toHaveLength(5);
  expect(within(first).queryByText("Client 5")).toBeNull();
  const pager = within(first).getByRole("navigation", {
    name: "Configuration 0的客户端订阅分页",
  });
  await userEvent.click(within(pager).getByRole("button", { name: "下一页" }));
  expect(within(first).getByText("Client 5")).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "搜索配置或客户端订阅" }),
    { target: { value: "東京—work-laptop" } },
  );
  const found = screen.getByRole("article", {
    name: "分流配置 Configuration 8",
  });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(
    within(found).getByRole("button", { name: `查看订阅 ${outputs[99].name}` }),
  ).toBeTruthy();
  expect(within(found).getByRole("button", { name: "获取订阅" })).toBeTruthy();
  expect(within(found).getByRole("button", { name: "检查更新" })).toBeTruthy();
  expect(
    calls.some((path) => path.endsWith("/status") || path.endsWith("/preview")),
  ).toBe(false);
});

it("keeps first-use empty, saved draft and search no-match as different states", async () => {
  inventory([], []);
  const empty = mount();
  await screen.findByText("暂无订阅");
  expect(screen.getByRole("button", { name: "新建分流配置" })).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "搜索配置或客户端订阅" }),
  ).toBeNull();
  empty.unmount();
  inventory([profile], []);
  mount();
  const draft = await screen.findByRole("article", {
    name: `分流配置 ${profile.name}`,
  });
  expect(within(draft).getByText(/尚未关联客户端订阅/)).toBeTruthy();
  expect(within(draft).getByRole("button", { name: "继续配置" })).toBeTruthy();
  expect(
    within(draft).getByRole("button", {
      name: `为 ${profile.name} 新增客户端订阅`,
    }),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "搜索配置或客户端订阅" }),
    { target: { value: "unmatched" } },
  );
  expect(screen.getByText("没有匹配的配置或客户端订阅")).toBeTruthy();
  expect(screen.queryByText("暂无订阅")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(
    screen.getByRole("article", { name: `分流配置 ${profile.name}` }),
  ).toBeTruthy();
});

it.each(["profiles", "outputs"])(
  "honors #%s and query aliases as an explicit Output context",
  async (alias) => {
    history.replaceState(null, "", `#${alias}?profileId=shared&outputId=phone`);
    const calls = inventory(
      [profile],
      [output("phone", "Phone"), output("laptop", "Laptop")],
    );
    mount();
    const dialog = await screen.findByRole("dialog", {
      name: "订阅详情 · Phone",
    });
    await within(dialog).findByText("与已保存草稿一致");
    expect(calls.filter((path) => path.endsWith("/status"))).toEqual([
      "/api/me/outputs/phone/status",
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(location.hash).toBe(`#${alias}?profileId=shared`);
  },
);

it.each(["missing", "unrelated"])(
  "never substitutes another Output for an inaccessible or mismatched %s scope",
  async (id) => {
    history.replaceState(null, "", `#outputs?profile=shared&output=${id}`);
    const calls = inventory(
      [profile, { ...profile, id: "other", name: "Other" }],
      [output("phone", "Phone"), output("unrelated", "Unrelated", "other")],
    );
    mount();
    await screen.findByText(
      id === "missing"
        ? "所选客户端订阅不在当前可访问范围"
        : "客户端订阅不属于当前分流配置",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.some((path) => path.endsWith("/status"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "清除订阅选择" }));
    expect(location.hash).toBe("#outputs?profile=shared");
    expect(
      screen.queryByRole("article", { name: "分流配置 Other" }),
    ).toBeNull();
    expect(calls.some((path) => path.endsWith("/status"))).toBe(false);
  },
);

it("keeps revoked Output details and explicit recovery while disabling link access", async () => {
  history.replaceState(null, "", "#outputs?output=retired");
  inventory(
    [profile],
    [{ ...output("retired", "Retired phone"), status: "revoked" }],
  );
  mount();
  const dialog = await screen.findByRole("dialog", {
    name: "订阅详情 · Retired phone",
  });
  expect(within(dialog).getByText("Retired phone frozen route")).toBeTruthy();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "获取订阅",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "检查重新发布" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Retired phone」",
  });
  expect(within(review).queryByText(/在客户端换用新链接|链接不变/)).toBeNull();
  expect(
    (
      within(review).getByRole("button", {
        name: "确认更新「Retired phone」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("retains readable orphan delivery and frozen detail when configurations fail without pretending they are editable", async () => {
  const orphan = output("orphan", "Orphan laptop", "missing-profile");
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith("/profiles"))
        return json({ error: "Profiles unavailable" }, 503);
      if (path.endsWith("/outputs")) return json([orphan]);
      if (path.endsWith("/status"))
        return json({ ...orphan, draftComparison: { state: "unavailable" } });
      if (path.endsWith("/access"))
        return json({
          delivery: "bundle",
          downloadPath: "/api/me/outputs/orphan/bundle",
        });
      return json({ status: "active", routes: [] });
    }),
  );
  mount();
  await screen.findByText("暂时无法加载分流配置");
  const row = screen.getByRole("group", { name: "客户端订阅 Orphan laptop" });
  expect(
    (within(row).getByRole("button", { name: "检查更新" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "编辑配置" })).toBeNull();
  expect(screen.queryByText("暂无订阅")).toBeNull();
  await userEvent.click(
    within(row).getByRole("button", { name: "查看订阅 Orphan laptop" }),
  );
  const detail = await screen.findByRole("dialog", {
    name: "订阅详情 · Orphan laptop",
  });
  expect(within(detail).getByText("Orphan laptop frozen route")).toBeTruthy();
  await userEvent.click(
    within(detail).getByRole("button", { name: "获取订阅" }),
  );
  const access = await screen.findByRole("dialog", {
    name: "获取「Orphan laptop」",
  });
  const download = await within(access).findByRole("link", {
    name: "下载配置与规则文件",
  });
  expect(download.getAttribute("href")).toBe("/api/me/outputs/orphan/bundle");
  expect(calls.some((path) => path.endsWith("/reveal"))).toBe(false);
});

it("checks only the explicitly requested link using its fresh target metadata without changing its sibling", async () => {
  const phone = output("phone", "Phone");
  const laptop = output("laptop", "Laptop");
  const fresh = {
    ...laptop,
    target: { adapterId: "sing-box", version: "1.12.0" },
    mode: "nodes-only",
  };
  const writes: { path: string; body: unknown }[] = [];
  let outputReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") {
        writes.push({ path, body: JSON.parse(init.body) });
        return json({
          valid: true,
          artifacts: [{ path: "config.json", content: "{}" }],
          previewScope: "output-update",
          outputId: "laptop",
          previewDigest: "a".repeat(64),
          publicationEffect: { version: 1, link: "preserve" },
          routingSummary: { version: 1, kind: "nodes-only" },
        });
      }
      if (path.endsWith("/overview"))
        return json({ status: "active", routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs"))
        return json([phone, ++outputReads === 1 ? laptop : fresh]);
      if (path.endsWith("/laptop/status"))
        return json({ ...fresh, draftComparison: { state: "changed" } });
      throw new Error(`Unexpected read ${path}`);
    }),
  );
  mount();
  await screen.findByRole("article", { name: `分流配置 ${profile.name}` });
  expect(writes).toEqual([]);
  await userEvent.click(
    screen.getByRole("button", { name: "查看订阅 Laptop" }),
  );
  const detail = await screen.findByRole("dialog", {
    name: "订阅详情 · Laptop",
  });
  await within(detail).findByText("已保存的修改尚未发布");
  expect(detail.textContent).toContain("sing-box · 纯节点");
  expect(writes).toEqual([]);
  await userEvent.click(
    within(detail).getByRole("button", { name: "检查更新" }),
  );
  const review = await screen.findByRole("dialog", {
    name: "检查订阅更新「Laptop」",
  });
  await within(review).findByText("兼容检查通过。");
  expect(writes).toEqual([
    {
      path: "/api/me/profiles/shared/preview",
      body: { outputId: "laptop", target: fresh.target, mode: "nodes-only" },
    },
  ]);
  expect(
    (
      within(review).getByRole("button", {
        name: "确认更新「Laptop」",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await userEvent.click(
    within(review).getByRole("button", { name: /取\s*消/ }),
  );
  await screen.findByRole("dialog", { name: "订阅详情 · Laptop" });
  expect(writes).toHaveLength(1);
});

it.each(["revoked", "missing"])(
  "refreshes an explicitly checked cached Output before deciding its externally %s lifecycle",
  async (state) => {
    const cached = output("phone", "Phone");
    const fresh = {
      ...cached,
      status: "revoked",
      target: { adapterId: "sing-box", version: "1.12.0" },
      mode: "nodes-only",
    };
    let reads = 0;
    const writes: { path: string; body: unknown }[] = [];
    let resolveFresh!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const path = String(url);
        if (init?.method === "POST") {
          writes.push({ path, body: JSON.parse(init.body) });
          return json({
            valid: true,
            previewDigest: "a".repeat(64),
            publicationEffect: { version: 1, link: "replace" },
            previewScope: "output-update",
            outputId: "phone",
            artifacts: [{ path: "config.json", content: "{}" }],
          });
        }
        if (path.endsWith("/overview"))
          return json({ status: "active", routes: [] });
        if (path.endsWith("/profiles")) return json([profile]);
        if (path.endsWith("/outputs")) {
          if (++reads === 1) return json([cached]);
          return new Promise<Response>((resolve) => {
            resolveFresh = resolve;
          });
        }
        throw new Error(`Unexpected request ${path}`);
      }),
    );
    mount();
    const row = await screen.findByRole("group", { name: "客户端订阅 Phone" });
    await userEvent.click(
      within(row).getByRole("button", { name: "检查更新" }),
    );
    await waitFor(() => expect(reads).toBe(2));
    expect(
      (
        within(row).getByRole("button", {
          name: /检查更新/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes).toEqual([]);
    resolveFresh(json(state === "revoked" ? [fresh] : []));
    if (state === "missing") {
      await screen.findByText(
        "「Phone」已不在当前可访问范围。未检查、发布或切换到其他订阅。",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(writes).toEqual([]);
    } else {
      const review = await screen.findByRole("dialog", {
        name: "检查订阅更新「Phone」",
      });
      await within(review).findByText("兼容检查通过。");
      expect(review.textContent).toContain(
        "发布后请在客户端换用新链接，其他订阅不受影响。",
      );
      expect(review.textContent).not.toContain("原订阅链接保持不变");
      expect(writes).toEqual([
        {
          path: "/api/me/profiles/shared/preview",
          body: { outputId: "phone", target: fresh.target, mode: "nodes-only" },
        },
      ]);
    }
  },
);

it("does not reopen an old Output check when fresh metadata arrives after scope navigation", async () => {
  const phone = output("phone", "Phone");
  const other = { ...profile, id: "other", name: "Other configuration" };
  let reads = 0;
  let resolveFresh!: (value: Response) => void;
  const writes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (init?.method === "POST") writes.push(path);
      if (path.endsWith("/overview"))
        return json({ status: "active", routes: [] });
      if (path.endsWith("/profiles")) return json([profile, other]);
      if (path.endsWith("/outputs")) {
        if (++reads === 1) return json([phone]);
        return new Promise<Response>((resolve) => {
          resolveFresh = resolve;
        });
      }
      return json([]);
    }),
  );
  mount();
  const row = await screen.findByRole("group", { name: "客户端订阅 Phone" });
  await userEvent.click(within(row).getByRole("button", { name: "检查更新" }));
  await waitFor(() => expect(reads).toBe(2));
  history.replaceState(null, "", "#subscriptions?profile=other");
  fireEvent(window, new HashChangeEvent("hashchange"));
  resolveFresh(json([phone]));
  await screen.findByRole("article", { name: "分流配置 Other configuration" });
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: `分流配置 ${profile.name}` }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes).toEqual([]);
  expect(location.hash).toBe("#subscriptions?profile=other");
});

it("lets long client names wrap inside the owned-link row instead of clipping the action", async () => {
  const name = "Matrix configuration personal phone with a long display name";
  inventory([profile], [output("phone", name)]);
  mount();
  const control = await screen.findByRole("button", {
    name: `查看订阅 ${name}`,
  });
  const style = document.createElement("style");
  style.textContent = (
    await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
  ).build(
    [...document.body.querySelectorAll<HTMLElement>("[class]")].flatMap(
      (node) => [...node.classList],
    ),
  );
  document.head.append(style);
  try {
    expect(getComputedStyle(control).whiteSpace).toBe("normal");
    expect(getComputedStyle(control).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(control).maxWidth).toBe("100%");
    expect(control.textContent).toBe(name);
  } finally {
    style.remove();
  }
});

it("wraps an unbroken configuration identity instead of clipping it at the card edge", async () => {
  const name = `${"Travel_Work_".repeat(12)}東京`;
  inventory([{ ...profile, name }], [output("phone", "Phone")]);
  mount();
  const heading = await screen.findByRole("heading", { name });
  const style = document.createElement("style");
  style.textContent = (
    await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
  ).build([...heading.classList]);
  document.head.append(style);
  try {
    expect(heading.textContent).toBe(name);
    expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(heading).textOverflow).not.toBe("ellipsis");
  } finally {
    style.remove();
  }
});

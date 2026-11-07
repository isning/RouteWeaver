// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Workspace from "./App";
import { SubscriptionsPage } from "./Subscriptions";
import { SubscriptionContextProvider } from "./SubscriptionContext";
import { emptyProfile } from "./model";
import type { Output, Profile } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

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
const clients: QueryClient[] = [];
function mount(children: React.ReactNode = <Workspace />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(children, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <UIProviders>{children}</UIProviders>
      </QueryClientProvider>
    ),
  });
  return { ...view, client };
}
function inventory(profiles: Profile[], outputs: Output[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith("/auth/me"))
        return json({
          user: { id: "account-a", name: "A", role: "user" },
          csrfToken: "a",
        });
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
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("returns from sources to the remembered subscription search and page without serializing search", async () => {
  inventory(
    Array.from({ length: 12 }, (_, i) => ({
      ...profile,
      id: `profile-${i}`,
      name: `Travel ${i}`,
    })),
    [],
  );
  mount();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    "Travel",
  );
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "配置清单分页" })).getByRole(
      "button",
      { name: "下一页" },
    ),
  );
  expect(
    screen.getByRole("article", { name: "分流配置 Travel 10" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  // The primary subscription destination stays discoverable across sections.
  await userEvent.click(screen.getByRole("button", { name: "我的订阅" }));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "搜索配置或客户端订阅",
      })) as HTMLInputElement
    ).value,
  ).toBe("Travel");
  expect(
    screen.getByRole("article", { name: "分流配置 Travel 10" }),
  ).toBeTruthy();
  expect(location.href + JSON.stringify(history.state)).not.toContain("Travel");
});

it("clamps a removed page after successful inventory and does not resurrect it when inventory grows", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...profile,
    id: `profile-${i}`,
    name: `Travel ${i}`,
  }));
  inventory(rows, []);
  const { client } = mount(
    <SubscriptionContextProvider>
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await userEvent.click(
    within(
      await screen.findByRole("navigation", { name: "配置清单分页" }),
    ).getByRole("button", { name: "下一页" }),
  );
  expect(
    screen.getByRole("article", { name: "分流配置 Travel 10" }),
  ).toBeTruthy();
  await act(async () => {
    client.setQueryData(["profiles"], rows.slice(0, 1));
  });
  await waitFor(() =>
    expect(
      screen.getByRole("article", { name: "分流配置 Travel 0" }),
    ).toBeTruthy(),
  );
  await act(async () => {
    client.setQueryData(["profiles"], rows);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("article", { name: "分流配置 Travel 10" }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("article", { name: "分流配置 Travel 0" }),
    ).toBeTruthy(),
  );
});

it("restores the last in-list focus and scroll after a materials detour", async () => {
  inventory([profile], []);
  mount();
  const search = await screen.findByRole("textbox", {
    name: "搜索配置或客户端订阅",
  });
  await userEvent.click(search);
  Object.defineProperty(window, "scrollY", { configurable: true, value: 730 });
  fireEvent.scroll(window);
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  // The primary subscription destination stays discoverable across sections.
  await userEvent.click(screen.getByRole("button", { name: "我的订阅" }));
  const restored = await screen.findByRole("textbox", {
    name: "搜索配置或客户端订阅",
  });
  await waitFor(() => expect(document.activeElement).toBe(restored));
  expect(window.scrollTo).toHaveBeenCalledWith({
    top: 730,
    behavior: "instant",
  });
});

it("keeps an explicit Profile visible even when its remembered link filter has no matches", async () => {
  history.replaceState(null, "", "#subscriptions?profile=shared");
  inventory([profile], [output("phone", "Phone")]);
  mount();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    "no-match-private-input",
  );
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await act(async () => {
    location.hash = "#subscriptions?profile=shared";
  });
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  expect(
    await screen.findByRole("article", {
      name: "分流配置 Travel configuration",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByText(
      "尚未关联客户端订阅。继续配置，或将已保存内容发布到客户端。",
    ),
  ).toBeNull();
});

it("restores remembered search and its explicit Profile after closing a same-document Output deep link", async () => {
  history.replaceState(null, "", "#subscriptions?profile=shared");
  inventory([profile], [output("phone", "Phone")]);
  mount();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    "no-match-private-input",
  );
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await act(async () => {
    location.hash = "#subscriptions?profile=shared&output=phone";
  });
  const dialog = await screen.findByRole("dialog", {
    name: "Phone 的订阅详情",
  });
  expect(
    within(dialog).getByText("分流配置：Travel configuration"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "搜索配置或客户端订阅" }),
  ).toBeNull();
  const length = history.length;
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(location.hash).toBe("#subscriptions?profile=shared");
  expect(history.length).toBe(length);
  expect(
    (
      screen.getByRole("textbox", {
        name: "搜索配置或客户端订阅",
      }) as HTMLInputElement
    ).value,
  ).toBe("no-match-private-input");
  const card = screen.getByRole("article", {
    name: "分流配置 Travel configuration",
  });
  expect(within(card).getByText("没有匹配的客户端订阅。")).toBeTruthy();
  expect(
    within(card).queryByRole("button", { name: "查看订阅 Phone" }),
  ).toBeNull();
  expect(
    location.href +
      JSON.stringify(history.state) +
      JSON.stringify(localStorage) +
      JSON.stringify(sessionStorage),
  ).not.toContain("no-match-private-input");
});

it("clears private memory context for another account and never serializes the search", async () => {
  inventory([profile], []);
  const { rerender, client } = mount(
    <SubscriptionContextProvider accountKey="A">
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  const privateSearch = "https://private.invalid/token?secret=not-for-history";
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    privateSearch,
  );
  rerender(
    <SubscriptionContextProvider accountKey="A">
      <div>Materials</div>
    </SubscriptionContextProvider>,
  );
  rerender(
    <SubscriptionContextProvider accountKey="A">
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "搜索配置或客户端订阅",
      })) as HTMLInputElement
    ).value,
  ).toBe(privateSearch);
  expect(
    JSON.stringify([...push.mock.calls, ...replace.mock.calls]),
  ).not.toContain(privateSearch);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ),
  ).not.toContain(privateSearch);
  expect(
    location.href +
      JSON.stringify(history.state) +
      JSON.stringify(localStorage) +
      JSON.stringify(sessionStorage),
  ).not.toContain(privateSearch);
  rerender(
    <SubscriptionContextProvider accountKey="B">
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "搜索配置或客户端订阅",
        }) as HTMLInputElement
      ).value,
    ).toBe(""),
  );
  rerender(
    <SubscriptionContextProvider accountKey="A">
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "搜索配置或客户端订阅",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});

it("expires the oldest remembered scope rather than retaining unbounded search text", async () => {
  history.replaceState(null, "", "#subscriptions?profile=profile-0");
  inventory(
    Array.from({ length: 10 }, (_, i) => ({
      ...profile,
      id: `profile-${i}`,
      name: `Travel ${i}`,
    })),
    [],
  );
  mount(
    <SubscriptionContextProvider accountKey="A">
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    "old-private-search",
  );
  for (let i = 1; i < 10; i++) {
    await act(async () => {
      location.hash = `#subscriptions?profile=profile-${i}`;
    });
    await screen.findByRole("article", { name: `分流配置 Travel ${i}` });
  }
  await act(async () => {
    location.hash = "#subscriptions?profile=profile-0";
  });
  await screen.findByRole("article", { name: "分流配置 Travel 0" });
  expect(
    (
      screen.getByRole("textbox", {
        name: "搜索配置或客户端订阅",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});

it("opens a detail as history, Back closes it, and Forward restores the exact Output", async () => {
  inventory([profile], [output("phone", "Phone"), output("laptop", "Laptop")]);
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "查看订阅 Laptop" }),
  );
  await screen.findByRole("dialog", { name: "Laptop 的订阅详情" });
  await act(async () => {
    history.back();
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Laptop 的订阅详情" }),
    ).toBeNull(),
  );
  expect(location.hash).toBe("#subscriptions");
  await act(async () => {
    history.forward();
  });
  await screen.findByRole("dialog", { name: "Laptop 的订阅详情" });
  expect(location.hash).toContain("output=laptop");
  expect(screen.queryByRole("dialog", { name: "Phone 的订阅详情" })).toBeNull();
});

it("keeps a dirty source on Back cancel and discards only once before later Back and Forward", async (context) => {
  const owner = ownedClickScenario(context);
  owner.assertActive();
  inventory([profile], []);
  owner.assertActive();
  mount();
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  owner.assertActive();
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  owner.assertActive();
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  owner.assertActive();
  await userEvent.click(screen.getAllByRole("button", { name: "添加来源" })[0]);
  owner.assertActive();
  const editor = await screen.findByRole("dialog", { name: "添加订阅来源" });
  owner.assertActive();
  fireEvent.change(within(editor).getByLabelText("来源名称"), {
    target: { value: "Unsaved private draft" },
  });
  const sourceProof = history.state;
  await act(async () => {
    owner.assertActive();
    history.back();
  });
  owner.assertActive();
  const continueEditing = await screen.findByRole("button", {
    name: "继续编辑",
  });
  owner.assertActive();
  await userEvent.click(continueEditing);
  owner.assertActive();
  expect(history.state).toEqual(sourceProof);
  expect(location.hash).toBe("#sources");
  expect(
    (within(editor).getByLabelText("来源名称") as HTMLInputElement).value,
  ).toBe("Unsaved private draft");
  await act(async () => {
    owner.assertActive();
    history.back();
  });
  owner.assertActive();
  const discardAndLeave = await screen.findByRole("button", {
    name: "放弃修改并离开",
  });
  owner.assertActive();
  await userEvent.click(discardAndLeave);
  owner.assertActive();
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  owner.assertActive();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  owner.assertActive();
  await act(async () => {
    owner.assertActive();
    history.forward();
  });
  owner.assertActive();
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  owner.assertActive();
  expect(history.state).toEqual(sourceProof);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    owner.assertActive();
    history.back();
  });
  owner.assertActive();
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  owner.assertActive();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not reset a remembered page when inventory fails before a successful retry", async () => {
  inventory(
    Array.from({ length: 12 }, (_, i) => ({
      ...profile,
      id: `profile-${i}`,
      name: `Travel ${i}`,
    })),
    [],
  );
  const baseFetch = globalThis.fetch;
  let failing = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      failing && String(url).endsWith("/profiles")
        ? Promise.resolve(json({ message: "Unavailable" }, 503))
        : baseFetch(url, init),
    ),
  );
  const { client } = mount(
    <SubscriptionContextProvider>
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await userEvent.click(
    within(
      await screen.findByRole("navigation", { name: "配置清单分页" }),
    ).getByRole("button", { name: "下一页" }),
  );
  failing = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["profiles"] });
  });
  await screen.findByText("暂时无法加载分流配置");
  failing = false;
  await userEvent.click(screen.getByRole("button", { name: "重试配置" }));
  expect(
    await screen.findByRole("article", { name: "分流配置 Travel 10" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("article", { name: "分流配置 Travel 0" }),
  ).toBeNull();
});

it("defers native Back while the same account is checked, then asks before abandoning its draft", async () => {
  inventory([profile], []);
  const baseFetch = globalThis.fetch;
  let holding = false;
  let complete: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      if (holding && String(url).endsWith("/auth/me"))
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      return baseFetch(url, init);
    }),
  );
  mount();
  await screen.findByRole("heading", { name: "我的订阅", level: 1 });
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  await userEvent.click(screen.getAllByRole("button", { name: "添加来源" })[0]);
  const editor = await screen.findByRole("dialog", { name: "添加订阅来源" });
  fireEvent.change(within(editor).getByLabelText("来源名称"), {
    target: { value: "Retain my draft" },
  });
  const proof = history.state;
  holding = true;
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  await act(async () => {
    history.back();
  });
  await waitFor(() => expect(history.state).toEqual(proof));
  expect(
    screen.queryByRole("alertdialog", { name: "放弃未保存的修改？" }),
  ).toBeNull();
  holding = false;
  await act(async () => {
    complete!(
      json({
        user: { id: "account-a", name: "A", role: "user" },
        csrfToken: "a",
      }),
    );
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "继续编辑" }),
  );
  expect(location.hash).toBe("#sources");
  expect(
    (within(editor).getByLabelText("来源名称") as HTMLInputElement).value,
  ).toBe("Retain my draft");
});

it("routes a source acceptance link through the same history lineage and returns to its source", async () => {
  history.replaceState(null, "", "#sources");
  inventory([profile], []);
  const baseFetch = globalThis.fetch;
  const source = {
    id: "source",
    name: "Source",
    kind: "text",
    enabled: true,
    revision: "r1",
    content: "",
    snapshot: { endpoints: [] },
    candidate: {
      id: "candidate",
      createdAt: "2026-10-22T00:00:00Z",
      diff: {
        beforeCount: 0,
        afterCount: 0,
        removed: [],
        added: [],
        renamed: [],
        connectionChanged: [],
      },
      affected: [
        {
          kind: "profile",
          id: "shared",
          name: profile.name,
          reason: "draft-inputs-changed",
        },
      ],
    },
  };
  let applied = false;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) => {
      if (String(url).endsWith("/sources"))
        return Promise.resolve(
          json([
            applied
              ? { ...source, candidate: undefined, revision: "r2" }
              : source,
          ]),
        );
      if (String(url).endsWith("/apply")) {
        applied = true;
        return Promise.resolve(
          json({ ...source, candidate: undefined, revision: "r2" }),
        );
      }
      return baseFetch(url, init);
    }),
  );
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "查看变化" }),
  );
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "应用更新",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(
    await screen.findByRole("button", { name: "查看上次应用结果 Source" }),
  );
  const result = await screen.findByRole("dialog", { name: "上次应用详情" });
  const sourceState = history.state;
  await userEvent.click(
    within(result).getByRole("link", { name: `查看配置 ${profile.name}` }),
  );
  await screen.findByRole("article", { name: `分流配置 ${profile.name}` });
  expect(history.state.routeweaverLineage).toBe(sourceState.routeweaverLineage);
  expect(location.hash).toBe("#subscriptions?profile=shared");
  await act(async () => {
    history.back();
  });
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  expect(history.state).toEqual(sourceState);
});

it("keeps the client-link page through detail Back and a materials detour", async () => {
  inventory(
    [profile],
    Array.from({ length: 12 }, (_, i) => output(`client-${i}`, `Client ${i}`)),
  );
  mount();
  const pager = await screen.findByRole("navigation", {
    name: `${profile.name}的客户端订阅分页`,
  });
  await userEvent.click(within(pager).getByRole("button", { name: "下一页" }));
  await userEvent.click(
    screen.getByRole("button", { name: "查看订阅 Client 5" }),
  );
  await screen.findByRole("dialog", { name: "Client 5 的订阅详情" });
  await act(async () => {
    history.back();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    screen.getByRole("button", { name: "查看订阅 Client 5" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "查看订阅 Client 0" }),
  ).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  // The primary subscription destination stays discoverable across sections.
  await userEvent.click(screen.getByRole("button", { name: "我的订阅" }));
  expect(
    await screen.findByRole("button", { name: "查看订阅 Client 5" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "查看订阅 Client 0" }),
  ).toBeNull();
});

it("keeps the remembered page while an uncached inventory loads on return", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...profile,
    id: `profile-${i}`,
    name: `Travel ${i}`,
  }));
  inventory(rows, []);
  const baseFetch = globalThis.fetch;
  let holding = false;
  let complete: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url, init) =>
      holding && String(url).endsWith("/profiles")
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : baseFetch(url, init),
    ),
  );
  const { client, rerender } = mount(
    <SubscriptionContextProvider>
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await userEvent.click(
    within(
      await screen.findByRole("navigation", { name: "配置清单分页" }),
    ).getByRole("button", { name: "下一页" }),
  );
  rerender(
    <SubscriptionContextProvider>
      <div>Materials</div>
    </SubscriptionContextProvider>,
  );
  client.removeQueries({ queryKey: ["profiles"], exact: true });
  holding = true;
  rerender(
    <SubscriptionContextProvider>
      <SubscriptionsPage />
    </SubscriptionContextProvider>,
  );
  await screen.findByRole("status", { name: "正在加载配置与客户端订阅" });
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  holding = false;
  await act(async () => {
    complete!(json(rows));
  });
  expect(
    await screen.findByRole("article", { name: "分流配置 Travel 10" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("article", { name: "分流配置 Travel 0" }),
  ).toBeNull();
});

it.each(["close", "back"])(
  "returns focus to the exact list trigger after detail %s",
  async (action) => {
    inventory(
      [profile],
      [output("phone", "Phone"), output("laptop", "Laptop")],
    );
    mount();
    const trigger = await screen.findByRole("button", {
      name: "查看订阅 Laptop",
    });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Laptop 的订阅详情",
    });
    const close = within(dialog).getByRole("button", { name: "关闭" });
    close.focus();
    if (action === "close") await userEvent.click(close);
    else
      await act(async () => {
        history.back();
      });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  },
);

it("does not overwrite the departing scope's scroll when the next scope restores its own position", async () => {
  history.replaceState(null, "", "#subscriptions?profile=shared");
  inventory([profile, { ...profile, id: "other", name: "Other" }], []);
  vi.mocked(window.scrollTo).mockImplementation((...args: unknown[]) => {
    const options = args[0] as ScrollToOptions;
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: options.top || 0,
    });
    window.dispatchEvent(new Event("scroll"));
  });
  mount();
  await screen.findByRole("article", { name: `分流配置 ${profile.name}` });
  Object.defineProperty(window, "scrollY", { configurable: true, value: 730 });
  fireEvent.scroll(window);
  await act(async () => {
    location.hash = "#subscriptions?profile=other";
  });
  await screen.findByRole("article", { name: "分流配置 Other" });
  await act(async () => {
    location.hash = "#subscriptions?profile=shared";
  });
  await screen.findByRole("article", { name: `分流配置 ${profile.name}` });
  expect(window.scrollTo).toHaveBeenLastCalledWith({
    top: 730,
    behavior: "instant",
  });
});

it("keyboard skip link keeps the owned entry and active subscription scope unchanged", async () => {
  history.replaceState(null, "", "#subscriptions?profile=shared");
  inventory([profile], []);
  mount();
  await screen.findByRole("article", { name: `分流配置 ${profile.name}` });
  const state = { ...history.state };
  const length = history.length;
  screen.getByRole("link", { name: "跳至主要内容" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement?.id).toBe("main");
  expect(location.hash).toBe("#subscriptions?profile=shared");
  expect(history.state).toEqual(state);
  expect(history.length).toBe(length);
  expect(
    screen.getByRole("article", { name: `分流配置 ${profile.name}` }),
  ).toBeTruthy();
});

it("retains only nonprivate history proof through logout and B login, not A's list context", async () => {
  inventory([profile], []);
  const base = globalThis.fetch;
  let account = "a";
  const session = () => ({
    user: {
      id: `account-${account}`,
      name: account.toUpperCase(),
      role: "user",
    },
    csrfToken: account,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (String(url).endsWith("/auth/login")) {
        account = "b";
        return json(session());
      }
      if (String(url).endsWith("/auth/me")) return json(session());
      return base(url, init);
    }),
  );
  mount();
  await userEvent.type(
    await screen.findByRole("textbox", { name: "搜索配置或客户端订阅" }),
    "A private search",
  );
  const initialProof = { ...history.state };
  await userEvent.click(screen.getByRole("button", { name: "订阅素材" }));
  await userEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  await screen.findByRole("heading", { name: "订阅来源", level: 1 });
  const sourceProof = { ...history.state };
  // Unknown third-party fields are deliberately not endorsed or carried through logout.
  history.replaceState(
    { ...sourceProof, unrelatedPrivateField: "do-not-copy" },
    "",
    location.href,
  );
  await userEvent.click(screen.getByRole("button", { name: /个人账号/ }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "退出登录" }),
  );
  await screen.findByRole("button", { name: "进入工作空间" });
  expect(location.hash).toBe("");
  expect(history.state).toEqual(sourceProof);
  await userEvent.type(screen.getByLabelText("账号"), "B fixture");
  await userEvent.type(screen.getByLabelText("密码"), "fixture-only");
  await userEvent.click(screen.getByRole("button", { name: "进入工作空间" }));
  const search = await screen.findByRole("textbox", {
    name: "搜索配置或客户端订阅",
  });
  expect((search as HTMLInputElement).value).toBe("");
  expect(history.state.routeweaverLineage).toBe(sourceProof.routeweaverLineage);
  expect(history.state.routeweaverPosition).toBe(
    sourceProof.routeweaverPosition,
  );
  await act(async () => history.back());
  await waitFor(() => expect(location.hash).toBe("#subscriptions"));
  expect(history.state).toEqual(initialProof);
  expect(
    (
      screen.getByRole("textbox", {
        name: "搜索配置或客户端订阅",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  await act(async () => history.forward());
  await waitFor(() => expect(location.hash).toBe(""));
  expect(history.state.routeweaverLineage).toBe(sourceProof.routeweaverLineage);
});

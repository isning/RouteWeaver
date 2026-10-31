// @vitest-environment jsdom
// Public-page read-readiness and opening-session contracts; staged pending approval.
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
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";
import { emptyProfile } from "./model";
import type { Output, OutputCreation, Profile } from "./types";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
let currentOwner: ReturnType<typeof ownedClickScenario>;
beforeEach((context) => {
  currentOwner = ownedClickScenario(context);
  onlineManager.setOnline(true);
  setToken("");
  setCSRF("");
  vi.stubEnv("NODE_ENV", "development");
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
  try {
    cleanup();
    clients.splice(0).forEach((client) => client.clear());
    onlineManager.setOnline(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  } finally {
    vi.unstubAllEnvs();
  }
});

function fixture(fullApp = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const state = {
    account: "A",
    sessionReads: 0,
    readProfiles: async (): Promise<Response> => json([profile]),
    loseCreation: false,
    receipt: null as Output | null,
    readOutputs: undefined as undefined | (() => Promise<Response>),
    createResponse: undefined as undefined | (() => Promise<Response>),
  };
  const previews: OutputCreation[] = [];
  const creates: (OutputCreation & { previewDigest: string })[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (method === "GET") reads.push(path);
      if (path === "/api/auth/me") {
        state.sessionReads++;
        return json({
          user: {
            id: state.account,
            name: `Account ${state.account}`,
            role: "user",
          },
          csrfToken: `csrf-${state.account}`,
        });
      }
      if (path === "/api/me/overview")
        return json({ status: "active", user: {}, routes: [] });
      if (path === "/api/me/profiles") return state.readProfiles();
      if (path === "/api/me/outputs/preview") {
        previews.push(body);
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: `review-${body.id}`,
          artifacts: [{ path: "config.json", content: "reviewed" }],
        });
      }
      if (path === "/api/me/outputs" && method === "POST") {
        creates.push(body);
        if (state.createResponse) return state.createResponse();
        if (state.loseCreation) throw new TypeError("response lost");
        return json({
          ...body,
          status: "published",
          creationReviewDigest: body.previewDigest,
        });
      }
      if (path === "/api/me/outputs")
        return state.readOutputs
          ? state.readOutputs()
          : json(state.receipt ? [state.receipt] : []);
      if (
        creates.some(
          (creation) => path === `/api/me/outputs/${creation.id}/access`,
        ) &&
        method === "GET"
      )
        return json({ feedPath: "/feed/contract" });
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        {fullApp ? <Workspace /> : <SubscriptionsPage />}
      </UIProviders>
    </QueryClientProvider>,
  );
  return { client, state, previews, creates, reads };
}
async function openReviewed(
  name = "My phone",
  owner?: ReturnType<typeof ownedClickScenario>,
) {
  owner?.assertActive();
  const create = await screen.findByRole("button", {
    name: "为 Daily 新增客户端订阅",
  });
  owner?.assertActive();
  await userEvent.click(create);
  owner?.assertActive();
  const nameInput = await screen.findByLabelText("订阅名称");
  owner?.assertActive();
  fireEvent.change(nameInput, {
    target: { value: name },
  });
  for (const [label, option] of [
    ["目标客户端", "sing-box 1.14.3"],
    ["输出内容", "纯节点输出"],
  ]) {
    owner?.assertActive();
    await userEvent.click(screen.getByRole("combobox", { name: label }));
    owner?.assertActive();
    const choice = await screen.findByRole("option", { name: option });
    owner?.assertActive();
    await userEvent.click(choice);
    owner?.assertActive();
  }
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  owner?.assertActive();
  await screen.findByText("兼容检查通过。");
  owner?.assertActive();
}
function retained(name = "My phone", historical = false) {
  const task = screen.getByRole("dialog", { name: "新增客户端订阅" });
  expect(
    within(task).getByRole("textbox", { name: "订阅名称" }),
  ).toHaveProperty("value", name);
  expect(
    within(task).getByRole("combobox", { name: "目标客户端" })?.textContent,
  ).toContain("sing-box 1.14.3");
  expect(
    within(task).getByRole("combobox", { name: "输出内容" })?.textContent,
  ).toContain("纯节点输出");
  expect(
    within(task).getByText(
      historical ? "发布前的兼容检查已通过。" : "兼容检查通过。",
    ),
  ).toBeTruthy();
  return within(task);
}
async function publishRetained(t: ReturnType<typeof fixture>) {
  await userEvent.click(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  );
  await screen.findByRole("dialog", { name: "获取「My phone」" });
  expect(t.previews).toHaveLength(1);
  expect(t.creates).toEqual([
    { ...t.previews[0], previewDigest: `review-${t.previews[0].id}` },
  ]);
}
const readError = "暂时无法读取分流配置，当前选择已保留。";
const missing = "此分流配置已不在当前可访问范围。";

it("keeps an ordinary checked draft through pending and failed profile reads without repeating inspection", async () => {
  const t = fixture();
  await openReviewed();
  let finish!: (response: Response) => void;
  t.state.readProfiles = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  act(() => {
    void t.client.invalidateQueries({ queryKey: ["profiles"] });
  });
  await screen.findByText("正在核对分流配置…");
  expect(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  ).toHaveProperty("disabled", true);
  expect(retained().getByRole("button", { name: "重新检查" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(t.previews).toHaveLength(1);
  expect(t.creates).toHaveLength(0);
  await act(async () => finish(json({ message: "Read unavailable" }, 503)));
  await screen.findByText(readError);
  expect(screen.queryByText("暂时无法加载分流配置")).toBeNull();
  expect(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  ).toHaveProperty("disabled", true);
  t.state.readProfiles = async () => json([{ ...profile }]);
  await userEvent.click(retained().getByRole("button", { name: "重试配置" }));
  await waitFor(() =>
    expect(
      retained().getByRole("button", { name: "创建并发布「My phone」" }),
    ).toHaveProperty("disabled", false),
  );
  expect(t.previews).toHaveLength(1);
  expect(t.creates).toHaveLength(0);
  await publishRetained(t);
});

it("does not turn a paused cached profile read into publication authority or discard its valid review", async () => {
  const t = fixture();
  await openReviewed();
  const priorReads = t.reads.filter(
    (path) => path === "/api/me/profiles",
  ).length;
  let finish!: (response: Response) => void;
  t.state.readProfiles = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  act(() => {
    onlineManager.setOnline(false);
    void t.client.invalidateQueries({ queryKey: ["profiles"] });
  });
  await screen.findByText("当前离线，恢复网络后继续核对。");
  expect(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  ).toHaveProperty("disabled", true);
  expect(t.reads.filter((path) => path === "/api/me/profiles")).toHaveLength(
    priorReads,
  );
  expect(t.creates).toHaveLength(0);
  expect(t.previews).toHaveLength(1);
  act(() => onlineManager.setOnline(true));
  await screen.findByText("正在核对分流配置…");
  expect(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  ).toHaveProperty("disabled", true);
  await act(async () => finish(json([profile])));
  await waitFor(() =>
    expect(
      retained().getByRole("button", { name: "创建并发布「My phone」" }),
    ).toHaveProperty("disabled", false),
  );
  expect(t.creates).toHaveLength(0);
  expect(t.previews).toHaveLength(1);
  await publishRetained(t);
});

it("keeps the requested profile distinct from confirmed absence and never substitutes another profile", async () => {
  const t = fixture();
  await openReviewed();
  const other: Profile = {
    ...profile,
    id: "other-profile",
    name: "Other profile",
  };
  t.state.readProfiles = async () => json([other]);
  await act(async () => {
    await t.client.invalidateQueries({ queryKey: ["profiles"] });
  });
  await screen.findByText(missing);
  expect(screen.queryByText(readError)).toBeNull();
  expect(retained().getByText("Daily")).toBeTruthy();
  expect(retained().queryByText("Other profile")).toBeNull();
  expect(
    retained().getByRole("button", { name: "创建并发布「My phone」" }),
  ).toHaveProperty("disabled", true);
  expect(t.previews).toHaveLength(1);
  expect(t.creates).toHaveLength(0);
  t.state.readProfiles = async () => json([other, profile]);
  await userEvent.click(retained().getByRole("button", { name: "重试配置" }));
  await waitFor(() =>
    expect(
      retained().getByRole("button", { name: "创建并发布「My phone」" }),
    ).toHaveProperty("disabled", false),
  );
  await publishRetained(t);
  expect(t.creates[0].profileId).toBe("saved-profile");
});

it.each(["error", "missing"] as const)(
  "recovers the exact uncertain receipt while its profile remains %s",
  async (state) => {
    const t = fixture();
    t.state.loseCreation = true;
    await openReviewed();
    await userEvent.click(
      retained().getByRole("button", { name: "创建并发布「My phone」" }),
    );
    const recover = await screen.findByRole("button", {
      name: "核对上次发布结果",
    });
    await waitFor(() => expect(recover).toHaveProperty("disabled", false));
    t.state.readProfiles = async () =>
      state === "error" ? json({ message: "Unavailable" }, 503) : json([]);
    await act(async () => {
      await t.client.invalidateQueries({ queryKey: ["profiles"] });
    });
    await screen.findByText(state === "error" ? readError : missing);
    expect(
      retained(undefined, true).getByRole("button", { name: "重试上次发布" }),
    ).toHaveProperty("disabled", true);
    const profileReads = t.reads.filter(
      (path) => path === "/api/me/profiles",
    ).length;
    t.state.receipt = {
      ...t.creates[0],
      status: "published",
      creationReviewDigest: t.creates[0].previewDigest,
    };
    await userEvent.click(
      retained(undefined, true).getByRole("button", {
        name: "核对上次发布结果",
      }),
    );
    await screen.findByRole("dialog", { name: "获取「My phone」" });
    await waitFor(() =>
      expect(t.reads).toContain(`/api/me/outputs/${t.creates[0].id}/access`),
    );
    expect(t.reads.filter((path) => path === "/api/me/profiles")).toHaveLength(
      profileReads,
    );
    expect(t.previews).toHaveLength(1);
    expect(t.creates).toHaveLength(1);
  },
);

it("resets a deliberately canceled unavailable creation only on a new explicit opening", async () => {
  const t = fixture();
  await openReviewed();
  t.state.readProfiles = async () => json({ message: "Unavailable" }, 503);
  await act(async () => {
    await t.client.invalidateQueries({ queryKey: ["profiles"] });
  });
  await screen.findByText(readError);
  await userEvent.click(retained().getByRole("button", { name: /取\s*消/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull(),
  );
  t.state.readProfiles = async () => json([profile]);
  await userEvent.click(
    await screen.findByRole("button", { name: "重试配置" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "为 Daily 新增客户端订阅" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "订阅名称" }),
  ).toHaveProperty("value", "Daily");
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  expect(t.previews).toHaveLength(2);
  expect(t.previews[1].id).not.toBe(t.previews[0].id);
  expect(t.previews[1]).toMatchObject({
    name: "Daily",
    target: profile.target,
    mode: "full",
  });
  expect(t.creates).toHaveLength(0);
});

it("preserves this publication through same-account resume read failure but discards it on account replacement", async () => {
  const t = fixture(true);
  await screen.findByText("Account A");
  await openReviewed("Private A phone");
  const previous = t.state.sessionReads;
  t.state.readProfiles = async () =>
    json({ message: "Unavailable after resume" }, 503);
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await waitFor(() => expect(t.state.sessionReads).toBeGreaterThan(previous));
  await screen.findByText(readError);
  expect(
    retained("Private A phone").getByRole("button", {
      name: "创建并发布「Private A phone」",
    }),
  ).toHaveProperty("disabled", true);
  expect(t.previews).toHaveLength(1);
  expect(t.creates).toHaveLength(0);
  t.state.readProfiles = async () => json([profile]);
  await userEvent.click(
    retained("Private A phone").getByRole("button", { name: "重试配置" }),
  );
  await waitFor(() =>
    expect(
      retained("Private A phone").getByRole("button", {
        name: "创建并发布「Private A phone」",
      }),
    ).toHaveProperty("disabled", false),
  );
  t.state.account = "B";
  t.state.readProfiles = async () => json([{ ...profile, name: "B profile" }]);
  fireEvent(window, new Event("offline"));
  fireEvent(window, new Event("online"));
  await screen.findByText("Account B");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull(),
  );
  expect(screen.queryByDisplayValue("Private A phone")).toBeNull();
  await userEvent.click(
    await screen.findByRole("button", { name: "为 B profile 新增客户端订阅" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "订阅名称" }),
  ).toHaveProperty("value", "B profile");
  expect(screen.queryByText("兼容检查通过。")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  expect(t.previews).toHaveLength(2);
  expect(t.previews[1].id).not.toBe(t.previews[0].id);
  expect(t.creates).toHaveLength(0);
});

it.each(["receipt", "retry"] as const)(
  "keeps the uncertain %s action name stable and exposes busy state while its response is held",
  async (action) => {
    // Capture this test's native owner now, never after an old await resumes.
    const owner = currentOwner;
    owner.assertActive();
    const t = fixture();
    t.state.loseCreation = true;
    await openReviewed(undefined, owner);
    owner.assertActive();
    await userEvent.click(
      retained().getByRole("button", { name: "创建并发布「My phone」" }),
    );
    owner.assertActive();
    const label = action === "receipt" ? "核对上次发布结果" : "重试上次发布";
    const control = await screen.findByRole("button", {
      name: label,
    });
    owner.assertActive();
    await waitFor(() => expect(control).toHaveProperty("disabled", false));
    owner.assertActive();
    const original = t.creates[0];
    let finish!: (response: Response) => void;
    let started = false;
    const held = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const hold = () => {
      started = true;
      return held;
    };
    if (action === "receipt") t.state.readOutputs = hold;
    else t.state.createResponse = hold;
    try {
      owner.assertActive();
      await userEvent.click(control);
      owner.assertActive();
      await waitFor(() => expect(started).toBe(true));
      owner.assertActive();
      const busyControl = screen.getByRole("button", {
        name: label,
      });
      expect(busyControl.getAttribute("aria-busy")).toBe("true");
      expect(busyControl).toHaveProperty("disabled", true);
      expect(t.previews).toHaveLength(1);
      expect(t.creates).toEqual(
        action === "receipt" ? [original] : [original, original],
      );
    } finally {
      // Always release the fixture-owned response, even after native abort.
      await act(async () =>
        finish(
          action === "receipt"
            ? json([])
            : json({ message: "Still unavailable" }, 503),
        ),
      );
    }
    owner.assertActive();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: label }).getAttribute("aria-busy"),
      ).not.toBe("true"),
    );
    owner.assertActive();
  },
);

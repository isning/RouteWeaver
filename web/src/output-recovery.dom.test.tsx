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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";

const clients: QueryClient[] = [];
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const profile = { ...emptyProfile(), id: "repair-profile", name: "日常分流" };
profile.ir.defaultAction = { kind: "endpoint", ref: "removed" };
const output = {
  id: "macbook",
  name: "MacBook",
  profileId: profile.id,
  target: { adapterId: "mihomo", version: "1.19.32" },
  mode: "full",
  status: "published",
  routingSummary: {
    version: 1,
    kind: "advanced",
    advanced: {
      defaultAction: { kind: "endpoint", label: "香港-日常" },
      ruleCount: 0,
      groupCount: 0,
      nodeCount: 1,
    },
  },
};
const comparison = {
  state: "unavailable",
  reason: "missing-action-reference",
  location: "default",
};
beforeEach(() => {
  history.replaceState(null, "", "#subscriptions?output=macbook");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
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
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
}
it("opens named missing-reference recovery, keeps reveal failure in its detail, and returns to the same Output without writing", async () => {
  let revealFails = true;
  const writes: string[] = [];
  const reveals: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs"))
        return json([output, { ...output, id: "android", name: "Android" }]);
      if (path.endsWith("/macbook/status"))
        return json({ ...output, draftComparison: comparison });
      if (path.endsWith("/reveal")) {
        reveals.push(path);
        return revealFails
          ? json({ detail: "配置暂时无法读取，请重试" }, 503)
          : json(profile);
      }
      if (path.endsWith("/collections/preview"))
        return json({ endpoints: [], stages: [] });
      if (init?.method && init.method !== "GET") writes.push(path);
      return json([]);
    }),
  );
  mount();
  const user = userEvent.setup();
  let detail = await screen.findByRole("dialog", {
    name: "订阅详情 · MacBook",
  });
  expect(
    await within(detail).findByText(
      "已保存配置的默认流量去向不可用。已发布内容未因此改变。",
    ),
  ).toBeTruthy();
  expect(
    within(detail).queryByRole("button", { name: "重新检查更新" }),
  ).toBeNull();
  await user.click(
    within(detail).getByRole("button", { name: "修复「日常分流」配置" }),
  );
  expect(
    await within(detail).findByText("配置暂时无法读取，请重试"),
  ).toBeTruthy();
  expect(location.hash).toBe("#subscriptions?output=macbook");
  revealFails = false;
  await user.click(
    within(detail).getByRole("button", { name: "修复「日常分流」配置" }),
  );
  expect(
    await screen.findByRole("alert", { name: "部分流量去向当前不可用" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "配置名称" }) as HTMLInputElement)
      .value,
  ).toBe("日常分流");
  await user.click(screen.getByRole("button", { name: "返回" }));
  detail = await screen.findByRole("dialog", { name: "订阅详情 · MacBook" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(detail).getByRole("button", { name: "修复「日常分流」配置" }),
    ),
  );
  expect(reveals).toEqual([
    "/api/me/profiles/repair-profile/reveal",
    "/api/me/profiles/repair-profile/reveal",
  ]);
  expect(writes).toEqual([]);
  expect(location.hash).toBe("#subscriptions?output=macbook");
});

it("returns after a saved repair to the stable same-Output update action when the repair entry disappears", async () => {
  let repaired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (
        path.endsWith("/profiles") &&
        (!init?.method || init.method === "GET")
      )
        return json([profile]);
      if (path.endsWith("/outputs"))
        return json([output, { ...output, id: "android", name: "Android" }]);
      if (path.endsWith("/macbook/status"))
        return json({
          ...output,
          draftComparison: repaired ? { state: "changed" } : comparison,
        });
      if (path.endsWith("/reveal")) return json(profile);
      if (path.endsWith("/collections/preview"))
        return json({ endpoints: [], stages: [] });
      if (path.endsWith("/profiles/repair-profile") && init?.method === "PUT") {
        repaired = true;
        return json(JSON.parse(String(init.body)));
      }
      return json([]);
    }),
  );
  mount();
  const user = userEvent.setup();
  const detail = await screen.findByRole("dialog", {
    name: "订阅详情 · MacBook",
  });
  await user.click(
    await within(detail).findByRole("button", { name: "修复「日常分流」配置" }),
  );
  await user.click(
    await screen.findByRole("combobox", { name: "默认流量行为" }),
  );
  await user.click(await screen.findByRole("option", { name: "直连" }));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("group", { name: "保存与检查配置" })).getByRole(
        "status",
      ).textContent,
    ).toBe("草稿已保存"),
  );
  await user.click(screen.getByRole("button", { name: "返回" }));
  const returned = await screen.findByRole("dialog", {
    name: "订阅详情 · MacBook",
  });
  await within(returned).findByText("已保存的修改尚未发布");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(returned).getByRole("button", { name: "检查更新" }),
    ),
  );
  expect(location.hash).toBe("#subscriptions?output=macbook");
});

it("does not reopen a canceled recovery or retarget it when its delayed reveal finishes", async () => {
  let finish!: (response: Response) => void;
  const reveal = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/overview")) return json({ user: {}, routes: [] });
      if (path.endsWith("/profiles")) return json([profile]);
      if (path.endsWith("/outputs"))
        return json([output, { ...output, id: "android", name: "Android" }]);
      if (path.endsWith("/macbook/status"))
        return json({ ...output, draftComparison: comparison });
      if (path.endsWith("/android/status"))
        return json({
          ...output,
          id: "android",
          name: "Android",
          draftComparison: { state: "unchanged" },
        });
      if (path.endsWith("/reveal")) return reveal;
      return json([]);
    }),
  );
  mount();
  const user = userEvent.setup();
  const detail = await screen.findByRole("dialog", {
    name: "订阅详情 · MacBook",
  });
  await user.click(
    await within(detail).findByRole("button", { name: "修复「日常分流」配置" }),
  );
  expect(
    within(detail)
      .getByRole("button", { name: "修复「日常分流」配置" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  for (const name of ["获取订阅", "检查更新", "更多操作"]) {
    expect(
      (within(detail).getByRole("button", { name }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  }
  await user.click(within(detail).getByRole("button", { name: "关闭" }));
  await user.click(screen.getByRole("button", { name: "查看订阅 Android" }));
  await screen.findByRole("dialog", { name: "订阅详情 · Android" });
  await act(async () => finish(json(profile)));
  expect(screen.queryByRole("textbox", { name: "配置名称" })).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "订阅详情 · Android" }),
  ).toBeTruthy();
  expect(location.hash).toBe("#subscriptions?output=android");
});

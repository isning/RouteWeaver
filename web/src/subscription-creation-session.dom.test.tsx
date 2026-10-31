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
import { SubscriptionsPage } from "./Subscriptions";
import { emptyProfile } from "./model";
import type { Output, OutputCreation } from "./types";

const profile = { ...emptyProfile(), id: "saved-profile", name: "Daily" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the same uncertain creation and customized choices through a failed profile refresh, then recovers its receipt without another create", async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  let profilesUnavailable = false;
  let receipt: Output | null = null;
  const creates: (OutputCreation & { previewDigest: string })[] = [];
  const previews: OutputCreation[] = [];
  const accessReads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const path = String(url),
        method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path === "/api/me/overview")
        return json({ status: "active", routes: [] });
      if (path === "/api/me/profiles")
        return profilesUnavailable
          ? json({ message: "Profile read unavailable" }, 503)
          : json([profile]);
      if (path === "/api/me/outputs/preview") {
        previews.push(body);
        return json({
          valid: true,
          previewScope: "new-output",
          outputId: body.id,
          previewDigest: "phone-review",
          artifacts: [{ path: "config.json", content: "reviewed" }],
        });
      }
      if (path === "/api/me/outputs" && method === "POST") {
        creates.push(body);
        // Accepted write, lost response; the receipt is not readable yet.
        throw new TypeError("response lost");
      }
      if (path === "/api/me/outputs") return json(receipt ? [receipt] : []);
      if (
        creates[0] &&
        path === `/api/me/outputs/${creates[0].id}/access` &&
        method === "GET"
      ) {
        accessReads.push(path);
        return json({ feedPath: "/feed/recovered-phone" });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <SubscriptionsPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "为 Daily 新增客户端订阅" }),
  );
  fireEvent.change(await screen.findByLabelText("订阅名称"), {
    target: { value: "Personal phone" },
  });
  for (const [label, option] of [
    ["目标客户端", "sing-box 1.14.3"],
    ["输出内容", "纯节点输出"],
  ]) {
    await userEvent.click(screen.getByRole("combobox", { name: label }));
    await userEvent.click(await screen.findByRole("option", { name: option }));
  }
  await userEvent.click(screen.getByRole("button", { name: "检查发布内容" }));
  await screen.findByText("兼容检查通过。");
  await userEvent.click(
    screen.getByRole("button", { name: "创建并发布「Personal phone」" }),
  );
  await screen.findByRole("button", { name: "核对上次发布结果" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "核对上次发布结果" }),
    ).toHaveProperty("disabled", false),
  );
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    name: "Personal phone",
    profileId: profile.id,
    target: { adapterId: "sing-box", version: "1.14.3" },
    mode: "nodes-only",
    previewDigest: "phone-review",
  });
  expect(creates[0].id).toBe(previews[0].id);

  profilesUnavailable = true;
  // Public query-client invalidation models background/same-account-resume refresh;
  // no child props or internal state are controlled.
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["profiles"] });
  });
  // Observe the committed read-failure UI, not just the completed fetch promise.
  // First alternative is the existing inventory status; second is the reviewed
  // task-local copy, so the same public contract works before and after the fix.
  await screen.findByText(
    /^(暂时无法加载分流配置|暂时无法读取分流配置，当前选择已保留。)$/,
  );
  const task = screen.getByRole("dialog", { name: "新增客户端订阅" });
  expect(
    within(task).getByRole("textbox", { name: "订阅名称" }),
  ).toHaveProperty("value", "Personal phone");
  expect(
    within(task).getByRole("button", { name: "重试上次发布" }),
  ).toHaveProperty("disabled", true);
  expect(
    within(task).getByRole("button", { name: "核对上次发布结果" }),
  ).toHaveProperty("disabled", false);
  expect(creates).toHaveLength(1);

  profilesUnavailable = false;
  await userEvent.click(within(task).getByRole("button", { name: "重试配置" }));
  await waitFor(() =>
    expect(within(task).queryByRole("button", { name: "重试配置" })).toBeNull(),
  );
  expect(
    within(task).getByRole("textbox", { name: "订阅名称" }),
  ).toHaveProperty("value", "Personal phone");
  expect(
    within(task).getByRole("combobox", { name: "目标客户端" })?.textContent,
  ).toContain("sing-box 1.14.3");
  expect(
    within(task).getByRole("combobox", { name: "输出内容" })?.textContent,
  ).toContain("纯节点输出");
  // Read readiness is not a new review/session: harmless same-ID recovery
  // neither discards the existing review nor inspects again.
  expect(within(task).getByText("发布前的兼容检查已通过。")).toBeTruthy();
  expect(previews).toHaveLength(1);
  // Only the original identity/digest can match this server receipt.
  receipt = {
    ...creates[0],
    status: "published",
    creationReviewDigest: "phone-review",
  };
  await userEvent.click(
    within(task).getByRole("button", { name: "核对上次发布结果" }),
  );
  await screen.findByRole("dialog", { name: "获取「Personal phone」" });
  await waitFor(() =>
    expect(accessReads).toEqual([`/api/me/outputs/${creates[0].id}/access`]),
  );
  expect(previews).toHaveLength(1);
  expect(creates).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "新增客户端订阅" })).toBeNull();
});

// @vitest-environment jsdom
// Rendered public tasks; explicit geometry seam supports DOM ownership only.
// Actual natural traversal/visibility is independently browser-owned.
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
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { BackupSettings } from "./Backup";
import { ServersPage } from "./Infrastructure";
import { ProfileEditor } from "./Profiles";
import {
  SubscriptionsPage,
  UpdateOutput,
  ProfilePublicationDialog,
} from "./Subscriptions";
import { RateSettings } from "./Rates";
import { ServerRoutesPage } from "./ServerRoutes";
import { emptyProfile } from "./model";
import type { Output } from "./types";
const profile = {
  ...emptyProfile(),
  id: "matrix-profile",
  name: "Matrix draft",
};
profile.ir.endpoints = [
  {
    id: "a",
    name: "A connection",
    origin: "imported",
    connection: { protocol: "socks", host: "a.example.test", port: 1080 },
  },
];
const output: Output = {
  id: "matrix-output",
  name: "Matrix subscription",
  profileId: profile.id,
  target: profile.target,
  mode: "full",
  status: "published",
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
const writes: string[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  history.replaceState(null, "", "#subscriptions");
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
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const path = String(input);
      // The existing output-update preview is a read-only HTTP seam, not publish.
      if (
        init?.method === "POST" &&
        path === `/api/me/profiles/${profile.id}/preview`
      )
        return json({
          valid: true,
          outputId: output.id,
          previewScope: "output-update",
          previewDigest: "a".repeat(64),
          publicationEffect: { version: 1, link: "preserve" },
          artifacts: [],
        });
      if (init?.method && init.method !== "GET") {
        writes.push(`${init.method} ${input}`);
        throw new Error("No task submission is allowed in this boundary test");
      }
      if (path === "/api/me/profiles") return json([profile]);
      if (path === "/api/me/outputs") return json([output]);
      if (path === "/api/me/overview") return json({ routes: [] });
      if (path === `/api/me/outputs/${output.id}/status`)
        return json({ ...output, draftComparison: { state: "same" } });
      return json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  writes.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <UIProviders>{node}</UIProviders>
    </QueryClientProvider>,
  );
}
async function boundary(
  title: string | RegExp,
  lastName: string | RegExp,
  stableScroll = false,
) {
  const dialog = await screen.findByRole("dialog", { name: title });
  await waitFor(() =>
    expect(/-appear|-enter/.test(dialog.className)).toBe(false),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const shown = !this.closest('[hidden], [aria-hidden="true"]');
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: shown ? 100 : 0,
        bottom: shown ? 38 : 0,
        width: shown ? 100 : 0,
        height: shown ? 38 : 0,
        toJSON() {
          return {};
        },
      };
    },
  );
  const close = within(dialog).getByRole("button", { name: "关闭" });
  const last = within(dialog).getByRole("button", { name: lastName });
  expect((last as HTMLButtonElement).disabled).toBe(false);
  last.focus();
  expect(document.activeElement).toBe(last);
  const closeFocus = vi.spyOn(close, "focus");
  const lastFocus = vi.spyOn(last, "focus");
  expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(close);
  expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
  if (stableScroll) {
    expect(closeFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(lastFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  }
  expect(writes).toEqual([]);
}
it("keeps normal backup creation button boundaries without entering passwords or exporting", async () => {
  mount(<BackupSettings />);
  await userEvent.click(screen.getByRole("button", { name: "创建加密备份" }));
  await boundary("创建加密备份", "加密并下载");
});

it("keeps the blank new-server editor boundaries without saving inventory", async () => {
  mount(<ServersPage />);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "添加服务器" }))[0],
  );
  await boundary("添加服务器", /^保\s*存$/);
});
it("keeps the contextual group dialog boundaries without editing or creating a group", async () => {
  mount(<ProfileEditor initial={profile} isNew={false} onClose={() => {}} />);
  await userEvent.click(
    screen.getByRole("button", { name: "默认流量：使用多个候选连接…" }),
  );
  await boundary("创建并使用策略组", /^取\s*消$/);
});
it("keeps subscription details boundaries without opening or activating the actions menu", async () => {
  history.replaceState(null, "", "#subscriptions?output=matrix-output");
  mount(<SubscriptionsPage />);
  await boundary("Matrix subscription 的订阅详情", "更多操作", true);
});
it("keeps the reviewed update boundaries without confirming a publication", async () => {
  mount(<UpdateOutput output={output} onClose={() => {}} autoInspect />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "确认更新「Matrix subscription」",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  await boundary(
    "检查订阅更新「Matrix subscription」",
    "确认更新「Matrix subscription」",
    true,
  );
});
it("keeps the saved-draft target chooser boundaries without selecting or publishing a target", async () => {
  mount(<ProfilePublicationDialog profile={profile} onClose={() => {}} />);
  await screen.findByRole("radio", { name: /更新「Matrix subscription」/ });
  await boundary("选择客户端订阅", "返回编辑");
});
it("keeps the empty rate adjustment boundaries without entering values or writing a version", async () => {
  mount(<RateSettings routes={[]} />);
  await userEvent.click(screen.getByRole("button", { name: "调整倍率" }));
  await boundary("调整线路扣量倍率", "保存倍率版本");
});
it("keeps the blank server-intent JSON dialog boundaries without editing or applying JSON", async () => {
  mount(<ServerRoutesPage />);
  await userEvent.click(
    (await screen.findAllByRole("button", { name: "新建转发路径" }))[0],
  );
  await userEvent.click(
    screen.getByRole("button", { name: "高级：完整服务端意图" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "编辑服务端意图" }));
  await boundary("服务端配置意图", "应用到草稿");
});

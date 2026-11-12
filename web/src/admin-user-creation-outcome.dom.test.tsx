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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import App from "./App";
import { setCSRF, setToken } from "./api";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { getNavigationWarning, useUnsavedChanges } from "./navigation";
import type { UserRecord } from "./types";
let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
type Outcome =
  | "post-commit 500"
  | "lost response"
  | "unreadable success"
  | "wrong user receipt"
  | "invalid receipt"
  | "untagged 400"
  | "definite rejection"
  | "delayed commit";
beforeEach((context) => {
  owner = ownedClickScenario(context);
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/#users");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "BroadcastChannel",
    class extends EventTarget {
      postMessage() {}
      close() {}
    },
  );
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
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
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/");
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function OtherDraft() {
  useUnsavedChanges(true, "另一项编辑也需要保留。");
  return null;
}
function ReviewOwner({ onReview }: { onReview: () => void }) {
  useUnsavedChanges(true, "独立草稿尚待处理。", onReview);
  return null;
}
function ReviewLifecycleControl() {
  const [active, setActive] = useState(true);
  const [count, setCount] = useState(0);
  return (
    <>
      <button onClick={() => setActive((value) => !value)}>切换独立草稿</button>
      <p>独立草稿确认次数：{count}</p>
      {active && (
        <ReviewOwner onReview={() => setCount((value) => value + 1)} />
      )}
    </>
  );
}
function mount(
  outcome: Outcome,
  workspace = false,
  otherDraft = false,
  observe = false,
) {
  const writes: { body: UserRecord; condition: string | null }[] = [];
  const saved = new Map<string, UserRecord>();
  let nextRead: (() => Promise<Response>) | undefined;
  let heldWrite: ReturnType<typeof deferred<Response>> | undefined;
  let retryRejected = false;
  const state = () => ({
    users: [...saved.values()],
    nodes: [],
    routes: [],
    revisions: [],
    capabilities: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/users" && init?.method === "POST") {
        const value = JSON.parse(String(init.body)) as UserRecord,
          condition = new Headers(init.headers).get("If-None-Match");
        writes.push({ body: value, condition });
        if (heldWrite) return heldWrite.promise;
        if (
          (writes.length === 1 && outcome === "definite rejection") ||
          retryRejected
        )
          return json(
            {
              code: "USER_CREATION_INVALID",
              detail: "valid id, name and non-negative quota required",
            },
            400,
          );
        // Models the inspected opt-in contract, not evidence that Go tests passed.
        if (condition === "*" && saved.has(value.id))
          return json(
            {
              code: "USER_CREATION_CONFLICT",
              detail: "user ID already exists",
            },
            412,
          );
        if (writes.length === 1 && outcome === "delayed commit")
          throw new TypeError("Lost response before delayed commit");
        saved.set(value.id, value);
        if (writes.length === 1) {
          if (outcome === "lost response")
            throw new TypeError("Lost response after commit");
          if (outcome === "unreadable success")
            return new Response("{", { status: 200 });
          if (outcome === "invalid receipt") return json({ ok: true });
          if (outcome === "wrong user receipt")
            return json({ ...value, id: "different-user" });
          if (outcome === "post-commit 500")
            return json({ detail: "saved user unavailable" }, 500);
          if (outcome === "untagged 400")
            return json({ detail: "storage outcome unavailable" }, 400);
        }
        return json(value);
      }
      if (init?.method && init.method !== "GET")
        throw new Error("Unexpected mutation");
      if (url === "/api/state") {
        if (nextRead) {
          const read = nextRead;
          nextRead = undefined;
          return read();
        }
        return json(state());
      }
      if (workspace && url === "/api/auth/me")
        return json({
          user: { id: "admin", name: "Admin", role: "admin" },
          csrfToken: "fixture",
        });
      if (workspace && url === "/api/settings")
        return json({ name: "RouteWeaver", registration: "invite" });
      if (workspace && url === "/api/me/notifications") return json([]);
      if (url === "/api/services" || url === "/api/published-routes")
        return json([]);
      throw new Error("Unexpected request");
    }),
  );
  const renderPage = () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    clients.push(client);
    return render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <UIProviders>
            {otherDraft && <OtherDraft />}
            {observe && <ReviewLifecycleControl />}
            {workspace ? <App /> : <AdminPage page="users" />}
          </UIProviders>
        </QueryClientProvider>
      </StrictMode>,
    );
  };
  const view = renderPage();
  return {
    writes,
    view,
    renderPage,
    changeSaved(change: Partial<UserRecord>) {
      const record = writes[0].body;
      saved.set(record.id, { ...record, ...change });
    },
    commitFirst() {
      const record = writes[0].body;
      if (!saved.has(record.id)) saved.set(record.id, record);
    },
    failRead() {
      nextRead = async () => json({ detail: "用户列表暂时无法读取" }, 503);
    },
    rejectRetry() {
      retryRejected = true;
    },
    holdRead() {
      const read = deferred<Response>();
      nextRead = () => read.promise;
      return () => read.resolve(json(state()));
    },
    holdWrite() {
      heldWrite = deferred<Response>();
      return () => {
        const value = writes[0].body;
        saved.set(value.id, value);
        heldWrite!.resolve(json(value));
        heldWrite = undefined;
      };
    },
  };
}
async function open() {
  await owner.click(() => screen.findByRole("button", { name: "添加用户" }));
  return screen.findByRole("dialog", { name: "添加用户" });
}
async function start() {
  const d = await open();
  owner.change(() => within(d).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "One intended user" },
  });
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  return d;
}
async function unknown(d: HTMLElement) {
  await within(d).findByText("尚未确认用户是否创建");
}
async function check(d: HTMLElement) {
  await owner.click(() =>
    within(d).getByRole("button", { name: "检查创建结果" }),
  );
}
async function closed() {
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "添加用户" })).toBeNull(),
  );
}
async function closeUnknown(d: HTMLElement) {
  await owner.click(() => within(d).getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog");
  expect(decision.textContent).toContain("关闭不会撤销创建");
  expect(decision.textContent).toContain("再次添加会开始新的创建");
  expect(decision.textContent).not.toContain("尚未保存");
  await owner.click(() =>
    within(decision).getByRole("button", { name: "关闭窗口" }),
  );
  await closed();
}
it.each([
  "post-commit 500",
  "lost response",
  "unreadable success",
  "invalid receipt",
  "wrong user receipt",
  "untagged 400",
] as const)("checks the exact user read-only after %s", async (outcome) => {
  const f = mount(outcome),
    d = await start();
  await unknown(d);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].condition).toBe("*");
  expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
  expect(
    within(d)
      .getByRole("textbox", { name: "用户名称" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.submit(d.querySelector("form")!);
  await act(async () => {});
  expect(f.writes).toHaveLength(1);
  await check(d);
  await closed();
  expect(
    await screen.findAllByRole("button", { name: "One intended user" }),
  ).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
});
it("retries only the guarded same ID and snapshot after absent readback", async () => {
  const f = mount("delayed commit"),
    d = await start();
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的用户");
  expect(d.textContent).toContain("之前的请求仍可能完成");
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await closed();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(f.writes[1].condition).toBe("*");
  f.commitFirst();
  expect(
    await screen.findAllByRole("button", { name: "One intended user" }),
  ).toHaveLength(1);
});
it("does not overwrite intervening edits when the original commits after absent readback", async () => {
  const f = mount("delayed commit"),
    d = await start();
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的用户");
  f.commitFirst();
  f.changeSaved({
    name: "Later operator edit",
    enabled: false,
    quotaBytes: 7,
    usedBytes: 3,
  });
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await unknown(d);
  expect(f.writes[1]).toEqual(f.writes[0]);
  await check(d);
  await within(d).findByText("已有用户的资料与本次提交不同");
  expect(d.textContent).toContain("Later operator edit");
  expect(d.textContent).toContain("已停用");
  expect(d.textContent).toContain("7 B");
  expect(within(d).queryByRole("button", { name: "重试本次创建" })).toBeNull();
  expect(f.writes).toHaveLength(2);
});
it.each([{ name: "Other name" }, { enabled: false }, { quotaBytes: 7 }])(
  "does not overwrite differing readback %j",
  async (change) => {
    const f = mount("post-commit 500"),
      d = await start();
    await unknown(d);
    f.changeSaved(change);
    await check(d);
    await within(d).findByText("已有用户的资料与本次提交不同");
    expect(f.writes).toHaveLength(1);
    expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
  },
);
it("allows usage to advance without treating submitted configuration as different", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  f.changeSaved({ usedBytes: 91 });
  await check(d);
  await closed();
  expect(f.writes).toHaveLength(1);
});
it("keeps the frozen attempt recoverable after readback failure", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  f.failRead();
  await check(d);
  await within(d).findByText("用户列表暂时无法读取");
  expect(within(d).queryByRole("button", { name: "重试本次创建" })).toBeNull();
  expect(
    (within(d).getByRole("textbox", { name: "用户名称" }) as HTMLInputElement)
      .value,
  ).toBe("One intended user");
  await check(d);
  await closed();
  expect(f.writes).toHaveLength(1);
});
it("does not erase earlier uncertainty when a guarded retry is rejected", async () => {
  const f = mount("delayed commit"),
    d = await start();
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的用户");
  f.rejectRetry();
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await unknown(d);
  expect(
    within(d)
      .getByRole("textbox", { name: "用户名称" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
  f.commitFirst();
  await check(d);
  await closed();
});
it("keeps truthful close and navigation consequences and can continue checking", async () => {
  mount("lost response");
  const d = await start();
  await unknown(d);
  expect(getNavigationWarning()).toContain("关闭不会撤销创建");
  await owner.click(() => within(d).getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog");
  expect(decision.textContent).not.toContain("尚未保存");
  await owner.click(() =>
    within(decision).getByRole("button", { name: "继续核对" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    (within(d).getByRole("textbox", { name: "用户名称" }) as HTMLInputElement)
      .value,
  ).toBe("One intended user");
  await check(d);
  await closed();
});
it("ignores a late result check after closing and opening a newer draft", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  await closeUnknown(d);
  const next = await open();
  owner.change(() => within(next).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Newer local draft" },
  });
  await act(async () => {
    finish();
  });
  expect(
    (
      within(next).getByRole("textbox", {
        name: "用户名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Newer local draft");
  expect(within(next).getByRole("button", { name: "保存" })).toBeTruthy();
  expect(within(next).queryByText("尚未确认用户是否创建")).toBeNull();
  expect(f.writes).toHaveLength(1);
});
it("starts a different identity only after explicit close and a new creation task", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  await closeUnknown(d);
  const next = await open();
  expect(
    (
      within(next).getByRole("textbox", {
        name: "用户名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  owner.change(() => within(next).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Separate user" },
  });
  await owner.click(() => within(next).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes[1].body.id).not.toBe(f.writes[0].body.id);
  expect(f.writes[1].condition).toBe("*");
});
it("allows correction after explicit pre-commit validation rejection while keeping the task ID", async () => {
  const f = mount("definite rejection"),
    d = await start();
  await within(d).findByText("valid id, name and non-negative quota required");
  expect(within(d).queryByText("尚未确认用户是否创建")).toBeNull();
  expect(
    within(d)
      .getByRole("textbox", { name: "用户名称" })
      .hasAttribute("disabled"),
  ).toBe(false);
  owner.change(() => within(d).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Corrected user" },
  });
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await closed();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].body.id).toBe(f.writes[0].body.id);
  expect(f.writes[1].body.name).toBe("Corrected user");
  expect(
    await screen.findAllByRole("button", { name: "Corrected user" }),
  ).toHaveLength(1);
});
it("blocks invalid local input before sending a remote attempt", async () => {
  const f = mount("lost response"),
    d = await open();
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await within(d).findByText("请输入名称");
  expect(f.writes).toHaveLength(0);
});
it("ignores old creation completion after the owning page is replaced", async () => {
  const f = mount("lost response"),
    finish = f.holdWrite();
  await start();
  f.view.unmount();
  f.renderPage();
  const next = await open();
  owner.change(() => within(next).getByRole("textbox", { name: "用户名称" }), {
    target: { value: "Newer page draft" },
  });
  await act(async () => {
    finish();
  });
  expect(
    (
      within(next).getByRole("textbox", {
        name: "用户名称",
      }) as HTMLInputElement
    ).value,
  ).toBe("Newer page draft");
  expect(within(next).getByRole("button", { name: "保存" })).toBeTruthy();
});

it("does not let an earlier result check dismiss a newer close decision", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  await owner.click(() => within(d).getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog");
  await act(async () => {
    finish();
  });
  expect(screen.queryByRole("alertdialog")).toBe(decision);
  await owner.click(() =>
    within(decision).getByRole("button", { name: "继续核对" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog", { name: "添加用户" })).toBe(d);
  await check(d);
  await closed();
});

async function navigateAway() {
  await act(async () => {
    location.hash = "#nodes";
  });
  return screen.findByRole("alertdialog", { name: "离开当前页面？" });
}
async function stayOnPage(decision: HTMLElement) {
  await owner.click(() =>
    within(decision).getByRole("button", { name: "留在当前页面" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}
it.each([true, false])(
  "keeps the Add-user recovery after a real route decision, response before Stay=%s",
  async (beforeStay) => {
    const f = mount("lost response", true, true),
      d = await start();
    await unknown(d);
    const finish = f.holdRead();
    await check(d);
    const decision = await navigateAway();
    expect(decision.textContent).toContain("关闭不会撤销创建");
    expect(decision.textContent).toContain("另一项编辑也需要保留");
    if (beforeStay)
      await act(async () => {
        finish();
      });
    await stayOnPage(decision);
    expect(screen.getByRole("dialog", { name: "添加用户" })).toBe(d);
    expect(
      (within(d).getByRole("textbox", { name: "用户名称" }) as HTMLInputElement)
        .value,
    ).toBe("One intended user");
    if (!beforeStay)
      await act(async () => {
        finish();
      });
    expect(screen.getByRole("dialog", { name: "添加用户" })).toBe(d);
    expect(getNavigationWarning()).toContain("另一项编辑也需要保留");
    await check(d);
    await closed();
    expect(f.writes).toHaveLength(1);
    expect(getNavigationWarning()).toBe("另一项编辑也需要保留。");
  },
);
it.each(["initial create", "guarded retry"] as const)(
  "keeps a completed %s visible after a real route-leave decision",
  async (mode) => {
    const f = mount("delayed commit", true);
    let d: HTMLElement, finish: () => void;
    if (mode === "initial create") {
      finish = f.holdWrite();
      d = await start();
    } else {
      d = await start();
      await unknown(d);
      await check(d);
      await within(d).findByText("暂未找到本次创建的用户");
      finish = f.holdWrite();
      await owner.click(() =>
        within(d).getByRole("button", { name: "重试本次创建" }),
      );
    }
    const decision = await navigateAway();
    await act(async () => {
      finish();
    });
    await stayOnPage(decision);
    expect(screen.getByRole("dialog", { name: "添加用户" })).toBe(d);
    await within(d).findByText("用户已创建");
    expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
    expect(within(d).queryByText("尚未确认用户是否创建")).toBeNull();
    await owner.click(() => within(d).getByRole("button", { name: "完成" }));
    await closed();
    expect(f.writes).toHaveLength(mode === "initial create" ? 1 : 2);
  },
);
it("does not reopen a discarded creation when a route-leave decision is accepted", async () => {
  const f = mount("lost response", true),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  const decision = await navigateAway();
  await owner.click(() =>
    within(decision).getByRole("button", { name: "仍然离开" }),
  );
  await screen.findByRole("heading", { name: "连接端点" });
  await act(async () => {
    finish();
  });
  expect(screen.queryByRole("dialog", { name: "添加用户" })).toBeNull();
  expect(location.hash).toBe("#nodes");
  expect(f.writes).toHaveLength(1);
});

it("notifies only active opt-in navigation owners once per decision under StrictMode", async () => {
  mount("lost response", true, false, true);
  await screen.findByRole("heading", { name: "用户" });
  const first = await navigateAway();
  await stayOnPage(first);
  expect(screen.getByText("独立草稿确认次数：1")).toBeTruthy();
  const second = await navigateAway();
  await stayOnPage(second);
  expect(screen.getByText("独立草稿确认次数：2")).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "切换独立草稿" }));
  await act(async () => {
    location.hash = "#nodes";
  });
  await screen.findByRole("heading", { name: "连接端点" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText("独立草稿确认次数：2")).toBeTruthy();
  await owner.click(() => screen.getByRole("button", { name: "切换独立草稿" }));
  await act(async () => {
    location.hash = "#users";
  });
  const remounted = await screen.findByRole("alertdialog", {
    name: "离开当前页面？",
  });
  await stayOnPage(remounted);
  expect(screen.getByText("独立草稿确认次数：3")).toBeTruthy();
});

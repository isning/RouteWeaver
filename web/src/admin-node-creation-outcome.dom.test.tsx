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
import { StrictMode } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { AdminPage } from "./Admin";
import App from "./App";
import { setCSRF, setToken } from "./api";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { getNavigationWarning } from "./navigation";
import type { NodeRecord } from "./types";
let owner: ReturnType<typeof ownedClickScenario>;
const clients: QueryClient[] = [];
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json" },
  });
type Outcome =
  | "success"
  | "lost response"
  | "unreadable success"
  | "invalid receipt"
  | "wrong identity"
  | "untagged 400"
  | "pre-write rejection"
  | "delayed commit";
beforeEach((context) => {
  owner = ownedClickScenario(context);
  setToken("");
  setCSRF("");
  history.replaceState(null, "", "/#nodes");
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
  Element.prototype.scrollIntoView = vi.fn();
  const computedStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computedStyle(element),
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
function mount(outcome: Outcome, workspace = false) {
  const writes: { body: NodeRecord; condition: string | null }[] = [];
  const saved = new Map<string, NodeRecord>();
  let nextRead: (() => Promise<Response>) | undefined;
  let heldWrite: ReturnType<typeof deferred<Response>> | undefined;
  let retryRejected = false;
  const state = () => ({
    nodes: [...saved.values()],
    users: [],
    routes: [],
    revisions: [],
    capabilities: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/nodes" && init?.method === "POST") {
        const value = JSON.parse(String(init.body)) as NodeRecord;
        const condition = new Headers(init.headers).get("If-None-Match");
        writes.push({ body: value, condition });
        if (heldWrite) return heldWrite.promise;
        if (
          (writes.length === 1 && outcome === "pre-write rejection") ||
          retryRejected
        )
          return json(
            {
              code: "NODE_CREATION_INVALID",
              detail: "Synthetic pre-write validation failure",
            },
            400,
          );
        // Inspected create-only contract, not native backend acceptance evidence.
        if (condition === "*" && saved.has(value.id))
          return json({ code: "NODE_CREATION_CONFLICT" }, 412);
        if (writes.length === 1 && outcome === "delayed commit")
          throw new TypeError("Response lost before delayed commit");
        saved.set(value.id, { ...value, status: "unregistered" });
        if (writes.length === 1) {
          if (outcome === "lost response")
            throw new TypeError("Response lost after commit");
          if (outcome === "unreadable success")
            return new Response("{", { status: 200 });
          if (outcome === "invalid receipt") return json(null);
          if (outcome === "wrong identity")
            return json({ ...value, id: "wrong-node" });
          if (outcome === "untagged 400")
            return json({ detail: "Unknown storage outcome" }, 400);
        }
        return json(saved.get(value.id));
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
            {workspace ? <App /> : <AdminPage page="nodes" />}
          </UIProviders>
        </QueryClientProvider>
      </StrictMode>,
    );
  };
  const view = renderPage();
  return {
    writes,
    saved,
    view,
    renderPage,
    changeSaved(change: Partial<NodeRecord>) {
      const record = writes[0].body;
      saved.set(record.id, { ...record, ...change });
    },
    commitFirst() {
      const record = writes[0].body;
      if (!saved.has(record.id)) saved.set(record.id, record);
    },
    failRead() {
      nextRead = async () =>
        json({ detail: "Arbitrary read detail must not be echoed" }, 503);
    },
    invalidRead(value: unknown) {
      nextRead = async () => json(value);
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
        const value = writes.at(-1)!.body;
        if (!saved.has(value.id)) saved.set(value.id, value);
        heldWrite!.resolve(json(saved.get(value.id)));
        heldWrite = undefined;
      };
    },
  };
}
async function open() {
  await owner.click(() => screen.findByRole("button", { name: "添加端点" }));
  return screen.findByRole("dialog", { name: "添加端点" });
}
async function fill(d: HTMLElement, name = "One intended endpoint") {
  owner.change(() => within(d).getByRole("textbox", { name: "端点名称" }), {
    target: { value: name },
  });
  owner.change(() => within(d).getByRole("textbox", { name: "连接地址" }), {
    target: { value: "proxy.example.invalid" },
  });
}
async function start() {
  const d = await open();
  await fill(d);
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  return d;
}
async function unknown(d: HTMLElement) {
  await within(d).findByText("尚未确认端点是否创建");
}
async function showSubmission(d: HTMLElement) {
  const details = within(d).getByRole("button", { name: "查看本次提交" });
  if (details.getAttribute("aria-expanded") !== "true")
    await owner.click(() => details);
}
async function check(d: HTMLElement) {
  await owner.click(() =>
    within(d).getByRole("button", { name: "检查创建结果" }),
  );
}
async function closed() {
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "添加端点" })).toBeNull(),
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
  "lost response",
  "unreadable success",
  "invalid receipt",
  "wrong identity",
  "untagged 400",
] as const)(
  "checks an uncertain endpoint read-only after %s without making a duplicate",
  async (outcome) => {
    const f = mount(outcome),
      d = await open();
    await fill(d);
    const draftName = within(d).getByRole("textbox", { name: "端点名称" });
    const completion = within(d).getByRole("button", { name: "保存" });
    await owner.click(() => completion);
    await unknown(d);
    expect(within(d).getByRole("button", { name: "检查创建结果" })).toBe(
      completion,
    );
    expect(within(d).queryByRole("textbox", { name: "端点名称" })).toBeNull();
    const footer = d.querySelector("[data-task-overlay-footer]")!;
    expect(
      within(footer as HTMLElement).getByText("尚未确认端点是否创建"),
    ).toBeTruthy();
    expect(footer.textContent).toContain("关闭不会撤销可能已完成的创建");
    await showSubmission(d);
    expect(within(d).getByRole("textbox", { name: "端点名称" })).toBe(
      draftName,
    );
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].condition).toBe("*");
    expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
    expect(within(d).getByRole("textbox", { name: "端点名称" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.submit(d.querySelector("form")!);
    await act(async () => {});
    expect(f.writes).toHaveLength(1);
    await check(d);
    await closed();
    expect(
      await screen.findAllByRole("button", { name: /^One intended endpoint/ }),
    ).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
  },
);
it("retries the same guarded identity and frozen connection after an absent read", async () => {
  const f = mount("delayed commit"),
    d = await start();
  f.saved.set("existing-anytls", {
    id: "existing-anytls",
    name: "Existing AnyTLS",
    host: "proxy.example.invalid",
    port: 443,
    protocol: "anytls",
    password: "synthetic-existing-password",
    tls: { enabled: true },
    status: "unregistered",
  });
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的端点");
  expect(d.textContent).toContain("之前的请求仍可能完成");
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await closed();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1]).toEqual(f.writes[0]);
  f.commitFirst();
  expect(f.saved.size).toBe(2);
  expect(
    await screen.findAllByRole("button", { name: /^One intended endpoint/ }),
  ).toHaveLength(1);
});
it("does not overwrite a later endpoint edit when the first request completes after the absent read", async () => {
  const f = mount("delayed commit"),
    d = await start();
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的端点");
  f.commitFirst();
  f.changeSaved({
    name: "Later operator edit",
    host: "later.example.invalid",
    region: "UK",
  });
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await unknown(d);
  await check(d);
  await within(d).findByText("已有端点的资料与本次提交不同");
  expect(d.textContent).toContain("Later operator edit");
  expect(d.textContent).toContain("later.example.invalid:1080");
  expect(f.writes[1]).toEqual(f.writes[0]);
  expect(f.saved.size).toBe(1);
  expect(f.saved.get(f.writes[0].body.id)).toMatchObject({
    host: "later.example.invalid",
    region: "UK",
  });
  expect(within(d).queryByRole("button", { name: "重试本次创建" })).toBeNull();
});
it.each([
  { name: "Different" },
  { host: "other.example.invalid" },
  { port: 1081 },
  { region: "UK" },
  { tags: ["later"] },
  { coreId: "other-core" },
  { coreVersion: "other-version" },
  { status: "different-status" },
])(
  "does not mistake changed persisted metadata %j for its original save",
  async (change) => {
    const f = mount("lost response"),
      d = await start();
    await unknown(d);
    f.changeSaved(change);
    await check(d);
    await within(d).findByText("已有端点的资料与本次提交不同");
    expect(f.writes).toHaveLength(1);
    expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
  },
);
it("retains the frozen attempt after failed readback without echoing arbitrary response details", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  f.failRead();
  await check(d);
  await within(d).findByText("未能读取端点列表，请重新检查。");
  expect(d.textContent).not.toContain("Arbitrary read detail");
  expect(within(d).queryByRole("button", { name: "重试本次创建" })).toBeNull();
  await showSubmission(d);
  expect(within(d).getByRole("textbox", { name: "连接地址" })).toHaveProperty(
    "value",
    "proxy.example.invalid",
  );
  await check(d);
  await closed();
  expect(f.writes).toHaveLength(1);
});
it.each(["missing nodes", "invalid record", "duplicate identity"] as const)(
  "does not treat %s as confirmed absence",
  async (kind) => {
    const f = mount("lost response"),
      d = await start();
    await unknown(d);
    const record = f.writes[0].body;
    f.invalidRead(
      kind === "missing nodes"
        ? {}
        : { nodes: kind === "invalid record" ? [null] : [record, record] },
    );
    await check(d);
    await within(d).findByText("未能读取端点列表，请重新检查。");
    expect(
      within(d).queryByRole("button", { name: "重试本次创建" }),
    ).toBeNull();
    await check(d);
    await closed();
    expect(f.writes).toHaveLength(1);
  },
);
it("does not erase earlier uncertainty when the guarded retry is rejected before writing", async () => {
  const f = mount("delayed commit"),
    d = await start();
  await unknown(d);
  await check(d);
  await within(d).findByText("暂未找到本次创建的端点");
  f.rejectRetry();
  await owner.click(() =>
    within(d).getByRole("button", { name: "重试本次创建" }),
  );
  await unknown(d);
  await showSubmission(d);
  expect(within(d).getByRole("textbox", { name: "端点名称" })).toHaveProperty(
    "disabled",
    true,
  );
  f.commitFirst();
  await check(d);
  await closed();
});
it("reports truthful Cancel consequences and refreshes the visible list on closing", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  expect(getNavigationWarning()).toContain("端点可能已经创建");
  f.changeSaved({ name: "Latest endpoint name" });
  await closeUnknown(d);
  expect(
    await screen.findByRole("button", { name: /^Latest endpoint name/ }),
  ).toBeTruthy();
  expect(f.saved.size).toBe(1);
  expect(f.writes).toHaveLength(1);
});
it("ignores late readback after explicit close and a newer Add-endpoint task", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  await closeUnknown(d);
  const next = await open();
  await fill(next, "Newer draft");
  await act(async () => finish());
  expect(
    within(next).getByRole("textbox", { name: "端点名称" }),
  ).toHaveProperty("value", "Newer draft");
  expect(within(next).getByRole("button", { name: "保存" })).toBeTruthy();
  expect(within(next).queryByText("尚未确认端点是否创建")).toBeNull();
  expect(f.writes).toHaveLength(1);
});
it("starts another identity only after explicitly closing and beginning another task", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  await closeUnknown(d);
  const next = await open();
  await fill(next, "Separate endpoint");
  await owner.click(() => within(next).getByRole("button", { name: "保存" }));
  await closed();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[1].body.id).not.toBe(f.writes[0].body.id);
  expect(f.writes[1].condition).toBe("*");
});
it("keeps ordinary successful Save and normalization while excluding unrelated editor defaults", async () => {
  const f = mount("success"),
    d = await open();
  await fill(d);
  owner.change(() => within(d).getByRole("spinbutton", { name: "端口" }), {
    target: { value: "1.08e3" },
  });
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await closed();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].body).toEqual({
    id: expect.any(String),
    name: "One intended endpoint",
    host: "proxy.example.invalid",
    port: 1080,
    protocol: "socks",
    status: "unregistered",
  });
  expect(f.saved.size).toBe(1);
});
it("keeps the task ID but permits corrected fields after explicit pre-write rejection", async () => {
  const f = mount("pre-write rejection"),
    d = await start();
  await within(d).findByText("端点未创建，请检查连接参数后重试。");
  expect(within(d).queryByText("尚未确认端点是否创建")).toBeNull();
  expect(within(d).getByRole("textbox", { name: "端点名称" })).toHaveProperty(
    "disabled",
    false,
  );
  await fill(d, "Corrected endpoint");
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await closed();
  expect(f.writes[1].body.id).toBe(f.writes[0].body.id);
  expect(f.writes[1].body.name).toBe("Corrected endpoint");
  expect(f.saved.size).toBe(1);
});
it("prevents invalid local input and retains truthful unsaved Cancel before any attempt", async () => {
  const f = mount("success"),
    d = await open();
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await within(d).findByText("请输入名称");
  expect(f.writes).toHaveLength(0);
  await fill(d);
  owner.change(() => within(d).getByRole("spinbutton", { name: "端口" }), {
    target: { value: "1080.1" },
  });
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await act(async () => {});
  expect(f.writes).toHaveLength(0);
  await owner.click(() => within(d).getByRole("button", { name: "取消" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "放弃未保存的修改？",
  });
  expect(confirm.textContent).toContain("当前端点修改尚未保存。");
  await owner.click(() =>
    within(confirm).getByRole("button", { name: "放弃修改" }),
  );
  await closed();
});
it("blocks duplicate pending submission without losing the one saved connection", async () => {
  const f = mount("success"),
    finish = f.holdWrite(),
    d = await start();
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(within(d).getByRole("button", { name: "取消" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.submit(d.querySelector("form")!);
  await act(async () => {});
  expect(f.writes).toHaveLength(1);
  await act(async () => finish());
  await closed();
  expect(f.saved.size).toBe(1);
});
it("ignores an old create completion after the owning page is replaced", async () => {
  const f = mount("success"),
    finish = f.holdWrite();
  await start();
  f.view.unmount();
  f.renderPage();
  const next = await open();
  await fill(next, "Newer page draft");
  await act(async () => finish());
  expect(
    within(next).getByRole("textbox", { name: "端点名称" }),
  ).toHaveProperty("value", "Newer page draft");
  expect(within(next).getByRole("button", { name: "保存" })).toBeTruthy();
});
it("does not let earlier readback dismiss a newer Cancel decision", async () => {
  const f = mount("lost response"),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  await owner.click(() => within(d).getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog");
  await act(async () => finish());
  expect(screen.getByRole("alertdialog")).toBe(decision);
  await owner.click(() =>
    within(decision).getByRole("button", { name: "继续核对" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog", { name: "添加端点" })).toBe(d);
  await check(d);
  await closed();
});
async function navigateAway() {
  await act(async () => {
    location.hash = "#users";
  });
  return screen.findByRole("alertdialog", { name: "离开当前页面？" });
}
async function stay(decision: HTMLElement) {
  await owner.click(() =>
    within(decision).getByRole("button", { name: "留在当前页面" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
}
it.each([true, false])(
  "keeps endpoint reconciliation after App navigation, response before Stay=%s",
  async (beforeStay) => {
    const f = mount("lost response", true),
      d = await start();
    await unknown(d);
    const finish = f.holdRead();
    await check(d);
    const decision = await navigateAway();
    expect(decision.textContent).toContain("端点可能已经创建");
    if (beforeStay) await act(async () => finish());
    await stay(decision);
    if (!beforeStay) await act(async () => finish());
    expect(screen.getByRole("dialog", { name: "添加端点" })).toBe(d);
    await showSubmission(d);
    expect(within(d).getByRole("textbox", { name: "连接地址" })).toHaveProperty(
      "value",
      "proxy.example.invalid",
    );
    await check(d);
    await closed();
    expect(f.writes).toHaveLength(1);
  },
);
it.each(["initial create", "guarded retry"] as const)(
  "keeps completed %s visible after a newer App navigation decision",
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
      await within(d).findByText("暂未找到本次创建的端点");
      finish = f.holdWrite();
      await owner.click(() =>
        within(d).getByRole("button", { name: "重试本次创建" }),
      );
    }
    const decision = await navigateAway();
    await act(async () => finish());
    await stay(decision);
    expect(screen.getByRole("dialog", { name: "添加端点" })).toBe(d);
    await within(d).findByText("端点已创建");
    expect(within(d).queryByRole("button", { name: "保存" })).toBeNull();
    await owner.click(() => within(d).getByRole("button", { name: "完成" }));
    await closed();
    expect(f.saved.size).toBe(1);
  },
);
it("does not reopen the endpoint task after accepting App navigation", async () => {
  const f = mount("lost response", true),
    d = await start();
  await unknown(d);
  const finish = f.holdRead();
  await check(d);
  const decision = await navigateAway();
  await owner.click(() =>
    within(decision).getByRole("button", { name: "仍然离开" }),
  );
  await screen.findByRole("heading", { name: "用户" });
  await act(async () => finish());
  expect(screen.queryByRole("dialog", { name: "添加端点" })).toBeNull();
  expect(location.hash).toBe("#users");
  expect(f.writes).toHaveLength(1);
});

it("creates a Hysteria2 endpoint from the public Add endpoint form", async () => {
  const f = mount("success"),
    d = await open();
  await fill(d);
  await owner.click(() => within(d).getByRole("combobox", { name: "协议" }));
  await owner.click(() => screen.findByRole("option", { name: "Hysteria2" }));
  await owner.click(() => within(d).getByRole("radio", { name: "TLS" }));
  owner.change(() => within(d).getByLabelText("连接密码"), {
    target: { value: "synthetic-endpoint-password" },
  });
  await owner.click(() => within(d).getByRole("button", { name: "保存" }));
  await closed();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].condition).toBe("*");
  expect(f.writes[0].body).toMatchObject({
    protocol: "hysteria2",
    password: "synthetic-endpoint-password",
    tls: { enabled: true },
  });
});

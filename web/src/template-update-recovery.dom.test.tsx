// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { TemplatesPage } from "./Templates";

const staleMessage = "template or personal configuration changed; preview again before applying";
const recoveryMessage = "模板或草稿已变化，本次更新未应用。请重新检查后再应用。";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const clients: QueryClient[] = [];
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({
    matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  }) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Input = { version: number; bindings: { endpoints: Record<string, string>; resources: Record<string, string> }; previewDigest?: string };
function fixture(handle?: (action: "preview" | "apply", input: Input, attempt: number) => Promise<Response>) {
  const template = { id: "routing", name: "日常分流", kind: "client-profile", version: 3,
    spec: { endpointSlots: [{ id: "exit", name: "出口连接" }] } };
  const requests: { action: "preview" | "apply"; input: Input }[] = [];
  const attempts = { preview: 0, apply: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/preview") || url.endsWith("/apply")) {
      const action = url.endsWith("/preview") ? "preview" : "apply";
      const body = JSON.parse(String(init.body)) as Input;
      requests.push({ action, input: body });
      const attempt = ++attempts[action];
      if (handle) return handle(action, body, attempt);
      return json(review(body.version, `review-${attempt}`));
    }
    if (url === "/api/templates") return json([template]);
    if (url === "/api/templates/routing/versions") return json([template, { ...template, version: 2 }, { ...template, version: 1 }]);
    if (url === "/api/me/template-bindings") return json([{
      id: "profiles_home", templateId: "routing", targetKind: "profiles", targetId: "home",
      mode: "pinned", appliedVersion: 1, bindings: { endpoints: { exit: "tokyo" }, resources: {} },
    }]);
    if (url === "/api/me/profiles") return json([{
      id: "home", name: "家庭配置", ir: { resources: [], endpoints: [
        { id: "tokyo", name: "东京连接", origin: "imported" },
        { id: "osaka", name: "大阪连接", origin: "imported" },
      ] },
    }]);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><UIProviders><TemplatesPage /></UIProviders></QueryClientProvider>);
  return { ...view, requests, user: userEvent.setup() };
}
function review(version: number, previewDigest: string) {
  return { compatible: true, hasUpdate: true, currentVersion: 1, candidateVersion: version,
    previewDigest, diagnostics: [], changes: [], preservedLocalEdits: [], artifacts: [] };
}
async function open() {
  await userEvent.click(await screen.findByRole("tab", { name: "我的引用" }));
  await userEvent.click(await screen.findByRole("button", { name: "查看固定版本 家庭配置" }));
  return screen.findByRole("dialog", { name: "模板更新 家庭配置" });
}
function picker(label: string) {
  return within(screen.getByText(label).closest("label")!).getByRole("combobox");
}
async function choose(label: string, name: string) {
  await userEvent.click(picker(label));
  await userEvent.click(await screen.findByRole("option", { name }));
}

it("retires stale authority and rechecks in place without losing the pinned version or replacement binding", async () => {
  let failRead = false;
  const { requests, user } = fixture(async (action, input, attempt) => {
    if (action === "apply") return attempt === 1 ? json({ detail: staleMessage }, 409) : json({});
    if (failRead) return json({ detail: "模板检查服务暂不可用" }, 503);
    return json(review(input.version, `review-${attempt}`));
  });
  const dialog = await open();
  await screen.findByText("可以更新到 v1");
  await choose("检查的模板版本", "v2");
  await choose("出口连接", "大阪连接");
  const recheck = within(dialog).getByRole("button", { name: "检查此绑定的更新" });
  await user.click(recheck);
  await screen.findByText("可以更新到 v2");
  await user.click(within(dialog).getByRole("button", { name: "应用到草稿" }));
  await screen.findByText(recoveryMessage);
  expect(screen.queryByText(staleMessage)).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "应用到草稿" })).toBeNull();
  expect(within(dialog).queryByRole("region", { name: "模板更新检查结果" })).toBeNull();
  expect(picker("检查的模板版本").textContent).toContain("v2");
  expect(picker("出口连接").textContent).toContain("大阪连接");
  failRead = true;
  await user.click(recheck);
  await screen.findByText("模板检查服务暂不可用");
  expect(within(dialog).queryByRole("button", { name: "应用到草稿" })).toBeNull();
  failRead = false;
  await user.click(recheck);
  await screen.findByText("可以更新到 v2");
  expect(screen.queryByText("模板检查服务暂不可用")).toBeNull();
  expect(requests.filter((r) => r.action === "apply")).toHaveLength(1);
  expect(requests.at(-1)).toEqual({ action: "preview", input: {
    version: 2, bindings: { endpoints: { exit: "osaka" }, resources: {} },
  } });
  await user.click(within(dialog).getByRole("button", { name: "应用到草稿" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "模板更新 家庭配置" })).toBeNull());
  expect(requests.filter((r) => r.action === "apply").at(-1)?.input).toEqual({
    previewDigest: "review-4", version: 2, bindings: { endpoints: { exit: "osaka" }, resources: {} },
  });
});

it.each([409, 503])("preserves an unrelated %s failure instead of calling it a stale review", async (status) => {
  fixture(async (action, input) => action === "apply"
    ? json({ detail: "Unrelated service failure" }, status)
    : json(review(input.version, "review")));
  const dialog = await open();
  await userEvent.click(await within(dialog).findByRole("button", { name: "应用到草稿" }));
  await screen.findByText("Unrelated service failure");
  expect(screen.queryByText(recoveryMessage)).toBeNull();
  expect(!!within(dialog).queryByRole("button", { name: "应用到草稿" })).toBe(status !== 409);
});

it("does not let a late failed inspection replace the newer version selection", async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const { requests } = fixture(async (action, input, attempt) =>
    action === "preview" && attempt === 1 ? pending : json(review(input.version, "new-review")));
  const dialog = await open();
  await waitFor(() => expect(requests).toHaveLength(1));
  await choose("检查的模板版本", "v2");
  await act(async () => { release(json({ detail: "Obsolete inspection failed" }, 503)); await pending; });
  expect(screen.queryByText("Obsolete inspection failed")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "应用到草稿" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "检查此绑定的更新" }));
  await screen.findByText("可以更新到 v2");
  expect(requests.every((request) => request.action === "preview")).toBe(true);
});

it("keeps recheck and apply distinct under repeated pointer and keyboard activation", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const { requests, user } = fixture(async (action, input, attempt) =>
    action === "apply" ? pending : json(review(input.version, `review-${attempt}`)));
  const dialog = await open();
  await screen.findByText("可以更新到 v1");
  await user.click(picker("出口连接"));
  const search = await screen.findByRole("combobox", { name: "搜索选项" });
  expect(fireEvent.keyDown(search, { key: " ", repeat: true })).toBe(true);
  await user.keyboard("{Escape}");
  const recheck = within(dialog).getByRole("button", { name: "检查此绑定的更新" });
  await user.click(recheck);
  await screen.findByText("可以更新到 v1");
  expect(within(dialog).getByRole("button", { name: "检查此绑定的更新" })).toBe(recheck);
  const apply = within(dialog).getByRole("button", { name: "应用到草稿" });
  fireEvent.click(recheck, { detail: 2 });
  fireEvent.click(apply, { detail: 2 });
  for (const key of ["Enter", " "]) {
    expect(fireEvent.keyDown(recheck, { key, repeat: true })).toBe(false);
    expect(fireEvent.keyDown(apply, { key, repeat: true })).toBe(false);
  }
  expect(requests.filter((request) => request.action === "apply")).toEqual([]);
  act(() => { fireEvent.click(apply); fireEvent.click(apply); });
  await waitFor(() => expect(requests.filter((request) => request.action === "apply")).toHaveLength(1));
  await act(async () => { finish(json({})); await pending; });
});

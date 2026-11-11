// @vitest-environment jsdom
// Public server-workspace controls and intercepted HTTP only. These tests prove
// DOM focus and draft behavior, not native viewport visibility or node execution.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ServersPage } from "./Infrastructure";
import { setCSRF, setToken } from "./api";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
type TargetDraft = { id: string; nodeId: string; name: string; url: string; methods: string[] };
let client: QueryClient;
beforeEach(() => {
  history.replaceState(null, "", "#servers");
  setCSRF("");
  setToken("");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((media) => ({
      matches: false, media, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    })),
  });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixture(rejectFirst = false, holdFirst = false) {
  const writes: TargetDraft[] = [], unexpected: string[] = [];
  let settleFirst!: (status: number) => void;
  const reads: Record<string, unknown> = {
    "/api/hosts": [{ id: "host", name: "Tokyo", address: "tokyo.example.test" }],
    "/api/core-instances": [{ id: "core", hostId: "host", name: "Tokyo core", adapterId: "routeweaver/xray", version: "26.10.31" }],
    "/api/managed-endpoints": [],
    "/api/links": [],
    "/api/server-deployments": [],
    "/api/admin/diagnostic-targets": [],
    "/api/admin/diagnostic-jobs": [],
    "/api/admin/nodes/host/observability": { config: {} },
    "/api/agent/instances/core/state": { instanceId: "core", phase: "unregistered" },
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
    const path = String(input), method = init?.method || "GET";
    if (method === "POST" && path === "/api/admin/diagnostic-targets") {
      const body = JSON.parse(String(init?.body)) as TargetDraft;
      writes.push(body);
      if (holdFirst && writes.length === 1) return new Promise<Response>((resolve) => {
        settleFirst = (status) => {
          if (status === 200) reads[path] = [body];
          resolve(json(status === 200 ? body : { error: "Departed registration rejected" }, status));
        };
      });
      if (rejectFirst && writes.length === 1)
        return json({ error: "Synthetic target rejected; nothing was saved" }, 400);
      reads[path] = [body];
      return json(body);
    }
    if (method === "GET" && path in reads) return json(reads[path]);
    unexpected.push(`${method} ${path}`);
    return json({ error: "Unexpected diagnostic target fixture request" }, 503);
  }));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  let generation = 0;
  const view = () => <UIProviders><QueryClientProvider client={client}><ServersPage key={generation} /></QueryClientProvider></UIProviders>;
  const mounted = render(view());
  return {
    writes, unexpected, settleFirst: (status: number) => settleFirst(status),
    replaceWorkspace: () => {
      history.replaceState(null, "", "#servers");
      generation++;
      mounted.rerender(view());
    },
  };
}
async function openRegistration(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Tokyo" }));
  const workspace = within(await screen.findByRole("region", { name: "Tokyo" }));
  await user.click(workspace.getByRole("tab", { name: "诊断" }));
  await user.click(workspace.getByRole("tab", { name: "连接诊断" }));
  const opener = await workspace.findByRole("button", { name: "登记测试目标" });
  await user.click(opener);
  return { opener, dialog: await screen.findByRole("dialog", { name: "登记授权测试目标" }) };
}

it("returns keyboard target registration to its first missing field without losing the URL or sending a request", async () => {
  const network = fixture(), user = userEvent.setup();
  const { dialog } = await openRegistration(user);
  const form = within(dialog);
  const name = form.getByRole("textbox", { name: "目标名称" });
  const url = form.getByRole("textbox", { name: "HTTPS 测试地址" }) as HTMLInputElement;
  await user.type(url, "https://probe.example.test/retained");
  const save = form.getByRole("button", { name: "保存测试目标" });
  save.focus();
  await user.keyboard("{Enter}");
  await form.findByText("请填写目标名称");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect(url.value).toBe("https://probe.example.test/retained");
  expect(form.getByRole("checkbox", { name: "HEAD 连通性" }).getAttribute("aria-checked")).toBe("true");
  expect(network.writes).toEqual([]);
  expect(network.unexpected).toEqual([]);
});

it("returns an invalid HTTPS target to its address while preserving the chosen name and methods", async () => {
  const network = fixture(), user = userEvent.setup();
  const { dialog } = await openRegistration(user);
  const form = within(dialog);
  const name = form.getByRole("textbox", { name: "目标名称" }) as HTMLInputElement;
  const url = form.getByRole("textbox", { name: "HTTPS 测试地址" }) as HTMLInputElement;
  await user.type(name, "Owned download target");
  await user.type(url, "http://probe.example.test/retained");
  await user.click(form.getByRole("checkbox", { name: "Range 下载" }));
  form.getByRole("button", { name: "保存测试目标" }).focus();
  await user.keyboard("{Enter}");
  await form.findByText("使用不含凭据、查询参数或片段的 HTTPS 地址");
  expect(url.getAttribute("aria-invalid")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(url));
  expect(name.value).toBe("Owned download target");
  expect(url.value).toBe("http://probe.example.test/retained");
  expect(form.getByRole("checkbox", { name: "Range 下载" }).getAttribute("aria-checked")).toBe("true");
  expect(network.writes).toEqual([]);
  expect(network.unexpected).toEqual([]);
});

it("focuses an empty required methods choice with its error and preserves the native checkbox names", async () => {
  const network = fixture(), user = userEvent.setup();
  const { dialog } = await openRegistration(user);
  const form = within(dialog);
  await user.type(form.getByRole("textbox", { name: "目标名称" }), "Owned connectivity target");
  await user.type(form.getByRole("textbox", { name: "HTTPS 测试地址" }), "https://probe.example.test/connectivity");
  const connectivity = form.getByRole("checkbox", { name: "HEAD 连通性" });
  await user.click(connectivity);
  form.getByRole("button", { name: "保存测试目标" }).focus();
  await user.keyboard("{Enter}");
  const error = await form.findByText("请填写目标支持的测试");
  expect(connectivity.getAttribute("aria-invalid")).toBe("true");
  expect(connectivity.getAttribute("aria-describedby")?.split(/\s+/)).toContain(error.id);
  await waitFor(() => expect(document.activeElement).toBe(connectivity));
  const methods = within(form.getByRole("group", { name: "目标支持的测试" }));
  expect(methods.getByRole("checkbox", { name: "Range 下载" }).getAttribute("aria-invalid")).toBe("true");
  expect(methods.getByRole("checkbox", { name: "PUT 上传（可能覆盖目标内容）" }).getAttribute("aria-describedby")?.split(/\s+/)).toContain(error.id);
  expect(network.writes).toEqual([]);
  await user.keyboard(" ");
  await waitFor(() => expect(form.queryByText("请填写目标支持的测试")).toBeNull());
  expect(connectivity.getAttribute("aria-checked")).toBe("true");
  expect(connectivity.getAttribute("aria-invalid")).toBeNull();
  form.getByRole("button", { name: "保存测试目标" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(network.writes).toHaveLength(1));
  expect(network.writes[0]).toMatchObject({
    nodeId: "host", name: "Owned connectivity target", url: "https://probe.example.test/connectivity", methods: ["connectivity"],
  });
  expect(network.unexpected).toEqual([]);
});

it("preserves the target draft after a definite save rejection and retries only on the next explicit submission", async () => {
  const network = fixture(true), user = userEvent.setup();
  const { dialog } = await openRegistration(user);
  const form = within(dialog);
  const name = form.getByRole("textbox", { name: "目标名称" }) as HTMLInputElement;
  const url = form.getByRole("textbox", { name: "HTTPS 测试地址" }) as HTMLInputElement;
  await user.type(name, "Owned download target");
  await user.type(url, "https://probe.example.test/retained");
  await user.click(form.getByRole("checkbox", { name: "Range 下载" }));
  const save = form.getByRole("button", { name: "保存测试目标" });
  save.focus();
  await user.keyboard("{Enter}");
  await form.findByText("Synthetic target rejected; nothing was saved");
  expect(network.writes).toHaveLength(1);
  expect(network.writes[0]).toMatchObject({
    nodeId: "host", name: "Owned download target", url: "https://probe.example.test/retained",
    methods: ["connectivity", "download"],
  });
  expect(name.value).toBe("Owned download target");
  expect(url.value).toBe("https://probe.example.test/retained");
  expect(form.getByRole("checkbox", { name: "HEAD 连通性" }).getAttribute("aria-checked")).toBe("true");
  expect(form.getByRole("checkbox", { name: "Range 下载" }).getAttribute("aria-checked")).toBe("true");
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  expect(document.activeElement).toBe(save);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "登记授权测试目标" })).toBeNull());
  expect(network.writes).toHaveLength(2);
  expect(network.writes[1]).toEqual(network.writes[0]);
  expect(network.unexpected).toEqual([]);
});

it("does not submit or focus a dismissed registration when its validation settles and a new registration starts", async () => {
  const network = fixture(), user = userEvent.setup();
  const { dialog, opener } = await openRegistration(user);
  const form = within(dialog);
  const oldName = form.getByRole("textbox", { name: "目标名称" });
  const save = form.getByRole("button", { name: "保存测试目标" });
  const cancel = form.getByRole("button", { name: "取消" });
  let oldFocusAfterDismissal = false, dismissed = false;
  oldName.addEventListener("focus", () => { if (dismissed) oldFocusAfterDismissal = true; });
  // Two public native events in one turn preserve the validation/dismissal race.
  // The untouched form closes directly, without a discard decision or write.
  act(() => {
    save.focus();
    fireEvent.submit(save.closest("form")!);
    dismissed = true;
    fireEvent.click(cancel);
  });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "登记授权测试目标" })).toBeNull());
  expect(network.writes).toEqual([]);
  expect(opener.isConnected).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  const replacement = await screen.findByRole("dialog", { name: "登记授权测试目标" });
  const nextURL = within(replacement).getByRole("textbox", { name: "HTTPS 测试地址" }) as HTMLInputElement;
  await user.type(nextURL, "https://probe.example.test/new-task");
  await act(async () => { await Promise.resolve(); });
  expect(document.activeElement).toBe(nextURL);
  expect(nextURL.value).toBe("https://probe.example.test/new-task");
  expect(within(replacement).getByRole("textbox", { name: "目标名称" })).not.toBe(oldName);
  expect(oldFocusAfterDismissal).toBe(false);
  expect(network.writes).toEqual([]);
  expect(network.unexpected).toEqual([]);
});

it.each([200, 400])("keeps a replacement registration intact after a departed save finishes with HTTP %s", async (status) => {
  const network = fixture(false, true), user = userEvent.setup();
  const { dialog } = await openRegistration(user);
  const first = within(dialog);
  await user.type(first.getByRole("textbox", { name: "目标名称" }), "Departed target");
  await user.type(first.getByRole("textbox", { name: "HTTPS 测试地址" }), "https://probe.example.test/departed");
  first.getByRole("button", { name: "保存测试目标" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(network.writes).toHaveLength(1));
  expect(network.writes[0]).toMatchObject({
    nodeId: "host", name: "Departed target", url: "https://probe.example.test/departed", methods: ["connectivity"],
  });
  for (const checkbox of first.getAllByRole("checkbox"))
    expect((checkbox as HTMLButtonElement).disabled).toBe(true);
  // Replace the public workspace while retaining its providers and HTTP cache.
  // This is editor lifetime coverage, not browser Back/Forward acceptance.
  network.replaceWorkspace();
  const replacement = (await openRegistration(user)).dialog;
  const next = within(replacement);
  const name = next.getByRole("textbox", { name: "目标名称" }) as HTMLInputElement;
  const url = next.getByRole("textbox", { name: "HTTPS 测试地址" }) as HTMLInputElement;
  await user.type(name, "Replacement draft");
  await user.type(url, "https://probe.example.test/replacement");
  let focusStolen = false;
  const preserveFocus = (event: FocusEvent) => { if (event.target !== url) focusStolen = true; };
  document.addEventListener("focusin", preserveFocus);
  try {
    await act(async () => { network.settleFirst(status); });
    expect(screen.getByRole("dialog", { name: "登记授权测试目标" })).toBe(replacement);
    expect(document.activeElement).toBe(url);
    expect(focusStolen).toBe(false);
    expect(name.value).toBe("Replacement draft");
    expect(url.value).toBe("https://probe.example.test/replacement");
    expect(next.queryByText("Departed registration rejected")).toBeNull();
    expect(network.writes).toHaveLength(1);
    expect(network.unexpected).toEqual([]);
  } finally {
    document.removeEventListener("focusin", preserveFocus);
  }
});

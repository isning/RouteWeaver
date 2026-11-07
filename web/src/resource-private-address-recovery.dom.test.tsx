// @vitest-environment jsdom
// Resource task HTTP seams; these synthetic responses do not prove HTTPS reachability.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactNode } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { ResourcesPage } from "./Resources";
import { RuleFileImport } from "./RuleFileImport";
import { ErrorNotice, type ErrorNoticeFocusHandle } from "./components";
import { APIError, installSessionTransport } from "./api";

const diagnostic = "resource address is not public";
const title = "无法读取此规则文件地址";
const recovery = {
  inspect: "该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或取消后选择“导入规则文件”上传本地文件。",
  fetch: "该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或将导入方式切换为“上传本地文件”。",
};
type Task = keyof typeof recovery;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
const releases: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => original(element));
});
afterEach(() => {
  cleanup(); releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function mount(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><UIProviders>{children}</UIProviders></QueryClientProvider>);
}
async function open(task: Task, response: () => Response = () => json({ error: diagnostic }, 422)) {
  const writes: { path: string; body: Record<string, any> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/me/resources" && (!init?.method || init.method === "GET")) return json([]);
    writes.push({ path: url, body: JSON.parse(String(init?.body)) });
    return response();
  }));
  mount(task === "inspect" ? <ResourcesPage /> : <RuleFileImport onClose={() => {}} />);
  if (task === "inspect") {
    await screen.findByText("暂无规则资源");
    await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  } else {
    await userEvent.click(screen.getByRole("combobox", { name: "规则文件导入方式" }));
    await userEvent.click(screen.getByRole("option", { name: "读取 HTTPS 文件并接纳" }));
  }
  const name = screen.getByLabelText(task === "inspect" ? "资源名称" : "导入资源名称") as HTMLInputElement;
  const url = screen.getByLabelText(task === "inspect" ? "规则文件 URL" : "导入文件 HTTPS 地址") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Retained HTTPS rule draft" } });
  fireEvent.change(url, { target: { value: "https://127.0.0.1/rules.yaml" } });
  const action = screen.getByRole("button", { name: task === "inspect" ? "读取文件并计算校验值" : "读取并接纳文件" });
  return { writes, name, url, action };
}

it.each(["inspect", "fetch"] as const)("explains the exact %s address rejection, retains the diagnostic and draft, and checks only after an explicit retry", async (task) => {
  const t = await open(task);
  await userEvent.click(t.action);
  const summary = await screen.findByRole("group", { name: title, description: recovery[task] });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  const details = within(summary).getByText("查看检查详情").closest("details")!;
  expect(details.open).toBe(false);
  expect(within(details).getByText(diagnostic)).toBeTruthy();
  await userEvent.click(within(summary).getByText("查看检查详情"));
  expect(details.open).toBe(true);
  expect(within(details).getByText(diagnostic).textContent).toBe(diagnostic);
  expect(t.name.value).toBe("Retained HTTPS rule draft");
  expect(t.url.value).toBe("https://127.0.0.1/rules.yaml");
  if (task === "inspect") expect((screen.getByLabelText("SHA-256 校验值") as HTMLInputElement).value).toBe("");
  await userEvent.click(t.action);
  await waitFor(() => expect(t.writes).toHaveLength(2));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: title })));
  expect(t.writes[1]).toEqual(t.writes[0]);
  fireEvent.change(t.url, { target: { value: "https://example.test/revised-rules.yaml" } });
  expect(t.writes).toHaveLength(2);
  await userEvent.click(t.action);
  await waitFor(() => expect(t.writes).toHaveLength(3));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: title })));
  expect(t.writes.map((write) => write.path)).toEqual(Array(3).fill(task === "inspect" ? "/api/me/resources/inspect" : "/api/me/resources/import"));
  expect(task === "inspect" ? t.writes[2].body.url : t.writes[2].body.resource.url).toBe("https://example.test/revised-rules.yaml");
  if (task === "fetch") {
    await userEvent.click(screen.getByRole("combobox", { name: "规则文件导入方式" }));
    await userEvent.click(screen.getByRole("option", { name: "上传本地文件" }));
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.getByRole("button", { name: "选择规则文件" })).toBeTruthy();
    expect(t.name.value).toBe("Retained HTTPS rule draft");
    expect(t.writes).toHaveLength(3);
  }
});

for (const task of ["inspect", "fetch"] as const) {
  it.each([
    [401, diagnostic], [403, diagnostic], [400, diagnostic], [503, diagnostic],
    [422, "resource address is not public (extra detail)"],
    [422, "resource URL is not allowed"], [422, "resource could not be fetched"],
  ] as const)(`${task} leaves status %s diagnostic %s unchanged outside its exact address failure`, async (status, message) => {
    const authFailure = vi.fn();
    releases.push(installSessionTransport({ beforeRequest: () => ({ beforeSend() {}, waitForResponse: async () => {} }), failed: authFailure }));
    const t = await open(task, () => json({ error: message }, status));
    await userEvent.click(t.action);
    const summary = await screen.findByRole("group", { name: "操作未完成", description: message });
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.queryByText("查看检查详情")).toBeNull();
    expect(within(summary).getByText(message)).toBeTruthy();
    if (status === 401 || status === 403) {
      expect(authFailure).toHaveBeenCalledWith(expect.objectContaining({ status }));
      expect(document.activeElement).toBe(t.action);
    } else await waitFor(() => expect(document.activeElement).toBe(summary));
  });
}

it("does not attribute a public-reference save failure to an HTTPS inspection", async () => {
  const t = await open("inspect");
  fireEvent.change(screen.getByLabelText("SHA-256 校验值"), { target: { value: "a".repeat(64) } });
  await userEvent.click(screen.getByRole("button", { name: "保存公开引用" }));
  const summary = await screen.findByRole("group", { name: "操作未完成", description: diagnostic });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect(t.writes).toHaveLength(1);
  expect(t.writes[0].path).toBe("/api/me/resources");
  expect(screen.queryByText(title)).toBeNull();
  expect(screen.queryByText("查看检查详情")).toBeNull();
});

it.each([false, true])("preserves ErrorNotice defaults and immutable error data with explicit presentation and focus handle %s", async (focusable) => {
  const details = Object.freeze({ error: diagnostic, reason: "fixture-address-check" });
  const error = Object.freeze(new APIError(diagnostic, 422, details));
  const focusRef = createRef<ErrorNoticeFocusHandle>();
  const presentation = { title, recovery: recovery.fetch, detailsLabel: "查看检查详情" };
  const tree = (custom: boolean) => <><input aria-label="Keep manual focus" /><ErrorNotice error={error} focusRef={focusable ? focusRef : undefined} presentation={custom ? presentation : undefined} /></>;
  const view = mount(tree(false));
  const input = screen.getByLabelText("Keep manual focus");
  await userEvent.click(input);
  expect(within(screen.getByRole("alert")).getByText("操作未完成")).toBeTruthy();
  expect(within(screen.getByRole("alert")).getByText(diagnostic)).toBeTruthy();
  expect(screen.queryByText("查看检查详情")).toBeNull();
  view.rerender(<QueryClientProvider client={clients[clients.length - 1]}><UIProviders>{tree(true)}</UIProviders></QueryClientProvider>);
  expect(document.activeElement).toBe(input);
  const disclosure = screen.getByText("查看检查详情").closest("details")!;
  expect(disclosure.open).toBe(false);
  expect(screen.getByText(recovery.fetch)).toBeTruthy();
  if (focusable) {
    act(() => { expect(focusRef.current?.focus()).toBe(true); });
    expect(document.activeElement).toBe(screen.getByRole("group", { name: title, description: recovery.fetch }));
  } else expect(screen.getByRole("alert").hasAttribute("tabindex")).toBe(false);
  expect(error.message).toBe(diagnostic);
  expect(error.status).toBe(422);
  expect(error.details).toBe(details);
});

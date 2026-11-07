// @vitest-environment jsdom
// Real forms/dialogs and the HTTP boundary; viewport visibility is proved separately.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RuleFileImport } from "./RuleFileImport";
import { ResourcesPage } from "./Resources";
import { TaskDialog } from "./ui-patterns/task-overlays";
import { installSessionTransport } from "./api";
import type { ReactNode } from "react";

const diagnostic = "invalid or excessive mihomo-yaml rule file envelope";
const recovery = "已保留所选文件和填写内容。请核对文件格式，或修正文件后重新选择，再导入。";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
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
function mount(children: ReactNode = <RuleFileImport onClose={() => {}} />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><UIProviders>{children}</UIProviders></QueryClientProvider>);
}
async function selectFile(content = "not-a-rule-payload: true\n") {
  fireEvent.change(screen.getByLabelText("导入资源名称"), { target: { value: "Retained rule file" } });
  await userEvent.upload(screen.getByLabelText("选择规则文件"), new File([content], "rules.yaml"));
}
const submit = () => screen.getByRole("button", { name: "导入并保存文件" });

it("presents one retained selection, focuses actionable envelope recovery, and accepts a corrected file with the same name", async () => {
  const writes: { contentBase64: string }[] = [];
  const closed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    writes.push(JSON.parse(init.body));
    return writes.length < 3 ? json({ error: diagnostic }, 422) : json({ id: "accepted", acceptedVersion: "v1" }, 201);
  }));
  mount(<RuleFileImport onClose={closed} />);
  const input = screen.getByLabelText("选择规则文件") as HTMLInputElement;
  expect(input.hidden).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("尚未选择文件");
  const chooser = screen.getByRole("button", { name: "选择规则文件" });
  const nativeClick = vi.spyOn(input, "click");
  chooser.focus();
  await userEvent.keyboard("{Enter}");
  expect(nativeClick).toHaveBeenCalledOnce();
  await selectFile();
  expect(input.value).toBe("");
  expect(screen.getByRole("status").textContent).toContain("rules.yaml");
  expect(screen.queryByText("尚未选择文件")).toBeNull();
  await userEvent.click(submit());
  const summary = await screen.findByRole("group", { name: "规则文件未通过格式检查", description: recovery });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect(within(summary).getByRole("alert").hasAttribute("tabindex")).toBe(false);
  const details = within(summary).getByText("查看检查详情").closest("details")!;
  expect(details.open).toBe(false);
  await userEvent.click(within(summary).getByText("查看检查详情"));
  expect(details.open).toBe(true);
  expect(within(summary).getByText(diagnostic)).toBeTruthy();
  expect((screen.getByLabelText("导入资源名称") as HTMLInputElement).value).toBe("Retained rule file");
  // Retry without opening the picker sends the exact retained File.
  await userEvent.click(submit());
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "规则文件未通过格式检查" })));
  expect(writes[1]).toEqual(writes[0]);
  // Choosing a corrected file with the same name must not be suppressed.
  await selectFile("payload:\n  - corrected.test\n");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("rules.yaml");
  await userEvent.click(submit());
  await waitFor(() => expect(closed).toHaveBeenCalledOnce());
  expect(atob(writes[2].contentBase64)).toBe("payload:\n  - corrected.test\n");
});

it.each([
  [422, "resource address is not public"],
  [422, "rule file SHA-256 does not match the requested pin"],
  [422, "invalid or excessive sing-box-source rule file envelope"],
  [422, "Unrecognized envelope failure"],
  [503, diagnostic],
  [401, diagnostic],
  [403, diagnostic],
] as const)("preserves status %s diagnostic %s instead of claiming a known local format failure", async (status, message) => {
  const authFailure = vi.fn();
  releases.push(installSessionTransport({ beforeRequest: () => ({ beforeSend() {}, waitForResponse: async () => {} }), failed: authFailure }));
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: message }, status)));
  mount(); await selectFile(); await userEvent.click(submit());
  await screen.findByText(message);
  expect(screen.queryByText(recovery)).toBeNull();
  expect(screen.queryByText("查看检查详情")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain(message);
  if (status === 401 || status === 403) {
    expect(authFailure).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(document.activeElement).toBe(submit());
  } else await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "操作未完成", description: message })));
});

it("does not label a fetched HTTPS envelope rejection as a retained local file", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: diagnostic }, 422)));
  mount();
  fireEvent.change(screen.getByLabelText("导入资源名称"), { target: { value: "Remote file" } });
  await userEvent.click(screen.getByRole("combobox", { name: "规则文件导入方式" }));
  await userEvent.click(screen.getByRole("option", { name: "读取 HTTPS 文件并接纳" }));
  fireEvent.change(screen.getByLabelText("导入文件 HTTPS 地址"), { target: { value: "https://example.test/rules.yaml" } });
  await userEvent.click(screen.getByRole("button", { name: "读取并接纳文件" }));
  await screen.findByText(diagnostic);
  expect(screen.queryByText(recovery)).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "操作未完成", description: diagnostic })));
});

it.each(["newer-dialog", "inactive-document", "unmounted"] as const)("does not claim focus after a pending file task becomes %s", async (boundary) => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const view = mount(); await selectFile(); await userEvent.click(submit());
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  let other: HTMLElement | null = null;
  if (boundary === "newer-dialog") {
    mount(<TaskDialog open title="Another task" onOpenChange={() => {}} footer={null}><button>Keep this focus</button></TaskDialog>);
    other = await screen.findByRole("button", { name: "Keep this focus" });
    await userEvent.click(other);
  } else if (boundary === "inactive-document") vi.mocked(document.hasFocus).mockReturnValue(false);
  else view.unmount();
  await act(async () => finish(json({ error: diagnostic }, 422)));
  if (boundary === "unmounted") expect(screen.queryByText(recovery)).toBeNull();
  else {
    await screen.findByText(recovery);
    expect(document.activeElement).not.toBe(screen.getByText(recovery).closest('[role="group"]'));
    if (other) expect(document.activeElement).toBe(other);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    // A later ordinary edit must not replay a skipped handoff.
    if (!other) {
      const name = screen.getByLabelText("导入资源名称");
      await userEvent.click(name);
      fireEvent.change(name, { target: { value: "Edited after returning" } });
      expect(document.activeElement).toBe(name);
    }
  }
});

it("reveals the current public-reference inspection failure without rewriting its diagnostic or clearing input", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (url === "/api/me/resources" && !init?.method) return json([]);
    if (url === "/api/me/resources/inspect") return json({ error: "resource address is not public" }, 422);
    throw new Error("Unexpected request");
  }));
  mount(<ResourcesPage />);
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  const save = screen.getByRole("button", { name: "保存公开引用" }) as HTMLButtonElement;
  const disclosure = screen.getByText("远程文件随配置交付时，客户端会直接访问此地址。只有明确公开的规则文件可用于这种方式。");
  expect(document.getElementById(save.getAttribute("aria-describedby")!)).toBe(disclosure);
  expect(disclosure.closest("[data-task-overlay-footer]")).toBe(save.closest("[data-task-overlay-footer]"));
  expect(screen.getAllByText(disclosure.textContent!)).toHaveLength(1);
  expect(save.form).toBe(screen.getByLabelText("资源名称").closest("form"));
  expect(screen.getByRole("combobox", { name: "文件格式" }).textContent).toBe("Mihomo YAML");
  expect(screen.getByRole("combobox", { name: "更新策略" }).textContent).toBe("跟随远程更新");
  expect((screen.getByLabelText("版本标识") as HTMLInputElement).value).toBe("1");
  expect((screen.getByLabelText("客户端更新间隔（秒）") as HTMLInputElement).value).toBe("86400");
  fireEvent.change(screen.getByLabelText("资源名称"), { target: { value: "Retained public reference" } });
  fireEvent.change(screen.getByLabelText("规则文件 URL"), { target: { value: "https://127.0.0.1/rules.yaml" } });
  await userEvent.click(screen.getByRole("button", { name: "读取文件并计算校验值" }));
  const summary = await screen.findByRole("group", {
    name: "无法读取此规则文件地址",
    description: "该地址不是允许读取的公开地址。当前输入已保留。请改用公开 HTTPS 地址，或取消后选择“导入规则文件”上传本地文件。",
  });
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect((screen.getByLabelText("规则文件 URL") as HTMLInputElement).value).toBe("https://127.0.0.1/rules.yaml");
  expect((screen.getByLabelText("资源名称") as HTMLInputElement).value).toBe("Retained public reference");
  expect((screen.getByLabelText("SHA-256 校验值") as HTMLInputElement).value).toBe("");
});


it.each([401, 403])("leaves a status %s public-reference inspection failure to session recovery", async (status) => {
  const authFailure = vi.fn();
  releases.push(installSessionTransport({ beforeRequest: () => ({ beforeSend() {}, waitForResponse: async () => {} }), failed: authFailure }));
  vi.stubGlobal("fetch", vi.fn(async (url) => url === "/api/me/resources" ? json([]) : json({ error: "Session must be confirmed" }, status)));
  mount(<ResourcesPage />);
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  fireEvent.change(screen.getByLabelText("规则文件 URL"), { target: { value: "https://example.test/rules.yaml" } });
  const inspect = screen.getByRole("button", { name: "读取文件并计算校验值" });
  await userEvent.click(inspect);
  await screen.findByText("Session must be confirmed");
  expect(authFailure).toHaveBeenCalledWith(expect.objectContaining({ status }));
  expect(document.activeElement).toBe(inspect);
});

it("does not move focus out of an active discard decision when inspection fails behind it", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url) => url === "/api/me/resources" ? json([]) : new Promise<Response>((resolve) => { finish = resolve; })));
  mount(<ResourcesPage />);
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  const reference = await screen.findByRole("dialog", { name: "添加公开规则引用" });
  fireEvent.change(within(reference).getByLabelText("规则文件 URL"), { target: { value: "https://127.0.0.1/rules.yaml" } });
  await userEvent.click(within(reference).getByRole("button", { name: "读取文件并计算校验值" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await userEvent.click(within(reference).getByRole("button", { name: "取消" }));
  const decision = await screen.findByRole("alertdialog", { name: "放弃未保存的规则资源修改？" });
  const keepEditing = within(decision).getByRole("button", { name: "继续编辑" });
  keepEditing.focus();
  await act(async () => finish(json({ error: "resource address is not public" }, 422)));
  await within(reference).findByText("resource address is not public");
  expect(document.activeElement).toBe(keepEditing);
  await userEvent.click(keepEditing);
  await waitFor(() => expect(decision.isConnected).toBe(false));
  const name = within(reference).getByLabelText("资源名称");
  await userEvent.click(name);
  fireEvent.change(name, { target: { value: "Continue this reference" } });
  expect(document.activeElement).toBe(name);
});


it("leaves a deliberately focused field alone when its public-reference inspection fails", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url) => url === "/api/me/resources" ? json([]) : new Promise<Response>((resolve) => { finish = resolve; })));
  mount(<ResourcesPage />);
  await screen.findByText("暂无规则资源");
  await userEvent.click(screen.getByRole("button", { name: "添加公开引用" }));
  fireEvent.change(screen.getByLabelText("规则文件 URL"), { target: { value: "https://127.0.0.1/rules.yaml" } });
  await userEvent.click(screen.getByRole("button", { name: "读取文件并计算校验值" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const name = screen.getByLabelText("资源名称");
  await userEvent.click(name); // No edit/cancel: the same request still owns its result.
  await act(async () => finish(json({ error: "resource address is not public" }, 422)));
  await screen.findByText("resource address is not public");
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "Retained deliberate focus" } });
  expect(document.activeElement).toBe(name);
});

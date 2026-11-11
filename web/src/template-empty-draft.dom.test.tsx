// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import Workspace from "./App";
import { setCSRF, setToken } from "./api";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});
let client: QueryClient;
beforeEach(() => {
  history.replaceState(null, "", "#templates");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  setCSRF("");
  setToken("");
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => original(element));
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      return json(url.endsWith("/sanitize") ? { spec: { steps: [] } } : {});
    }
    if (url === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "test-csrf" });
    if (url === "/api/me/collections") return json([
      { id: "one", name: "Saved collection", sources: [], pipeline: [] },
      { id: "two", name: "Other collection", sources: [], pipeline: [] },
    ]);
    return json([]);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><UIProviders><Workspace /></UIProviders></QueryClientProvider>);
  return writes;
}
async function extract() {
  await userEvent.click(await screen.findByRole("button", { name: "发布模板" }));
  const dialog = await screen.findByRole("dialog", { name: "发布共享模板" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "模板名称" }), { target: { value: "Reusable settings" } });
  expect(within(dialog).queryByRole("textbox", { name: "共享结构" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }));
  await userEvent.click(await screen.findByRole("option", { name: "Saved collection" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await within(dialog).findByRole("textbox", { name: "共享结构" });
  return dialog;
}
it("keeps the extracted JSON editor focused and editable when emptied, requiring review of the replacement before publishing", async () => {
  const writes = mount();
  const dialog = await extract();
  await userEvent.click(within(dialog).getByRole("checkbox"));
  const editor = within(dialog).getByRole("textbox", { name: "共享结构" });
  await userEvent.clear(editor);
  expect(within(dialog).getByRole("textbox", { name: "共享结构" })).toBe(editor);
  expect(document.activeElement).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("");
  expect(within(dialog).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(within(dialog).getByRole("button", { name: "发布 v1" }).hasAttribute("disabled")).toBe(true);
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
  fireEvent.change(editor, { target: { value: "invalid JSON" } });
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: "发布 v1" }));
  await within(dialog).findByText("模板结构不是有效的 JSON，请先修正。");
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
  expect((editor as HTMLTextAreaElement).value).toBe("invalid JSON");
  await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(editor.getAttribute("aria-invalid")).toBe("true");
  const errorId = editor.getAttribute("aria-describedby");
  expect(errorId && document.getElementById(errorId)?.textContent).toBe("模板结构不是有效的 JSON，请先修正。");
  await userEvent.click(within(dialog).getByRole("button", { name: "发布 v1" }));
  expect(document.activeElement).toBe(editor);
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
  fireEvent.change(editor, { target: { value: '{"steps":[]}' } });
  expect(within(dialog).queryByText("模板结构不是有效的 JSON，请先修正。")).toBeNull();
  expect(editor.getAttribute("aria-invalid")).not.toBe("true");
  expect(within(dialog).getByRole("button", { name: "发布 v1" }).hasAttribute("disabled")).toBe(true);
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: "发布 v1" }));
  await waitFor(() => expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(1));
  expect(writes.find(write => write.url === "/api/admin/templates")?.body).toMatchObject({ name: "Reusable settings", spec: { steps: [] } });
});

it("hides the previous extracted editor after an explicit source or template-type change until extraction runs again", async () => {
  mount();
  const dialog = await extract();
  await userEvent.click(within(dialog).getByRole("combobox", { name: "从自己的已保存配置提取" }));
  await userEvent.click(await screen.findByRole("option", { name: "Other collection" }));
  expect(within(dialog).queryByRole("textbox", { name: "共享结构" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await within(dialog).findByRole("textbox", { name: "共享结构" });
  await userEvent.click(within(dialog).getByRole("combobox", { name: "模板类型" }));
  await userEvent.click(await screen.findByRole("option", { name: "客户端配置模板" }));
  expect(within(dialog).queryByRole("textbox", { name: "共享结构" })).toBeNull();
});

it("retires invalid JSON feedback after extracting a replacement without publishing or reusing review", async () => {
  const writes = mount();
  const dialog = await extract();
  const editor = within(dialog).getByRole("textbox", { name: "共享结构" });
  fireEvent.change(editor, { target: { value: "invalid JSON" } });
  await userEvent.click(within(dialog).getByRole("checkbox"));
  await userEvent.click(within(dialog).getByRole("button", { name: "发布 v1" }));
  await within(dialog).findByText("模板结构不是有效的 JSON，请先修正。");
  await userEvent.click(within(dialog).getByRole("button", { name: "提取可共享结构" }));
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toContain('"steps": []'));
  expect(within(dialog).queryByText("模板结构不是有效的 JSON，请先修正。")).toBeNull();
  expect(editor.getAttribute("aria-invalid")).not.toBe("true");
  expect((within(dialog).getByRole("textbox", { name: "模板名称" }) as HTMLInputElement).value).toBe("Reusable settings");
  expect(within(dialog).getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  expect(within(dialog).getByRole("button", { name: "发布 v1" }).hasAttribute("disabled")).toBe(true);
  expect(writes.filter(write => write.url === "/api/admin/templates")).toHaveLength(0);
});

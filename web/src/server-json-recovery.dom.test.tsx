// @vitest-environment jsdom
// Actual App/provider composition and route JSON recovery. DOM focus evidence
// only: viewport visibility and native keyboard acceptance remain CI work.
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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import App from "./App";
import { setCSRF, setToken } from "./api";

let client: QueryClient;
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  setCSRF("");
  setToken("");
  history.replaceState(null, "", "#routes");
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
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("returns rejected route JSON to the retained input and permits correction without saving", async () => {
  const writes: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") { writes.push(url); throw new Error(`Unexpected write: ${url}`); }
    if (url === "/api/auth/me") return json({ user: { id: "admin", name: "Admin", role: "admin" }, csrfToken: "test-csrf" });
    if (["/api/hosts", "/api/core-instances", "/api/managed-endpoints", "/api/links", "/api/server-deployments", "/api/me/inbox"].includes(url)) return json([]);
    throw new Error(`Unexpected read: ${url}`);
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders>);
  await act(async () => { await vi.dynamicImportSettled(); });
  const user = userEvent.setup();
  const header = (await screen.findByRole("heading", { name: "转发路径", level: 1 })).closest("header")!;
  await user.click(within(header).getByRole("button", { name: "新建转发路径" }));
  const route = within(await screen.findByRole("dialog", { name: "新建转发路径" }));
  await user.type(route.getByRole("textbox", { name: "转发路径名称" }), "Retained route");
  await user.click(route.getByRole("button", { name: "完整配置（JSON）" }));
  await user.click(route.getByRole("button", { name: "编辑 JSON" }));
  const editor = within(await screen.findByRole("dialog", { name: "服务端配置 JSON" }));
  const input = editor.getByRole("textbox", { name: "服务端配置 JSON 文本" }) as HTMLTextAreaElement;
  const corrected = JSON.stringify({ ...JSON.parse(input.value), topologyRevision: "corrected-local-revision" });
  const rail = input.closest<HTMLElement>("[data-task-overlay-body]")!;
  // Layout and native nearest scrolling are the mocked browser boundary. These
  // independent rectangles reproduce a21ad94's 390×560 CI capture: the focused
  // input fits, but its error starts below the body clip (425.75 versus 423).
  const originalBox = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === rail) return new DOMRect(16, 73.75, 358, 349.25);
    if (this === input) return new DOMRect(32, 149.75 - rail.scrollTop, 326, 256);
    if (rail.contains(this) && this.getAttribute("role") === "alert")
      return new DOMRect(32, 425.75 - rail.scrollTop, 326, 20);
    return originalBox.call(this);
  });
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    if (!rail.contains(this)) return;
    const target = this.getBoundingClientRect(), clip = rail.getBoundingClientRect();
    if (target.bottom > clip.bottom) rail.scrollTop += target.bottom - clip.bottom;
    else if (target.top < clip.top) rail.scrollTop -= clip.top - target.top;
  });
  const expectVisibleError = () => {
    const error = editor.getByRole("alert").getBoundingClientRect();
    const clip = rail.getBoundingClientRect();
    expect(error.top).toBeGreaterThanOrEqual(clip.top);
    expect(error.bottom).toBeLessThanOrEqual(clip.bottom);
    const field = input.getBoundingClientRect();
    expect(Math.min(field.bottom, clip.bottom) - Math.max(field.top, clip.top)).toBeGreaterThanOrEqual(44);
  };
  const focusStates: { invalid: string | null; error: string | null | undefined }[] = [];
  input.addEventListener("focus", () => focusStates.push({ invalid: input.getAttribute("aria-invalid"), error: document.getElementById(input.getAttribute("aria-describedby") || "")?.textContent }));
  const apply = editor.getByRole("button", { name: "应用到草稿" });
  await user.clear(input);
  await user.type(input, "invalid JSON");
  focusStates.length = 0;
  await user.click(apply);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(focusStates).toEqual([{ invalid: "true", error: expect.any(String) }]);
  expect(input.value).toBe("invalid JSON");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const errorId = input.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  expect(document.getElementById(errorId!)?.textContent).toContain("请输入有效的 JSON");
  expectVisibleError();
  rail.scrollTop = 0;
  focusStates.length = 0;
  await user.click(apply);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(focusStates).toEqual([{ invalid: "true", error: expect.any(String) }]);
  expectVisibleError();
  rail.scrollTop = 0;
  await user.clear(input);
  await user.paste('{"schemaVersion":"1.0"}');
  focusStates.length = 0;
  await user.click(apply);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(focusStates).toEqual([{ invalid: "true", error: expect.any(String) }]);
  expect(document.getElementById(errorId!)?.textContent).toContain("programs 数组");
  expectVisibleError();
  rail.scrollTop = 0;
  await user.clear(input);
  await user.type(input, "null");
  focusStates.length = 0;
  await user.click(apply);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(focusStates).toEqual([{ invalid: "true", error: expect.any(String) }]);
  expect(document.getElementById(errorId!)?.textContent).toContain("programs 数组");
  expectVisibleError();
  rail.scrollTop = 0;
  await user.clear(input);
  await user.paste(corrected);
  expect(editor.queryByRole("alert")).toBeNull();
  expect(input.getAttribute("aria-invalid")).toBe("false");
  expect(input.hasAttribute("aria-describedby")).toBe(false);
  await user.click(apply);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "服务端配置 JSON" })).toBeNull());
  expect(route.getByRole("textbox", { name: "转发路径名称" })).toHaveProperty("value", "Retained route");
  await user.click(route.getByRole("button", { name: "编辑 JSON" }));
  const reopened = within(await screen.findByRole("dialog", { name: "服务端配置 JSON" }));
  expect(JSON.parse((reopened.getByRole("textbox", { name: "服务端配置 JSON 文本" }) as HTMLTextAreaElement).value).topologyRevision).toBe("corrected-local-revision");
  expect(reopened.queryByRole("alert")).toBeNull();
  expect(writes).toEqual([]);
});

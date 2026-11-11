// @vitest-environment jsdom
// Actual App/provider composition and native form submission. DOM focus evidence
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
  history.replaceState(null, "", "#sources");
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
it("returns invalid source imports to required input without losing mode, content or consequences", async () => {
  const writes: string[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        writes.push(input);
        throw new Error(`Unexpected write: ${input}`);
      }
      if (input === "/api/auth/me")
        return json({
          user: { id: "source-user", name: "Source user", role: "user" },
          csrfToken: "source-csrf",
        });
      if (["/api/me/sources", "/api/me/inbox"].includes(input)) return json([]);
      throw new Error(`Unexpected read: ${input}`);
    }),
  );
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 },
      mutations: { retry: false },
    },
  });
  render(
    <UIProviders>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </UIProviders>,
  );
  await screen.findByRole("main");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const user = userEvent.setup();
  await user.click(
    (
      await screen.findAllByRole("button", { name: "添加来源" })
    )[0],
  );
  const editor = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const name = editor.getByRole("textbox", { name: "来源名称" });
  const content = editor.getByRole("textbox", { name: "节点链接或配置内容" });
  await user.type(content, "socks5://example.test:1080#Retained");
  const submit = editor.getByRole("button", { name: "导入来源" });
  await user.click(submit);
  await editor.findByText("给来源取一个名称");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(writes).toEqual([]);
  await waitFor(() => expect(document.activeElement).toBe(name));
  expect((content as HTMLTextAreaElement).value).toBe(
    "socks5://example.test:1080#Retained",
  );
  expect(
    editor.getByText("订阅信息由平台解析并加密保存，仅供你的账号使用。"),
  ).toBeTruthy();
  expect(
    editor.getByText(
      "文件先在本地读取，提交后才上传。仅提取受支持的连接内容。",
    ),
  ).toBeTruthy();
  expect(
    editor.getByText(
      "首次导入立即可用。后续更新按此方式应用到来源，不会自动发布订阅。",
    ),
  ).toBeTruthy();
  expect(
    editor
      .getByRole("button", { name: "导入选项" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  await user.type(name, "Retained source");
  await user.click(editor.getByRole("radio", { name: "订阅 URL" }));
  const url = editor.getByLabelText("订阅地址", { exact: true });
  await user.click(submit);
  await editor.findByText("请输入订阅地址");
  await waitFor(() => expect(document.activeElement).toBe(url));
  expect((name as HTMLInputElement).value).toBe("Retained source");
  expect(
    editor
      .getByRole("radio", { name: "订阅 URL" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await user.click(submit);
  await waitFor(() => expect(document.activeElement).toBe(url));
  await user.click(editor.getByRole("radio", { name: "节点 URI / 配置文本" }));
  expect(
    (
      editor.getByRole("textbox", {
        name: "节点链接或配置内容",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("socks5://example.test:1080#Retained");
  expect(writes).toEqual([]);
  await user.click(editor.getByRole("button", { name: "取消" }));
  const discard = within(
    await screen.findByRole("alertdialog", {
      name: "放弃尚未保存的来源修改？",
    }),
  );
  await user.click(
    discard.getByRole("button", { name: "放弃修改" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "添加订阅来源" })).toBeNull(),
  );
  await user.click(
    screen.getAllByRole("button", { name: "添加来源" })[0],
  );
  const reopened = within(
    await screen.findByRole("dialog", { name: "添加订阅来源" }),
  );
  const nextName = reopened.getByRole("textbox", { name: "来源名称" });
  expect((nextName as HTMLInputElement).value).toBe("");
  await user.click(
    reopened.getByRole("button", { name: "导入来源" }),
  );
  await reopened.findByText("给来源取一个名称");
  await waitFor(() => expect(document.activeElement).toBe(nextName));
  expect(writes).toEqual([]);
});

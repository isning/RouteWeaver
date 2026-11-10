// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
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
import { BackupSettings } from "./Backup";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const original = window.getComputedStyle;
  window.getComputedStyle = (element) => original(element);
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retains the creation dialog and passwords after a pending export times out without downloading", async () => {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn(() => response);
  vi.stubGlobal("fetch", fetch);
  const objectURL = vi.fn(() => "blob:synthetic-should-not-be-used");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = objectURL;
      static revokeObjectURL = vi.fn();
    },
  );
  const download = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <BackupSettings />
      </UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "创建加密备份" }));
  const dialog = screen.getByRole("dialog", { name: "创建加密备份" });
  const password = within(dialog).getByLabelText(
    "设置备份密码",
  ) as HTMLInputElement;
  const confirm = within(dialog).getByLabelText(
    "再次输入密码",
  ) as HTMLInputElement;
  fireEvent.change(password, {
    target: { value: "synthetic-backup-password" },
  });
  fireEvent.change(confirm, { target: { value: "synthetic-backup-password" } });
  await user.click(within(dialog).getByRole("button", { name: "加密并下载" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(
    within(dialog)
      .getByRole("button", { name: "加密并下载" })
      .getAttribute("aria-busy"),
  ).toBe("true");
  expect(password.disabled).toBe(true);
  expect(
    within(dialog).queryByText(
      "备份创建超时。请检查服务资源和备份时限后重新创建。",
    ),
  ).toBeNull();
  await act(async () =>
    finish(
      new Response(
        JSON.stringify({
          reason: "backup_export_deadline_exceeded",
          detail: "Backup creation reached the configured time limit.",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
  await within(dialog).findByText(
    "备份创建超时。请检查服务资源和备份时限后重新创建。",
  );
  expect(screen.getByRole("dialog", { name: "创建加密备份" })).toBe(dialog);
  expect(password.value).toBe("synthetic-backup-password");
  expect(confirm.value).toBe("synthetic-backup-password");
  expect(password.disabled).toBe(false);
  expect(
    within(dialog)
      .getByRole("button", { name: "加密并下载" })
      .getAttribute("aria-busy"),
  ).not.toBe("true");
  expect(objectURL).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByText("加密备份已准备好，请保管好文件和密码")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  client.clear();
});

it("groups creation and capacity actions without starting a request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient()}><UIProviders><BackupSettings /></UIProviders></QueryClientProvider>);
  const actions = screen.getByRole("group", { name: "备份操作" });
  const create = within(actions).getByRole("button", { name: "创建加密备份" });
  expect(within(actions).getByRole("button", { name: "检查历史容量" })).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
  await userEvent.click(create);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

it("ignores an abandoned export and only downloads the current page's confirmed response", async () => {
  const completions: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>((resolve) => completions.push(resolve)));
  vi.stubGlobal("fetch", fetch);
  const objectURL = vi.fn(() => "blob:synthetic-current-backup");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = objectURL;
    static revokeObjectURL = vi.fn();
  });
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const mount = () => render(
    <QueryClientProvider client={client}>
      <UIProviders><BackupSettings /></UIProviders>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const prepare = async (password: string) => {
    await user.click(screen.getByRole("button", { name: "创建加密备份" }));
    const dialog = screen.getByRole("dialog", { name: "创建加密备份" });
    fireEvent.change(within(dialog).getByLabelText("设置备份密码"), { target: { value: password } });
    fireEvent.change(within(dialog).getByLabelText("再次输入密码"), { target: { value: password } });
    return dialog;
  };
  const first = mount();
  const oldDialog = await prepare("synthetic-old-backup-password");
  await user.click(within(oldDialog).getByRole("button", { name: "加密并下载" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  first.unmount();

  mount();
  const current = await prepare("synthetic-new-backup-password");
  await act(async () => completions[0](new Response("synthetic old archive", { headers: { "Content-Type": "application/octet-stream" } })));
  await waitFor(() => expect(client.getMutationCache().getAll()[0].state.status).toBe("success"));
  expect(objectURL).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(screen.queryByText("加密备份已准备好，请保管好文件和密码")).toBeNull();
  expect(screen.getByRole("dialog", { name: "创建加密备份" })).toBe(current);
  expect((within(current).getByLabelText("设置备份密码") as HTMLInputElement).value).toBe("synthetic-new-backup-password");
  expect((within(current).getByLabelText("再次输入密码") as HTMLInputElement).value).toBe("synthetic-new-backup-password");

  await user.click(within(current).getByRole("button", { name: "加密并下载" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => completions[1](new Response("synthetic current archive", { headers: { "Content-Type": "application/octet-stream" } })));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(objectURL).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "创建加密备份" })).toBeNull());
  expect(screen.getAllByText("加密备份已准备好，请保管好文件和密码")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  client.clear();
});

it("does not submit dismissed validation into a reopened export and keeps explicit retries single", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: "Synthetic export rejection" }), {
    status: 503, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 2, retryDelay: 0 } } });
  render(<QueryClientProvider client={client}><UIProviders><BackupSettings /></UIProviders></QueryClientProvider>);
  const opener = screen.getByRole("button", { name: "创建加密备份" });
  await userEvent.click(opener);
  const oldDialog = screen.getByRole("dialog", { name: "创建加密备份" });
  for (const name of ["设置备份密码", "再次输入密码"])
    fireEvent.change(within(oldDialog).getByLabelText(name), { target: { value: "synthetic-dismissed-password" } });
  const oldSubmit = within(oldDialog).getByRole("button", { name: "加密并下载" }) as HTMLButtonElement;
  // Native submit queues validation. Dismiss and reopen before its microtasks settle.
  fireEvent.submit(oldSubmit.form!);
  fireEvent.click(within(oldDialog).getByRole("button", { name: "取消" }));
  fireEvent.click(opener);
  const current = screen.getByRole("dialog", { name: "创建加密备份" });
  for (const name of ["设置备份密码", "再次输入密码"])
    fireEvent.change(within(current).getByLabelText(name), { target: { value: "synthetic-current-password" } });
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
  expect((within(current).getByLabelText("设置备份密码") as HTMLInputElement).value).toBe("synthetic-current-password");

  const submit = within(current).getByRole("button", { name: "加密并下载" }) as HTMLButtonElement;
  fireEvent.submit(submit.form!);
  fireEvent.submit(submit.form!);
  await within(current).findByText("Synthetic export rejection");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.getMutationCache().getAll().map((mutation) => mutation.state.variables)).toEqual([{ id: 1 }]);
  expect((within(current).getByLabelText("设置备份密码") as HTMLInputElement).value).toBe("synthetic-current-password");
  await userEvent.click(submit);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(submit.disabled).toBe(false));
  expect(client.getMutationCache().getAll().map((mutation) => mutation.state.variables)).toEqual([{ id: 1 }, { id: 2 }]);
  await userEvent.click(within(current).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "创建加密备份" })).toBeNull();
  client.clear();
});

it("recovers keyboard export validation to the field that needs correction", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><UIProviders><BackupSettings /></UIProviders></QueryClientProvider>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "创建加密备份" }));
  const dialog = screen.getByRole("dialog", { name: "创建加密备份" });
  const password = within(dialog).getByLabelText("设置备份密码");
  const confirm = within(dialog).getByLabelText("再次输入密码");
  const submit = within(dialog).getByRole("button", { name: "加密并下载" });
  submit.focus();
  await user.keyboard("{Enter}");
  await within(dialog).findByText("请使用至少 12 个字符的独立密码");
  await waitFor(() => expect(document.activeElement).toBe(password));
  expect(password.getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(password, { target: { value: "synthetic-corrected-password" } });
  fireEvent.change(confirm, { target: { value: "synthetic-mismatched-password" } });
  submit.focus();
  await user.keyboard("{Enter}");
  await within(dialog).findByText("两次输入的密码不一致");
  await waitFor(() => expect(document.activeElement).toBe(confirm));
  expect(confirm.getAttribute("aria-invalid")).toBe("true");
  expect((password as HTMLInputElement).value).toBe("synthetic-corrected-password");
  expect(fetch).not.toHaveBeenCalled();
  client.clear();
});

it.each(["new-control", "reopened-task"])("does not reclaim export focus after %s", async (mode) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><UIProviders><BackupSettings /></UIProviders></QueryClientProvider>);
  const opener = screen.getByRole("button", { name: "创建加密备份" });
  await userEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "创建加密备份" });
  const submit = within(dialog).getByRole("button", { name: "加密并下载" }) as HTMLButtonElement;
  submit.focus();
  fireEvent.submit(submit.form!);
  let expected: HTMLElement;
  if (mode === "reopened-task") {
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    fireEvent.click(opener);
    expected = within(screen.getByRole("dialog", { name: "创建加密备份" })).getByLabelText("再次输入密码");
  } else {
    expected = within(dialog).getByLabelText("再次输入密码");
  }
  expected.focus();
  await act(async () => {});
  expect(document.activeElement).toBe(expected);
  expect(fetch).not.toHaveBeenCalled();
  if (mode === "reopened-task") expect(screen.queryByRole("alert")).toBeNull();
  client.clear();
});

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

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Suspense, type ComponentType } from "react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackupSettings } from "./Backup";
import { AccountSecurityPage } from "./AccountSecurity";
import { lazyPage } from "./PageBoundary";
import { UIProviders } from "./ui-patterns/providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["loaded", "failed"] as const)(
  "keeps the password draft mounted while the optional MFA module is pending then %s",
  async (outcome) => {
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && init.method !== "GET")
          writes.push(`${init.method} ${url}`);
        return new Response("[]", {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    // This public composition slot can suspend independently of the main task.
    let resolve!: (module: { default: ComponentType }) => void;
    let reject!: (error: Error) => void;
    const module = new Promise<{ default: ComponentType }>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const DeferredMFA = lazyPage(() => module);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <QueryClientProvider client={client}>
        <UIProviders>
          <Suspense fallback={<p>Whole account task loading</p>}>
            <AccountSecurityPage
              session={{
                user: { id: "admin", name: "Admin", role: "admin" },
                csrfToken: "csrf",
              }}
              onSessionChanged={() => {}}
              onSignedOut={() => {}}
              mfaSettings={<DeferredMFA />}
            />
          </Suspense>
        </UIProviders>
      </QueryClientProvider>,
    );
    const password = screen.getByLabelText("新密码", { exact: true });
    fireEvent.change(password, {
      target: { value: "synthetic-unsaved-password" },
    });
    const region = screen.getByRole("region", {
      name: "管理员二次验证设置",
    });
    expect(
      within(region).getByRole("status", { name: "正在加载二次验证设置" }),
    ).toBeTruthy();
    await act(async () => {
      if (outcome === "loaded")
        resolve({ default: () => <button>Loaded MFA task</button> });
      else reject(new Error("Synthetic chunk failure"));
    });
    if (outcome === "loaded")
      await within(region).findByRole("button", { name: "Loaded MFA task" });
    else await within(region).findByRole("alert");
    expect(screen.getByLabelText("新密码", { exact: true })).toBe(password);
    expect(password).toHaveProperty("value", "synthetic-unsaved-password");
    expect(screen.queryByText("Whole account task loading")).toBeNull();
    expect(writes).toEqual([]);
    client.clear();
  },
);
it("keeps section navigation scoped to each mounted backup task and never submits it", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <BackupSettings />
        <BackupSettings />
      </UIProviders>
    </QueryClientProvider>,
  );
  const tasks = screen.getAllByRole("region", { name: "备份与恢复" });
  const second = within(tasks[1]);
  const index = second.getByRole("navigation", { name: "本页备份任务" });
  const link = within(index).getByRole("button", { name: "前往恢复备份" });
  link.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(
    second.getByRole("region", { name: "恢复备份设置" }),
  );
  expect(document.activeElement).not.toBe(
    within(tasks[0]).getByRole("region", { name: "恢复备份设置" }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  client.clear();
});

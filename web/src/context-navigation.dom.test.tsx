// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackupSettings } from "./Backup";
import { UIProviders } from "./ui-patterns/providers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
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

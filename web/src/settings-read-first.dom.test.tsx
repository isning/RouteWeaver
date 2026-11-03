// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminPage } from "./Admin";
import { UIProviders } from "./ui-patterns/providers";
import { hasUnsavedChanges } from "./navigation";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.unstubAllGlobals();
});

function mountSettings() {
  const writes: Record<string, unknown>[] = [];
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      if (url === "/api/settings" && init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      if (url === "/api/settings")
        return json({
          name: "Accepted name",
          registration: "invite",
          timezone: "UTC+8",
        });
      if (url === "/api/state")
        return json({ users: [], nodes: [], routes: [], revisions: [] });
      if (url === "/api/admin/subscription-origin")
        return json({
          revision: 1,
          configuredRevision: 1,
          draftOrigin: "",
          effectiveRevision: 1,
          effectiveOrigin: "",
          defaultOrigin: "https://default.example.test",
          verificationStatus: "not-required",
          tokensUnchanged: true,
        });
      return json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <AdminPage page="settings" />
      </UIProviders>
    </QueryClientProvider>,
  );
  return {
    writes,
    fail: () =>
      act(async () =>
        finish(
          new Response(JSON.stringify({ message: "名称保存失败" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    finish: (value: Record<string, unknown>) =>
      act(async () => finish(json(value))),
  };
}

it("reads accepted platform settings first, edits one name, and cancels without changing the domain draft", async () => {
  const { writes } = mountSettings();
  const edit = await screen.findByRole("button", { name: "编辑平台名称" });
  expect(screen.queryByRole("textbox", { name: "平台名称" })).toBeNull();
  expect(screen.getByText("Accepted name")).toBeTruthy();
  const domain = await screen.findByLabelText("订阅域名草稿");
  fireEvent.change(domain, {
    target: { value: "https://unsaved.example.test" },
  });
  await userEvent.click(edit);
  const name = screen.getByRole("textbox", { name: "平台名称" });
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "Unsubmitted name" } });
  await userEvent.click(screen.getByRole("button", { name: "取消名称修改" }));
  expect(document.activeElement).toBe(edit);
  expect(screen.getByText("Accepted name")).toBeTruthy();
  expect(domain).toHaveProperty("value", "https://unsaved.example.test");
  expect(hasUnsavedChanges()).toBe(true);
  expect(writes).toEqual([]);
});

it("retains a newer in-flight name draft and cancels to the newly accepted baseline", async () => {
  const task = mountSettings();
  await userEvent.click(
    await screen.findByRole("button", { name: "编辑平台名称" }),
  );
  const form = screen.getByRole("form", { name: "平台基本设置" });
  const field = within(form).getByRole("textbox", { name: "平台名称" });
  fireEvent.change(field, { target: { value: "Submitted name" } });
  await userEvent.click(within(form).getByRole("button", { name: "保存设置" }));
  expect(task.writes).toEqual([
    { name: "Submitted name", registration: "invite", timezone: "UTC+8" },
  ]);
  fireEvent.change(field, { target: { value: "Newer draft" } });
  await task.finish({
    name: "Submitted name",
    registration: "invite",
    timezone: "UTC+8",
  });
  expect(screen.getByRole("textbox", { name: "平台名称" })).toBe(field);
  expect(field).toHaveProperty("value", "Newer draft");
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "取消名称修改" }));
  expect(screen.getByText("Submitted name")).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "编辑平台名称" }));
  expect(screen.getByRole("textbox", { name: "平台名称" })).toHaveProperty(
    "value",
    "Submitted name",
  );
});

it("keeps failed name edits editable and does not pretend the accepted summary changed", async () => {
  const task = mountSettings();
  await userEvent.click(
    await screen.findByRole("button", { name: "编辑平台名称" }),
  );
  const field = screen.getByRole("textbox", { name: "平台名称" });
  fireEvent.change(field, { target: { value: "Failed draft" } });
  await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await task.fail();
  await screen.findByText("名称保存失败");
  expect(field).toHaveProperty("value", "Failed draft");
  expect(hasUnsavedChanges()).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "取消名称修改" }));
  expect(screen.getByText("Accepted name")).toBeTruthy();
  expect(hasUnsavedChanges()).toBe(false);
});

it.each(["editor", "domain", "backup"] as const)(
  "accepts the saved name without stealing %s focus",
  async (destination) => {
    const task = mountSettings();
    const edit = await screen.findByRole("button", { name: "编辑平台名称" });
    await userEvent.click(edit);
    const field = screen.getByRole("textbox", { name: "平台名称" });
    const form = field.closest("form");
    fireEvent.change(field, { target: { value: "Saved name" } });
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    let focus: HTMLElement = edit;
    if (destination === "domain") {
      focus = await screen.findByRole("textbox", { name: "订阅域名草稿" });
      await userEvent.click(focus);
    } else if (destination === "backup") {
      focus = screen.getByRole("tab", { name: "备份与恢复" });
      await userEvent.click(focus);
    }
    await task.finish({
      name: "Saved name",
      registration: "invite",
      timezone: "UTC+8",
    });
    expect(document.activeElement).toBe(focus);
    if (destination === "backup")
      await userEvent.click(screen.getByRole("tab", { name: "基本设置" }));
    expect(screen.getByRole("form", { name: "平台基本设置" })).toBe(form);
    expect(screen.queryByRole("textbox", { name: "平台名称" })).toBeNull();
    expect(screen.getByText("Saved name")).toBeTruthy();
    expect(hasUnsavedChanges()).toBe(false);
  },
);

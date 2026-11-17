// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { AccountSecurityPage } from "./AccountSecurity";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function mount(admin = false) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><UIProviders><AccountSecurityPage
    session={{ user: { id: "owner", name: "Owner", role: admin ? "admin" : "user" }, csrfToken: "fixture" }}
    onSessionChanged={() => {}} onSignedOut={() => {}} /></UIProviders></QueryClientProvider>);
}
it("returns a revoked non-current session to a surviving non-destructive control", async () => {
  let removed = false;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/sessions/other" && init?.method === "DELETE") {
      writes.push(url); removed = true; return json({ current: false });
    }
    if (init?.method && init.method !== "GET") throw new Error("Unexpected write");
    if (url === "/api/auth/sessions") return json(removed ? [] : [{ id: "other", current: false, expiresAt: "2027-01-01T00:00:00Z" }]);
    return json([]);
  }));
  mount();
  await userEvent.click(await screen.findByRole("button", { name: "退出此会话" }));
  await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "退出会话" }));
  await screen.findByText("没有有效会话。");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "刷新会话" })));
  expect(writes).toEqual(["/api/auth/sessions/other"]);
});
it.each(["identity", "new-control", "navigation"])("preserves the %s focus owner across delayed retirement refresh", async (mode) => {
  let retired = false, deliver!: () => void;
  const target = { id: "target", username: "target-login", name: "Target", role: "user", retired: false, disabled: false, mfaEnabled: false };
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/accounts/target/security" && init?.method === "POST") {
      writes.push(url); retired = true; return json({ ...target, retired: true });
    }
    if (init?.method && init.method !== "GET") throw new Error("Unexpected write");
    if (url === "/api/admin/accounts") return retired
      ? new Promise<Response>(resolve => { deliver = () => resolve(json([{ ...target, retired: true }])); })
      : json([target]);
    return json([]);
  }));
  const rendered = mount(true);
  const opener = await screen.findByRole("button", { name: "管理 Target" });
  await userEvent.click(opener);
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await userEvent.click(opener);
  const dialog = within(screen.getByRole("dialog", { name: "管理 Target 的账号" }));
  await userEvent.click(dialog.getByRole("combobox", { name: "账号操作" }));
  await userEvent.click(screen.getByRole("option", { name: "永久退役账号" }));
  fireEvent.change(dialog.getByLabelText("输入登录名以确认永久退役"), { target: { value: "target-login" } });
  fireEvent.change(dialog.getByLabelText("操作原因"), { target: { value: "User requested retirement" } });
  fireEvent.change(dialog.getByLabelText("管理员当前密码"), { target: { value: "synthetic-password" } });
  await userEvent.click(dialog.getByRole("button", { name: "永久退役账号" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(deliver).toBeTypeOf("function"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Target")));
  let next: HTMLElement | undefined;
  if (mode === "new-control") {
    next = screen.getByLabelText("当前密码");
    next.focus();
  } else if (mode === "navigation") {
    rendered.unmount();
    render(<button>下一页操作</button>);
    next = screen.getByRole("button", { name: "下一页操作" });
    next.focus();
  }
  await act(async () => deliver());
  if (mode !== "navigation") await screen.findByText("已永久退役");
  await waitFor(() => expect(document.activeElement).toBe(next || screen.getByText("Target")));
  expect(writes).toEqual(["/api/admin/accounts/target/security"]);
});

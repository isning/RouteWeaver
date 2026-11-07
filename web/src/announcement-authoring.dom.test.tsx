// @vitest-environment jsdom
// Real announcement form and recipient HTTP boundary; no form/component mocks.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { NotificationsAdminPage } from "./Notifications";
const clients: QueryClient[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); onlineManager.setOnline(true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(catalog: () => Promise<Response> = async () => json({ users: [] }), announcements: { id: string }[] = []) {
  const writes: any[] = [];
  const methods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if ((method === "POST" && url === "/api/admin/announcements") ||
        (method === "PUT" && announcements.some(a => url === `/api/admin/announcements/${a.id}`))) {
      methods.push(method);
      writes.push(JSON.parse(String(init?.body)));
      return json({});
    }
    if (method === "GET" && url === "/api/state") return catalog();
    if (method === "GET" && url === "/api/admin/announcements") return json(announcements);
    throw new Error(`Unexpected announcement request: ${method} ${url}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><NotificationsAdminPage /></UIProviders></QueryClientProvider>);
  return { writes, methods, client };
}
async function create() {
  await userEvent.click(await screen.findByRole("button", { name: "创建公告" }));
  const dialog = await screen.findByRole("dialog", { name: "创建公告" });
  fireEvent.change(within(dialog).getByLabelText("公告标题"), { target: { value: "维护通知" } });
  fireEvent.change(within(dialog).getByLabelText("公告正文"), { target: { value: "维护时间已安排。" } });
  return dialog;
}
async function audience(dialog: HTMLElement, name: string) {
  await userEvent.click(within(dialog).getByRole("combobox", { name: "通知谁" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}
function submit(dialog: HTMLElement) { fireEvent.submit(within(dialog).getByLabelText("公告标题").closest("form")!); }
it.each([
  ["公告标题", "界".repeat(53) + "a", "界".repeat(53) + "ab", "标题最多 160 字节（UTF-8），请缩短标题。"],
  ["公告正文", "😀".repeat(2000), "😀".repeat(2000) + "a", "正文最多 8000 字节（UTF-8），请缩短正文。"],
])("validates %s in UTF-8 bytes and accepts the exact Unicode boundary", async (label, valid, invalid, error) => {
  const state = mount(); const dialog = await create();
  const input = within(dialog).getByLabelText(label);
  fireEvent.change(input, { target: { value: invalid } }); submit(dialog);
  await within(dialog).findByText(error); expect(state.writes).toHaveLength(0);
  expect((input as HTMLInputElement).value).toBe(invalid);
  fireEvent.change(input, { target: { value: valid } }); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0][label === "公告标题" ? "title" : "body"]).toBe(valid);
});
it.each(["\u0085", "\u2003", "hello\0world"])("rejects backend-invalid text %j without discarding it", async value => {
  const state = mount(); const dialog = await create();
  fireEvent.change(within(dialog).getByLabelText("公告正文"), { target: { value } }); submit(dialog);
  await waitFor(() => expect(within(dialog).getByLabelText("公告正文").getAttribute("aria-invalid")).toBe("true"));
  expect(state.writes).toHaveLength(0);
});
it("accepts the BOM character that Go does not classify as whitespace", async () => {
  const state = mount(); const dialog = await create();
  fireEvent.change(within(dialog).getByLabelText("公告正文"), { target: { value: "\ufeff" } }); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].body).toBe("\ufeff");
});
it("distinguishes pending, failed and authoritative empty recipients and retries without losing draft", async () => {
  let release!: (response: Response) => void;
  let first = true;
  const state = mount(() => first ? new Promise(resolve => { release = resolve; }) : Promise.resolve(json({ users: [] })));
  const dialog = await create(); await audience(dialog, "指定用户");
  expect(within(dialog).getByText("正在读取公告接收用户，请稍候。")).toBeTruthy();
  expect(within(dialog).queryByText(/暂无可选用户/)).toBeNull();
  submit(dialog);
  await within(dialog).findByText("请等用户列表读取成功后再保存。");
  expect(state.writes).toHaveLength(0);
  await act(async () => release(json({ error: "unavailable" }, 503)));
  await within(dialog).findByText("无法读取公告接收用户，请重试。草稿和已选用户已保留。");
  first = false;
  await userEvent.click(within(dialog).getByRole("button", { name: "重试读取用户" }));
  await within(dialog).findByText("暂无可选用户。");
  expect((within(dialog).getByLabelText("公告标题") as HTMLInputElement).value).toBe("维护通知");
  submit(dialog); await within(dialog).findByText("请选择 1 至 500 位用户。");
  expect(state.writes).toHaveLength(0);
  await audience(dialog, "管理员"); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].audience).toBe("admins");
});
it.each(["全部用户", "管理员"])("keeps %s independent of an unavailable recipient catalog", async name => {
  const state = mount(async () => json({ error: "unavailable" }, 503));
  const dialog = await create(); await audience(dialog, name); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].userIds).toEqual([]);
});
it("keeps selected duplicate identities through reload failure and confirmed removal until explicitly removed", async () => {
  let response = { users: [{ id: "user-a", name: "同名" }, { id: "user-b", name: "同名" }] };
  let fail = false;
  const state = mount(async () => fail ? json({ error: "unavailable" }, 503) : json(response));
  const dialog = await create(); await audience(dialog, "指定用户");
  await within(dialog).findByText("按姓名或用户标识选择接收公告的用户。");
  await userEvent.click(within(dialog).getByRole("combobox", { name: "选择用户" }));
  expect(await screen.findByRole("option", { name: "同名，用户标识 user-a" })).toBeTruthy();
  await userEvent.click(screen.getByRole("option", { name: "同名，用户标识 user-b" }));
  await userEvent.keyboard("{Escape}");
  expect(within(dialog).getByRole("button", { name: "移除 同名，用户标识 user-b" })).toBeTruthy();
  fail = true;
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新用户列表" }));
  await within(dialog).findByText("无法读取公告接收用户，请重试。草稿和已选用户已保留。");
  expect(within(dialog).getByRole("button", { name: "移除 同名，用户标识 user-b" })).toBeTruthy();
  submit(dialog); await within(dialog).findByText("请等用户列表读取成功后再保存。"); expect(state.writes).toHaveLength(0);
  fail = false; response = { users: [{ id: "user-a", name: "同名" }] };
  await userEvent.click(within(dialog).getByRole("button", { name: "重试读取用户" }));
  await within(dialog).findByText("部分已选用户不在当前列表中。请移除这些用户或刷新列表后再保存。");
  expect(within(dialog).getByRole("button", { name: "移除 同名，用户标识 user-b" })).toBeTruthy();
  submit(dialog); await within(dialog).findByText("请移除当前列表中不存在的用户后再保存。"); expect(state.writes).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole("button", { name: "移除 同名，用户标识 user-b" }));
  await userEvent.click(within(dialog).getByRole("combobox", { name: "选择用户" }));
  await userEvent.click(await screen.findByRole("option", { name: "同名，用户标识 user-a" }));
  await userEvent.keyboard("{Escape}"); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].userIds).toEqual(["user-a"]);
});
it("shows an offline catalog as unknown and recovers the selected-user task on reconnect", async () => {
  onlineManager.setOnline(false);
  const state = mount(async () => json({ users: [{ id: "user-a", name: "接收者" }] }));
  const dialog = await create(); await audience(dialog, "指定用户");
  expect(within(dialog).getByText("等待网络连接，暂时无法核对公告接收用户。")).toBeTruthy();
  submit(dialog); await within(dialog).findByText("请等用户列表读取成功后再保存。"); expect(state.writes).toHaveLength(0);
  act(() => onlineManager.setOnline(true));
  await within(dialog).findByText("按姓名或用户标识选择接收公告的用户。");
  await userEvent.click(within(dialog).getByRole("combobox", { name: "选择用户" }));
  await userEvent.click(await screen.findByRole("option", { name: "接收者，用户标识 user-a" }));
  await userEvent.keyboard("{Escape}"); submit(dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].userIds).toEqual(["user-a"]);
});
it("keeps the chosen duplicate identity while refreshing and saves it after recovery", async () => {
  const users = [{ id: "user-a", name: "同名" }, { id: "user-b", name: "同名" }];
  let held = false;
  let release!: (response: Response) => void;
  const state = mount(() => held ? new Promise(resolve => { release = resolve; }) : Promise.resolve(json({ users })));
  const dialog = await create(); await audience(dialog, "指定用户");
  await within(dialog).findByText("按姓名或用户标识选择接收公告的用户。");
  await userEvent.click(within(dialog).getByRole("combobox", { name: "选择用户" }));
  await userEvent.click(await screen.findByRole("option", { name: "同名，用户标识 user-b" }));
  await userEvent.keyboard("{Escape}");
  held = true;
  await userEvent.click(within(dialog).getByRole("button", { name: "刷新用户列表" }));
  await within(dialog).findByText("正在读取公告接收用户，请稍候。");
  expect(within(dialog).getByRole("button", { name: "移除 同名，用户标识 user-b" })).toBeTruthy();
  submit(dialog); await within(dialog).findByText("请等用户列表读取成功后再保存。"); expect(state.writes).toHaveLength(0);
  await act(async () => release(json({ error: "unavailable" }, 503)));
  await within(dialog).findByText("无法读取公告接收用户，请重试。草稿和已选用户已保留。");
  held = false;
  await userEvent.click(within(dialog).getByRole("button", { name: "重试读取用户" }));
  await within(dialog).findByText("按姓名或用户标识选择接收公告的用户。");
  expect((within(dialog).getByLabelText("公告标题") as HTMLInputElement).value).toBe("维护通知");
  submit(dialog); await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0].userIds).toEqual(["user-b"]);
});

// Begin with a legitimate saved announcement, rather than hundreds of clicks.
// Only the boundary-crossing choices are made through the visible picker.
async function editLargeAudience() {
  const users = Array.from({ length: 501 }, (_, index) => ({
    id: `recipient-${index + 1}`,
    name: `接收者 ${index + 1}`,
  }));
  const announcement = {
    id: "notice-large-audience", title: "已有指定用户公告", body: "保留已有接收用户。",
    audience: "users", userIds: users.slice(0, 499).map(user => user.id),
    startsAt: "2026-11-07T10:00:00.000Z", expiresAt: "2026-11-08T10:00:00.000Z", enabled: true,
  };
  const state = mount(async () => json({ users }), [announcement]);
  await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑公告" });
  await within(dialog).findByText("按姓名或用户标识选择接收公告的用户。");
  expect(within(dialog).getByText("已选择 499 项")).toBeTruthy();
  return { ...state, dialog, originalIds: announcement.userIds };
}
async function addRecipient(dialog: HTMLElement, number: number) {
  await userEvent.click(within(dialog).getByRole("combobox", { name: "选择用户" }));
  fireEvent.change(screen.getByRole("combobox", { name: "搜索选项" }), { target: { value: `recipient-${number}` } });
  await userEvent.click(await screen.findByRole("option", { name: `接收者 ${number}，用户标识 recipient-${number}` }));
  await userEvent.keyboard("{Escape}");
}
it("saves an edited announcement with exactly 500 chosen recipients", async () => {
  const state = await editLargeAudience();
  await addRecipient(state.dialog, 500);
  expect(within(state.dialog).getByText("已选择 500 项")).toBeTruthy();
  submit(state.dialog);
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.methods).toEqual(["PUT"]);
  expect(state.writes[0].userIds).toHaveLength(500);
  expect(state.writes[0].userIds).toEqual([...state.originalIds, "recipient-500"]);
});
it("blocks 501 recipients without silently dropping any selected identity", async () => {
  const state = await editLargeAudience();
  await addRecipient(state.dialog, 500);
  await addRecipient(state.dialog, 501);
  submit(state.dialog);
  await within(state.dialog).findByText("请选择 1 至 500 位用户。");
  expect(state.writes).toHaveLength(0);
  expect(within(state.dialog).getByText("已选择 501 项")).toBeTruthy();
  expect(within(state.dialog).getAllByRole("button", { name: /^移除 接收者 / })).toHaveLength(501);
  expect(within(state.dialog).getByRole("button", { name: "移除 接收者 500，用户标识 recipient-500" })).toBeTruthy();
  expect(within(state.dialog).getByRole("button", { name: "移除 接收者 501，用户标识 recipient-501" })).toBeTruthy();
  expect((within(state.dialog).getByLabelText("公告正文") as HTMLTextAreaElement).value).toBe("保留已有接收用户。");
});

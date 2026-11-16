// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountSecurityPage } from "./AccountSecurity";
import { UIProviders } from "./ui-patterns/providers";
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); });
function mount(required = false, failSave = false) {
  let enabled = true;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/tracking")) {
      if (failSave) return new Response(JSON.stringify({error:"unavailable"}), {status:503});
      enabled = JSON.parse(String(init?.body)).enabled;
    }
    const body = path.includes("subscription-fetches")
      ? {items: [], trackSourceIps: enabled, limit:100, windowDays:30} : [];
    return new Response(JSON.stringify(body), {status:200,headers:{"Content-Type":"application/json"}});
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders><AccountSecurityPage
    session={{user:{id:"u",name:"Test",role:"user",passwordChangeRequired:required},csrfToken:"synthetic"}}
    onSessionChanged={() => {}} onSignedOut={() => {}} /></UIProviders></QueryClientProvider>);
  return fetcher;
}
it("keeps collection controls in account privacy settings and confirms clearing or restoring", async () => {
  const fetcher = mount();
  await screen.findByRole("region", {name:"订阅隐私设置"});
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("subscription-fetches"))).toBe(false);
  fireEvent.click(screen.getByRole("button", {name:"管理新 IP 提醒"}));
  const settings = await screen.findByRole("dialog", {name:"订阅隐私"});
  await within(settings).findByText("已开启");
  expect(screen.queryByText("拉取记录设置")).toBeNull();
  fireEvent.click(within(settings).getByRole("button", {name:"关闭并清除地址"}));
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/已有备份不受影响/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button",{name:"取消"}));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(within(settings).getByRole("button", {name:"关闭并清除地址"}));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button",{name:"关闭并清除"}));
  await within(settings).findByText("已关闭");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(within(settings).getByRole("button", {name:"恢复新 IP 提醒"}));
  dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/保留近 30 天内最近 100 次记录/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button",{name:"恢复提醒"}));
  await within(settings).findByText("已开启");
  expect(fetcher.mock.calls.filter(([,init]) => init?.method === "PUT").map(([,init]) => JSON.parse(String(init?.body)))).toEqual([{enabled:false},{enabled:true}]);
});
it("requires a successful refresh after an uncertain save instead of repeating the write", async () => {
  const fetcher = mount(false, true);
  fireEvent.click(await screen.findByRole("button", {name:"管理新 IP 提醒"}));
  fireEvent.click(await screen.findByRole("button",{name:"关闭并清除地址"}));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button",{name:"关闭并清除"}));
  await screen.findByText("保存结果未确认，请刷新核对。");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByRole("button",{name:"关闭并清除地址"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"刷新设置"}));
  await waitFor(() => expect((screen.getByRole("button",{name:"关闭并清除地址"}) as HTMLButtonElement).disabled).toBe(false));
  expect(fetcher.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(1);
});
it("does not request subscription privacy before a required password change", async () => {
  const fetcher = mount(true);
  await screen.findByText("请先更换临时密码");
  expect(screen.queryByRole("region",{name:"订阅隐私设置"})).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("subscription-fetches"))).toBe(false);
});

it("closes and reopens privacy settings without submitting a change", async () => {
  const fetcher = mount();
  fireEvent.click(await screen.findByRole("button", {name:"管理新 IP 提醒"}));
  await screen.findByText("已开启");
  const dialog = screen.getByRole("dialog", {name:"订阅隐私"});
  fireEvent.click(within(dialog).getByRole("button", {name:"关闭"}));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", {name:"管理新 IP 提醒"}));
  await screen.findByText("已开启");
  expect(fetcher.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(0);
});

// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { ResourcesPage } from "./Resources";
import { PublishedRoutesPage } from "./PublishedRoutes";
import { ServersPage } from "./Infrastructure";
const clients: QueryClient[] = [];
afterEach(() => { location.hash = ""; cleanup(); clients.splice(0).forEach(c => c.clear()); vi.unstubAllGlobals(); });
function mount(node: React.ReactNode, records: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: unknown, _init?: RequestInit) => new Response(JSON.stringify(records[new URL(String(url), "http://localhost").pathname.replace(/^\/api/, "")] ?? []), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}}); clients.push(client);
  render(<QueryClientProvider client={client}><UIProviders>{node}</UIProviders></QueryClientProvider>);
  return fetcher;
}
it("resource search combines with failure filter and clearing restores records without writes", async () => {
  const fetcher = mount(<ResourcesPage />, {"/me/resources":[
    {id:"r1",name:"Video rules",format:"domain",refreshStatus:"failed"},
    {id:"r2",name:"Chat rules",format:"ip",refreshStatus:"ok"},
  ]});
  await screen.findByRole("button", {name:"Video rules"});
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索规则资源"}),{target:{value:"  VIDEO  "}});
  expect(screen.queryByRole("button",{name:"Chat rules"})).toBeNull();
  fireEvent.click(within(screen.getByRole("group",{name:"筛选规则资源"})).getByRole("button",{name:/刷新失败/}));
  expect(screen.getByRole("button",{name:"Video rules"})).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索规则资源"}),{target:{value:"Chat"}});
  expect(screen.getByText("没有符合条件的规则资源")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"清除筛选"}));
  expect(screen.getByRole("button",{name:"Chat rules"})).toBeTruthy();
  expect(fetcher.mock.calls.every((call:any) => !call[1]?.method || call[1].method === "GET")).toBe(true);
});
it("line search matches actual name/address/path and clearing restores list", async () => {
  mount(<PublishedRoutesPage />, {"/published-routes":[
    {id:"l1", name:"Tokyo", publicHost:"jp.example", publicPort:443, status:"draft", deploymentId:"d1"},
    {id:"l2", name:"London", publicHost:"uk.example", publicPort:8443, status:"draft", deploymentId:"d2"},
  ], "/server-deployments":[{id:"d1",name:"Japan path",ir:{programs:[]}}, {id:"d2",name:"Britain path",ir:{programs:[]}}]});
  await screen.findByRole("button",{name:"Tokyo"});
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索线路"}),{target:{value:" UK.EXAMPLE "}});
  expect(screen.queryByRole("button",{name:"Tokyo"})).toBeNull();
  expect(screen.getByRole("button",{name:"London"})).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索线路"}),{target:{value:"Britain path"}});
  expect(screen.getByRole("button",{name:"London"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Tokyo"})).toBeNull();
  fireEvent.change(screen.getByRole("searchbox",{name:"搜索线路"}),{target:{value:"missing"}});
  expect(screen.getByText("没有符合条件的线路")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"清除搜索"}));
  expect(screen.getByRole("button",{name:"Tokyo"})).toBeTruthy();
});

it("server cards keep a quiet, functional entry action below the page primary", async () => {
  mount(<ServersPage />, {"/hosts":[{id:"h1",name:"Tokyo host",address:"192.0.2.1"}]});
  const entry = await screen.findByRole("button",{name:"进入服务器 Tokyo host"});
  expect(entry.getAttribute("data-variant")).toBe("ghost");
  expect(entry.classList.contains("w-full")).toBe(false);
  expect(screen.getByRole("button",{name:"添加服务器"}).getAttribute("data-variant")).toBe("default");
  fireEvent.click(entry);
  expect(await screen.findByRole("button", {name:"编辑服务器"})).toBeTruthy();
});
it.each(["resources", "lines"])("%s search resets pagination and clearing does not resurrect page two", async (kind) => {
  const rows = Array.from({length:12}, (_, i) => ({id:`r${i}`,name:`Record ${String(i).padStart(2,"0")}`, format:"domain",status:"draft",deploymentId:"d",publicHost:"example.test",publicPort:443}));
  mount(kind === "resources" ? <ResourcesPage /> : <PublishedRoutesPage />, {[kind === "resources" ? "/me/resources" : "/published-routes"]:rows});
  await screen.findByRole("button",{name:"Record 00"});
  expect(screen.queryByText("已加载",{exact:false})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"下一页"}));
  expect(screen.queryByRole("button",{name:"Record 00"})).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", {name:kind === "resources" ? "搜索规则资源" : "搜索线路"}),{target:{value:"Record 00"}});
  expect(screen.getByRole("button",{name:"Record 00"})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"清除搜索输入"}));
  expect(screen.getByRole("button",{name:"Record 00"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Record 11"})).toBeNull();
});

it.each(["resources", "lines"])("%s does not resurrect an old page when confirmed records shrink then grow", async (kind) => {
  const rows = Array.from({length:12}, (_, i) => ({id:`r${i}`,name:`Record ${String(i).padStart(2,"0")}`,format:"domain",status:"draft",deploymentId:"d",publicHost:"example.test",publicPort:443}));
  mount(kind === "resources" ? <ResourcesPage /> : <PublishedRoutesPage />, {[kind === "resources" ? "/me/resources" : "/published-routes"]:rows});
  await screen.findByRole("button",{name:"Record 00"});
  fireEvent.click(screen.getByRole("button",{name:"下一页"}));
  const key = kind === "resources" ? ["resources"] : ["published-routes"];
  act(() => clients.at(-1)!.setQueryData(key, rows.slice(0,2)));
  expect(await screen.findByRole("button",{name:"Record 00"})).toBeTruthy();
  act(() => clients.at(-1)!.setQueryData(key, rows));
  expect(await screen.findByRole("button",{name:"Record 00"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Record 11"})).toBeNull();
});

it("resource secondary action stays behind a menu and cancellation does not refresh", async () => {
  const user = userEvent.setup();
  const fetcher = mount(<ResourcesPage />, {"/me/resources":[{id:"r1",name:"Rules",format:"domain",acceptedVersion:"v1",canRefresh:true}]});
  const trigger = await screen.findByRole("button", {name:"更多操作 Rules"});
  expect(screen.queryByRole("button", {name:"刷新文件"})).toBeNull();
  expect(screen.getByRole("button", {name:"替换文件"}).getAttribute("data-variant")).toBe("ghost");
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", {name:"刷新文件"}));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("重新读取并接纳「Rules」");
  await user.click(within(dialog).getByRole("button", {name:"取消"}));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(fetcher.mock.calls.every(call => !call[1]?.method || call[1].method === "GET")).toBe(true);
});
it("line editing opens from its secondary menu without changing the primary entry action", async () => {
  const user = userEvent.setup();
  mount(<PublishedRoutesPage />, {"/published-routes":[{id:"l1",name:"Tokyo",endpointIds:[],publicHost:"jp.example",publicPort:443,status:"draft",deploymentId:"d1"}]});
  const trigger = await screen.findByRole("button", {name:"更多操作 Tokyo"});
  expect(screen.getByRole("button",{name:"配置用户入口"}).getAttribute("data-variant")).toBe("ghost");
  await user.click(trigger);
  await user.click(screen.getByRole("menuitem", {name:"编辑"}));
  expect(await screen.findByRole("dialog",{name:"编辑 Tokyo"})).toBeTruthy();
});

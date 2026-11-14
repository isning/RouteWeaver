// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {ResourceHistory, type ResourceHistoryView} from "./ResourceHistory";
const end=new Date().toISOString(),start=new Date(Date.now()-24*3600000).toISOString();
const fixture=():ResourceHistoryView=>({nodeId:"host",available:true,intervalSeconds:300,windowStart:start,windowEnd:end,points:[
 {observedAt:new Date(Date.now()-600000).toISOString(),cpuPercent:0,memoryUsedPercent:50,receiveBytesPerSecond:0,transmitBytesPerSecond:null,breakBefore:true},
 {observedAt:new Date(Date.now()-300000).toISOString(),cpuPercent:25,memoryUsedPercent:60,receiveBytesPerSecond:1024,transmitBytesPerSecond:null,breakBefore:true},
]});
const response=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json"}});
function mount(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ResourceHistory nodeId="host"/></QueryClientProvider>)}
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it("plots actual zeros but does not join restart gaps or turn unknown rates into zeros",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>response(fixture())));mount();
 const chart=await screen.findByRole("img",{name:"计费网卡流量，最近24小时实际采样趋势"});
 expect(chart.querySelectorAll("circle")).toHaveLength(2);
 expect(chart.querySelectorAll("text")).toHaveLength(0); // axis labels stay HTML-sized on narrow screens
 expect(chart.parentElement?.querySelector("span")?.className).toContain("whitespace-nowrap");
 expect(chart.querySelectorAll('line[stroke="currentColor"]')).toHaveLength(0);
 expect(chart.textContent).toContain("0 B/s");
});
it("distinguishes capacity, empty history and errors while retaining prior real samples",async()=>{
 let value=fixture();value.points=[];value.available=false;
 const fetcher=vi.fn(async()=>response(value));vi.stubGlobal("fetch",fetcher);mount();
 await screen.findByText("历史存储容量已满，当前资源数据仍可查看。");
 value={...value,available:true};await userEvent.click(screen.getByRole("button",{name:"刷新资源趋势"}));
 await screen.findByText(/最近 24小时没有历史数据/);
 value=fixture();await userEvent.click(screen.getByRole("button",{name:"刷新资源趋势"}));await screen.findByRole("img",{name:/CPU 与内存/});
 fetcher.mockImplementation(async()=>response({},503));await userEvent.click(screen.getByRole("button",{name:"刷新资源趋势"}));
 await screen.findByText("趋势刷新失败，保留上次读取的数据。");expect(screen.getByRole("img",{name:/CPU 与内存/})).toBeTruthy();
});
it("never displays another node's history",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>response({...fixture(),nodeId:"other"})));mount();
 await screen.findByText("趋势数据尚未确定，请重试。");expect(screen.queryByRole("img")).toBeNull();
});
it("requests hourly seven-day history without relabeling cached daily samples",async()=>{
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);return response(url.includes("window=7d")?{...fixture(),intervalSeconds:3600,windowStart:new Date(Date.now()-7*24*3600000).toISOString()}:fixture())});
 vi.stubGlobal("fetch",fetcher);mount();
 await screen.findByRole("img",{name:/计费网卡流量，最近24小时/});
 await userEvent.click(screen.getByRole("tab",{name:"7 天"}));
 await screen.findByRole("img",{name:/计费网卡流量，最近7天/});
 expect(fetcher.mock.calls.some(([url])=>String(url).includes("window=7d"))).toBe(true);
 expect(screen.queryByRole("img",{name:/最近24小时/})).toBeNull();
});
it("lets keyboard and touch controls inspect exact samples without replacing missing rates with zero",async()=>{
 const data=fixture();vi.stubGlobal("fetch",vi.fn(async()=>response(data)));mount();
 const slider=await screen.findByRole("slider",{name:"计费网卡流量采样时间"});
 expect(slider.getAttribute("aria-valuetext")).toBe(data.points[0].observedAt);
 const {fireEvent}=await import("@testing-library/react");
 fireEvent.change(slider,{target:{value:"1"}});
 expect(slider.getAttribute("aria-valuetext")).toBe(data.points[1].observedAt);
 expect(screen.getByText("1 KiB/s (1,024 B/s)")).toBeTruthy();
 expect(screen.getByText("无数据")).toBeTruthy();
 fireEvent.change(slider,{target:{value:"0"}});
 expect(screen.getByText("0 B/s (0 B/s)")).toBeTruthy();
});
it("opens a real sample table without inventing values and can collapse it", async()=>{
 const data=fixture();vi.stubGlobal("fetch",vi.fn(async()=>response(data)));mount();
 await screen.findByRole("img",{name:/CPU 与内存/});
 expect(screen.queryByRole("table",{name:"资源采样数据"})).toBeNull();
 await userEvent.click(screen.getByRole("button",{name:"查看采样数据（2 条）"}));
 const table=screen.getByRole("table",{name:"资源采样数据"});
 const {within}=await import("@testing-library/react");
 const rows=within(table).getAllByRole("row");expect(rows).toHaveLength(3);
 expect(within(rows[1]).getAllByRole("cell").map(cell=>cell.textContent)).toEqual([expect.any(String),"0%","50%","0 B/s","无数据"]);
 expect(within(rows[2]).getAllByRole("cell").map(cell=>cell.textContent)).toEqual([expect.any(String),"25%","60%","1,024 B/s","无数据"]);
 expect(table.querySelector("time")?.dateTime).toBe(data.points[0].observedAt);
 await userEvent.click(screen.getByRole("button",{name:"收起采样数据（2 条）"}));
 expect(screen.queryByRole("table",{name:"资源采样数据"})).toBeNull();
});

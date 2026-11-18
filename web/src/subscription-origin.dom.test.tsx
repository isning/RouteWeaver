// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { SubscriptionOriginSettings } from "./SubscriptionOriginSettings";
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
const initial="https://old.example/sub/{token}";
const state=(linkTemplate=initial,revision=4)=>({revision,linkTemplate,effectiveOrigin:"",defaultOrigin:"",currentLinkExample:linkTemplate?linkTemplate.replace("{token}","{existing-token}"):"/feed/{existing-token}",tokensUnchanged:true});
beforeAll(()=>Object.defineProperty(window,"matchMedia",{configurable:true,value:()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})}));
const clients:QueryClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());vi.unstubAllGlobals()});
function mount(){const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);render(<QueryClientProvider client={client}><UIProviders><SubscriptionOriginSettings /></UIProviders></QueryClientProvider>);return client}
it.each(["http://192.168.1.2:8080/sub/{token}","http://localhost:5173/download?token={token}","https://10.0.0.1/{token}","https://subscribe.example.com/sub/{token}?name=test",""])("saves template %s directly",async template=>{
 const writes:{path:string;body:any}[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url,init)=>{if(init?.method){const body=JSON.parse(String(init.body));writes.push({path:String(url),body});return json(state(body.linkTemplate,5))}return json(state())}));
 mount();const user=userEvent.setup();const input=await screen.findByRole("textbox",{name:"订阅链接模板"});
 expect(screen.queryByRole("textbox",{name:"订阅域名"})).toBeNull();
 fireEvent.change(input,{target:{value:template}});await user.click(screen.getByRole("button",{name:"保存模板"}));await screen.findByText("订阅链接模板已保存");
 expect(writes).toEqual([{path:"/api/admin/subscription-origin",body:{origin:"",linkTemplate:template,expectedRevision:4,applyImmediately:true}}]);
 expect(input).toHaveProperty("value",template);
});
it("checks connectivity only when requested",async()=>{
 const writes:string[]=[];vi.stubGlobal("fetch",vi.fn(async(url,init)=>{if(init?.method)writes.push(String(url));return json(state(initial,init?.method?5:4))}));
 mount();const user=userEvent.setup();await screen.findByRole("textbox",{name:"订阅链接模板"});expect(writes).toEqual([]);
 await user.click(screen.getByRole("button",{name:"检查连通性"}));await screen.findByText("连通性检查通过");expect(writes).toEqual(["/api/admin/subscription-origin/verify"]);
});
it.each([400,409,500])("preserves template after %s save failure",async status=>{
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>init?.method?json({detail:"Server rejected request"},status):json(state())));
 mount();const user=userEvent.setup();const input=await screen.findByRole("textbox",{name:"订阅链接模板"});fireEvent.change(input,{target:{value:"https://new.example/{token}"}});
 await user.click(screen.getByRole("button",{name:"保存模板"}));await screen.findByRole("alert");expect(input).toHaveProperty("value","https://new.example/{token}");expect(screen.getByText(initial.replace("{token}","{existing-token}"))).toBeTruthy();
});
it.each(["lost response","invalid JSON","incomplete response","wrong target"])("reconciles uncertain template save (%s) without replay",async failure=>{
 let latest=state(),writes=0;const template="http://new.example/{token}";
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{if(!init?.method)return json(latest);writes++;latest=state(template,5);if(failure==="lost response")throw new Error("connection lost");if(failure==="invalid JSON")return new Response("not-json");if(failure==="incomplete response")return json({revision:5});return json(state("https://different.example/{token}",5))}));
 mount();const user=userEvent.setup();const input=await screen.findByRole("textbox",{name:"订阅链接模板"});fireEvent.change(input,{target:{value:template}});await user.click(screen.getByRole("button",{name:"保存模板"}));
 await screen.findByText("保存结果未确认，请重新读取设置后核对");expect(screen.getByRole("button",{name:"保存模板"})).toHaveProperty("disabled",true);
 await user.click(screen.getByRole("button",{name:"重新读取设置"}));await screen.findByText("已读取当前设置，请核对模板");expect(writes).toBe(1);expect(input).toHaveProperty("value",template);
});

it("distinguishes an outdated backend from an invalid template and preserves input",async()=>{
 vi.stubGlobal("fetch",vi.fn(async(_url,init)=>init?.method?json({detail:"invalid JSON request"},400):json(state())));
 mount();const user=userEvent.setup();const input=await screen.findByRole("textbox",{name:"订阅链接模板"});
 const template="https://my.ai.com/feed/{token}";
 fireEvent.change(input,{target:{value:template}});await user.click(screen.getByRole("button",{name:"保存模板"}));
 await screen.findByText("当前后端无法识别订阅链接模板，请更新并重启后端后重试");
 expect(screen.queryByText("请检查地址格式，链接模板需包含一个 {token}")).toBeNull();expect(input).toHaveProperty("value",template);
});

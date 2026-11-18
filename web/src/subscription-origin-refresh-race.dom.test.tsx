// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubscriptionOriginSettings } from "./SubscriptionOriginSettings";
import { UIProviders } from "./ui-patterns/providers";
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
const state=(linkTemplate:string,revision:number)=>({revision,linkTemplate,effectiveOrigin:"",defaultOrigin:"",tokensUnchanged:true,currentLinkExample:linkTemplate.replace("{token}","{existing-token}")});
const clients:QueryClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());vi.unstubAllGlobals()});
it.each(["save-old-read","save-failed-read","verify-old-read","verify-failed-read"])("keeps accepted settings when an older read finishes after %s",async scenario=>{
 vi.stubGlobal("matchMedia",()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
 let reads=0,release!:(response:Response)=>void;
 const writes:{path:string;body:any}[]=[];
 const old=state("http://192.168.1.2:8080/sub/{token}",4);
 let latest=old;
 vi.stubGlobal("fetch",vi.fn(async(url,init)=>{
  if(!init?.method){reads++;if(reads===2)return new Promise<Response>(resolve=>{release=resolve});return json(latest)}
  const body=JSON.parse(String(init.body));writes.push({path:String(url),body});
  latest=state(body.linkTemplate ?? latest.linkTemplate,latest.revision+1);return json(latest);
 }));
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);
 render(<QueryClientProvider client={client}><UIProviders><SubscriptionOriginSettings /></UIProviders></QueryClientProvider>);
 const user=userEvent.setup();const input=await screen.findByRole("textbox",{name:"订阅链接模板"});
 void client.invalidateQueries({queryKey:["subscription-origin"]});await waitFor(()=>expect(reads).toBe(2));
 if(scenario.startsWith("save")){
  fireEvent.change(input,{target:{value:"http://new.example/sub/{token}"}});await user.click(screen.getByRole("button",{name:"保存模板"}));await screen.findByText("订阅链接模板已保存");
 }else{await user.click(screen.getByRole("button",{name:"检查连通性"}));await screen.findByText("连通性检查通过")}
 await act(async()=>release(scenario.endsWith("failed-read")?json({detail:"old failure"},503):json(old)));
 expect(screen.queryByRole("alert")).toBeNull();
 expect(input).toHaveProperty("value",latest.linkTemplate);
 fireEvent.change(input,{target:{value:"http://final.example/sub/{token}"}});await user.click(screen.getByRole("button",{name:"保存模板"}));
 await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1].body.expectedRevision).toBe(5);
 expect(writes[1].body.applyImmediately).toBe(true);
});

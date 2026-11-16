// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UIProviders } from "./ui-patterns/providers";
import { RoutePathSelectionEditor } from "./RoutePathSelectionEditor";
import type { PublishedRoute } from "./PublishedRoutes";
const json = (value: unknown, status=200) => new Response(JSON.stringify(value), {status,headers:{"Content-Type":"application/json"}});
const route: PublishedRoute = {id:"line",name:"Line",deploymentId:"path",endpointIds:["entry"],hops:[{kind:"managed",endpointId:"entry"},{kind:"connector",connectorId:"a"}],publicHost:"127.0.0.1",publicPort:443,revisionToken:"route-r1",status:"draft",diagnostics:[]};
const instance={id:"core",hostId:"host",adapterId:"routeweaver/managed-xray",version:"26.3.27-rw1",name:"Core"};
const listener={id:"entry",instanceId:"core",name:"Entry",connection:{protocol:"vless",host:"0.0.0.0",port:443}};
const deployment={id:"path",name:"Path",revisionToken:"dep-r1",ir:{schemaVersion:"1.0",id:"path",programs:[{instance,listener,egress:[],rules:[],resources:[],defaultAction:{kind:"forward",ref:"b"},connectors:[{id:"a",connection:{protocol:"socks",host:"secret-a.example",port:1080,password:"hidden-secret"}},{id:"b",via:"a",connection:{protocol:"socks",host:"secret-b.example",port:1080}}]}]}};
const candidate={id:route.id,name:route.name,deploymentId:route.deploymentId,endpointIds:route.endpointIds,hops:[...route.hops!,{kind:"connector",connectorId:"b"}],publicHost:route.publicHost,publicPort:route.publicPort};
const before={hops:[{kind:"managed",endpointId:"entry",name:"Captured entry",metadataState:"snapshot"},{kind:"connector",connectorId:"a",programEndpointId:"entry",name:"a",metadataState:"snapshot"}]};
const after={hops:[...before.hops,{kind:"connector",connectorId:"b",programEndpointId:"entry",name:"b",metadataState:"snapshot"}]};
const review={before,after,routeId:"line",reviewToken:"review-r1",revisionToken:"route-r1",status:"reviewed",candidate};
type Call={path:string,method:string,body?:any};
const clients:QueryClient[]=[];
function setup(extra?:(call:Call)=>Response|Promise<Response>|undefined){
 const calls:Call[]=[];const saved=vi.fn(),closed=vi.fn();
 vi.stubGlobal("fetch",vi.fn(async(url,init?:RequestInit)=>{const call={path:String(url),method:init?.method||"GET",body:init?.body?JSON.parse(String(init.body)):undefined};calls.push(call);const override=extra?.(call);if(override)return override;
 if(call.path.endsWith('/path-selection/preview'))return json(review);
 if(call.path.endsWith('/path-selection'))return json({...review,status:'draft-saved',revisionToken:'route-r2'});
 if(call.path.endsWith('/resolve'))return json(route);
 if(call.path.endsWith('/server-deployments'))return json([deployment]);
 if(call.path.endsWith('/hosts'))return json([{id:'host',name:'Host',address:'127.0.0.1'}]);
 if(call.path.endsWith('/core-instances'))return json([instance]);
 if(call.path.endsWith('/managed-endpoints'))return json([listener]);
 return json([]);
 }));
 const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});clients.push(client);
 render(<QueryClientProvider client={client}><UIProviders><RoutePathSelectionEditor route={route} returnFocus={null} onSaved={saved} onClose={closed}/></UIProviders></QueryClientProvider>);
 return {calls,saved,closed,user:userEvent.setup()};
}
beforeEach(()=>{history.replaceState(null,'','#published-routes?line=line');Object.defineProperty(window,'matchMedia',{configurable:true,value:vi.fn(()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}))});vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});const original=window.getComputedStyle;vi.spyOn(window,'getComputedStyle').mockImplementation(e=>original(e));});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.restoreAllMocks();vi.unstubAllGlobals();});
it('reviews the exact current saved path and commits only its token without server secrets',async()=>{
 const {user,calls,saved}=setup();await user.click(screen.getByRole('button',{name:'检查完整路径'}));
 await screen.findByRole('button',{name:'保存路径更新'});
 expect(screen.getByText('外部代理 b')).toBeTruthy();expect(screen.getAllByText('服务器入口 Captured entry')).toHaveLength(2);expect(document.body.textContent).not.toContain('hidden-secret');
 expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
 await user.click(screen.getByRole('button',{name:'保存路径更新'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(calls.filter(c=>c.method==='POST').map(c=>c.body)).toEqual([{expectedRouteRevision:'route-r1',hops:candidate.hops},{expectedRouteRevision:'route-r1',hops:candidate.hops,reviewToken:'review-r1'}]);
 expect(calls.some(c=>c.path.includes('reveal')||c.method==='PUT')).toBe(false);
});
it('requires a fresh check after a conflict and does not reuse the token',async()=>{
 const {user,calls}=setup(c=>c.path.endsWith('/path-selection')?json({error:'changed'},409):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));
 await screen.findByRole('button',{name:'检查完整路径'});expect(screen.queryByRole('button',{name:'保存路径更新'})).toBeNull();expect(calls.filter(c=>c.path.endsWith('/path-selection'))).toHaveLength(1);
});
it.each(['wrong-id','wrong-name','wrong-host','wrong-order','missing-token'])('refuses malformed review %s',async(kind)=>{
 const value=structuredClone(review);if(kind==='wrong-id')value.routeId='other';if(kind==='wrong-name')value.candidate.name='Other';if(kind==='wrong-host')value.candidate.publicHost='other.example';if(kind==='wrong-order')value.candidate.hops.reverse();if(kind==='missing-token')value.reviewToken='';
 const {user,calls}=setup(c=>c.path.endsWith('/preview')?json(value):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await screen.findByText('无法确认路径检查结果，请重新检查。');expect(screen.queryByRole('button',{name:'保存路径更新'})).toBeNull();expect(calls.filter(c=>c.method==='POST')).toHaveLength(1);
});
it('checks an uncertain save by GET instead of replaying the mutation',async()=>{
 let written=false;const {user,calls,saved}=setup(c=>{if(c.path.endsWith('/path-selection')){written=true;return Promise.reject(new TypeError('network'));}if(written&&c.path.endsWith('/resolve'))return json({...candidate,revisionToken:'route-r2'});});
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));await user.click(await screen.findByRole('button',{name:'核对保存结果'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());expect(calls.filter(c=>c.path.endsWith('/path-selection'))).toHaveLength(1);
});
it('does not accept a late preview after navigating away',async()=>{
 let release!:(r:Response)=>void;const {user}=setup(c=>c.path.endsWith('/preview')?new Promise(r=>{release=r;}):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await waitFor(()=>expect(release).toBeTypeOf('function'));
 await act(async()=>{history.replaceState(null,'','#overview');window.dispatchEvent(new HashChangeEvent('hashchange'));release(json(review));});
 await waitFor(()=>expect(screen.queryByRole('button',{name:'保存路径更新'})).toBeNull());
});
it.each(['missing','foreign-entry','unprovable','no-change','principals'])('never previews unavailable topology %s',async(kind)=>{
 const d=structuredClone(deployment);if(kind==='foreign-entry')d.ir.programs[0].listener.id='other';if(kind==='unprovable')d.ir.programs[0].defaultAction.ref='missing';if(kind==='no-change')d.ir.programs[0].defaultAction.ref='a';if(kind==='principals')(d.ir.programs[0] as any).principals=[{id:'user-principal'}];
 const {user,calls}=setup(c=>c.path.endsWith('/server-deployments')?json(kind==='missing'?[]:[d]):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await waitFor(()=>expect(screen.getByRole('button',{name:'检查完整路径'}).hasAttribute('disabled')).toBe(false));expect(screen.queryByRole('button',{name:'保存路径更新'})).toBeNull();expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);
});

it.each(['before-order','after-scope','missing-summary'])('refuses invalid captured summary %s',async kind=>{
 const value=structuredClone(review);if(kind==='before-order')value.before.hops.reverse();if(kind==='after-scope')value.after.hops[2].programEndpointId='another';if(kind==='missing-summary')delete (value as any).after;
 const {user}=setup(c=>c.path.endsWith('/preview')?json(value):undefined);await user.click(screen.getByRole('button',{name:'检查完整路径'}));await screen.findByText('无法确认路径检查结果，请重新检查。');expect(screen.queryByRole('button',{name:'保存路径更新'})).toBeNull();
});
it('keeps a stale commit response uncertain instead of claiming success',async()=>{
 const {user,saved}=setup(c=>c.path.endsWith('/path-selection')?json({...review,status:'draft-saved'}):undefined);await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));await screen.findByRole('button',{name:'核对保存结果'});expect(saved).not.toHaveBeenCalled();
});

it.each([{code:'PATH_SELECTION_UNAVAILABLE',detail:'暂时无法检查完整路径，请重试。'}, {error:'unknown refusal'}])('keeps an ambiguous 422 commit for read-only recovery: %j',async body=>{
 let committed=false;
 const {user,calls,saved}=setup(c=>{
  if(c.path.endsWith('/path-selection')){committed=true;return json(body,422);}
  if(committed&&c.path.endsWith('/resolve'))return json({...candidate,revisionToken:'route-r2'});
 });
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));
 await user.click(await screen.findByRole('button',{name:'核对保存结果'}));await waitFor(()=>expect(saved).toHaveBeenCalledOnce());
 expect(calls.filter(c=>c.path.endsWith('/path-selection'))).toHaveLength(1);
});
it.each(['PATH_SELECTION_UNSUPPORTED','PATH_SELECTION_PRINCIPAL_CHANGED','PATH_SELECTION_UNCHANGED'])('requires a new check after explicit 422 refusal %s',async code=>{
 const {user,calls}=setup(c=>c.path.endsWith('/path-selection')?json({code,detail:'明确拒绝'},422):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));
 await screen.findByRole('button',{name:'检查完整路径'});expect(screen.queryByRole('button',{name:'核对保存结果'})).toBeNull();expect(calls.filter(c=>c.path.endsWith('/path-selection'))).toHaveLength(1);
});
it.each([400,401,403,409])('keeps a non-JSON %i response uncertain',async status=>{
 const {user,calls}=setup(c=>c.path.endsWith('/path-selection')?new Response('upstream unavailable',{status,headers:{'Content-Type':'text/plain'}}):undefined);
 await user.click(screen.getByRole('button',{name:'检查完整路径'}));await user.click(await screen.findByRole('button',{name:'保存路径更新'}));await screen.findByRole('button',{name:'核对保存结果'});
 expect(screen.queryByRole('button',{name:'检查完整路径'})).toBeNull();expect(calls.filter(c=>c.path.endsWith('/path-selection'))).toHaveLength(1);
});

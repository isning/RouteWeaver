import { SettingsGroup, SettingsRow } from "@/ui-patterns/settings-group";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/ui-patterns/actions";
import { useUnsavedChanges } from "./navigation";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APIError, post, put, request } from "./api";
import { ErrorNotice, QueryState } from "./components";

type OriginState = {
 revision:number;
 linkTemplate?:string;
 effectiveOrigin:string;
 defaultOrigin:string;
 currentLinkExample:string;
 tokensUnchanged:boolean;
};
function checked(value:unknown):OriginState {
 const state=value as OriginState;
 if(!state || !Number.isSafeInteger(state.revision) || state.revision<0 || typeof state.effectiveOrigin!=="string" || typeof state.defaultOrigin!=="string" || state.tokensUnchanged!==true || state.currentLinkExample!==(state.linkTemplate ? state.linkTemplate.replace("{token}","{existing-token}") : `${state.effectiveOrigin || state.defaultOrigin}/feed/{existing-token}`))throw new Error("未能读取完整的域名设置，请重试");
 return state;
}
const path="/admin/subscription-origin",key=["subscription-origin"];
function displayError(error:unknown):Error {
 if(error instanceof APIError){
  if(error.status===409)return new Error("设置已被修改，请重新读取后再保存");
  if(error.status===400 && error.message === "invalid JSON request")return new Error("当前后端无法识别订阅链接模板，请更新并重启后端后重试");
  if(error.status===400)return new Error("请检查地址格式，链接模板需包含一个 {token}");
  if(error.status===422)return new Error("未能确认域名连通性，请检查订阅地址是否可访问");
 }
 return error instanceof Error ? error : new Error("操作未完成，请重试");
}
export function SubscriptionOriginSettings(){
 const query=useQuery({queryKey:key,queryFn:async()=>checked(await request(path)),select:checked,refetchOnWindowFocus:false,gcTime:0});
 return <SettingsGroup title="订阅链接">
  <QueryState loading={query.isPending} paused={query.isPaused} loadingLayout="field" error={query.data?null:query.error} retry={()=>query.refetch()}>
   {query.data && <OriginForm state={query.data} readError={query.error} refresh={()=>query.refetch()} />}
  </QueryState>
 </SettingsGroup>;
}
function OriginForm({state,readError,refresh}:{state:OriginState;readError:Error|null;refresh:()=>unknown}){
 const client=useQueryClient();
 const [template,setTemplate]=useState(state.linkTemplate ?? "");
 const templateCurrent=useRef(template);templateCurrent.current=template;
 const templatePrevious=useRef(state.linkTemplate ?? "");
 const [error,setError]=useState<Error|null>(null);
 const [feedback,setFeedback]=useState("");
 const [uncertain,setUncertain]=useState(false);
 const sending=useRef(false);
 const dirty=template!==(state.linkTemplate ?? "");
 useEffect(()=>{
  if(templateCurrent.current===templatePrevious.current)setTemplate(state.linkTemplate ?? "");
  templatePrevious.current=state.linkTemplate ?? "";
 },[state.revision,state.effectiveOrigin,state.linkTemplate]);
 const accept=async(next:OriginState)=>{
  await client.cancelQueries({queryKey:key,exact:true});
  client.setQueryData(key,next);
 };
 const save=useMutation({mutationFn:async()=>{
  const submittedTemplate=template;
  try {
   const next=checked(await put(path,{origin:"",expectedRevision:state.revision,applyImmediately:true,linkTemplate:submittedTemplate}));
   if((next.linkTemplate ?? "")!==submittedTemplate.trim() || next.revision<=state.revision || next.effectiveOrigin!=="")throw new Error("保存结果未能确认");
   return {next,submittedTemplate};
  } catch(cause){
   if(!(cause instanceof APIError && [400,401,403,409,413,429].includes(cause.status)))setUncertain(true);
   throw displayError(cause);
  }
 },onSuccess:async({next,submittedTemplate})=>{
  await accept(next);
  if(templateCurrent.current===submittedTemplate)setTemplate(next.linkTemplate ?? "");
  setFeedback("订阅链接模板已保存");setError(null);setUncertain(false);
 },onError:cause=>setError(displayError(cause))});
 const verify=useMutation({mutationFn:async()=>checked(await post(path+"/verify",{expectedRevision:state.revision})),onSuccess:async next=>{await accept(next);setError(null);setFeedback("连通性检查通过")},onError:cause=>{setError(displayError(cause));void refresh()}});
 const busy=save.isPending || verify.isPending;
 useUnsavedChanges(dirty || save.isPending || uncertain);
 const run=async(action:()=>Promise<unknown>)=>{
  if(sending.current)return;sending.current=true;setError(null);setFeedback("");
  try{await action()}catch(cause){setError(displayError(cause))}finally{sending.current=false}
 };
 return <div className="space-y-5 px-5 pb-5 sm:px-6">
  <label className="grid gap-2 text-sm font-medium">订阅链接模板
   <Input aria-label="订阅链接模板" value={template} disabled={busy} placeholder="https://example.com/sub/{token}" onChange={event=>{setTemplate(event.target.value);setFeedback("");setError(null)}} />
   <span className="text-xs font-normal text-muted-foreground">使用 {"{token}"} 代表订阅凭据，留空使用默认订阅地址</span>
  </label>
  <ErrorNotice error={readError || error} />
  {feedback && <p role="status" className="text-sm text-muted-foreground">{feedback}</p>}
  {uncertain && <p role="status" className="text-sm text-muted-foreground">保存结果未确认，请重新读取设置后核对</p>}
  <div className="flex flex-wrap items-center gap-2">
   <ActionButton pending={save.isPending} disabled={busy || !!readError || uncertain || !dirty} onClick={()=>void run(()=>save.mutateAsync())}>保存模板</ActionButton>
   <ActionButton variant="outline" pending={verify.isPending} disabled={busy || !!readError || uncertain || dirty || !(state.linkTemplate || state.effectiveOrigin)} onClick={()=>void run(()=>verify.mutateAsync())}>检查连通性</ActionButton>
   {(readError || uncertain || error) && <ActionButton variant="outline" disabled={busy} onClick={()=>void run(async()=>{
    const next=checked(await request(path));await accept(next);setUncertain(false);setError(null);setFeedback("已读取当前设置，请核对模板");
   }).catch(cause=>setError(displayError(cause)))}>重新读取设置</ActionButton>}
  </div>
  <dl className="-mx-5 rounded-b-xl bg-muted/20 sm:-mx-6"><SettingsRow label="当前链接示例"><span className="break-all font-mono text-xs">{state.currentLinkExample}</span></SettingsRow></dl>
 </div>;
}

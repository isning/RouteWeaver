import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { APIError, list, request } from "./api";
import { dateLabel } from "./model";
import type { PublishedRoute } from "./PublishedRoutes";
import type { ServerDeployment } from "./types";

interface Delegation {
  enabled: boolean; revision: string; deploymentId?: string; instanceIds?: string[];
  allowedRouteIds?: string[]; maxPrincipalsPerUser?: number; maxPendingIntents?: number;
  allowRuntimeRestart?: boolean; expiresAt?: string;
}
interface Draft { enabled: boolean; routes: string[]; principals: string; pending: string; expiry: string; acknowledge: boolean; revision: string }
function readDelegation(value: Delegation, id: string) {
  if (!value || typeof value.enabled !== "boolean" || typeof value.revision !== "string" ||
      (value.deploymentId !== undefined && value.deploymentId !== id) ||
      (value.enabled && (!value.revision || value.deploymentId !== id || !Array.isArray(value.allowedRouteIds) || !value.allowedRouteIds.every(v => typeof v === "string") ||
        !Array.isArray(value.instanceIds) || !value.instanceIds.every(v => typeof v === "string") || !Number.isInteger(value.maxPrincipalsPerUser) ||
        !Number.isInteger(value.maxPendingIntents) || !Number.isFinite(Date.parse(value.expiresAt || "")) || value.allowRuntimeRestart !== true))) throw new Error("无法核对授权状态");
  return value;
}
function localInput(iso: string) { const d = new Date(iso); return Number.isFinite(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16) : ""; }

/** Explicit administrator capability, never enabled by opening the deployment. */
export function PrincipalDelegationPanel({ deployment }: { deployment: ServerDeployment }) {
  return <Accordion type="multiple"><AccordionItem value="principal-delegation"><AccordionTrigger>独立订阅授权</AccordionTrigger><AccordionContent>
    <DelegationSettings key={`${deployment.id}:${deployment.revisionToken || ""}`} deployment={deployment} />
  </AccordionContent></AccordionItem></Accordion>;
}
function DelegationSettings({ deployment }: { deployment: ServerDeployment }) {
  const id = useId(), client = useQueryClient();
  const path = `/server-deployments/${encodeURIComponent(deployment.id)}/principal-delegation`;
  const key = ["principal-delegation", deployment.id];
  const query = useQuery({ queryKey: key, queryFn: async () => readDelegation(await request<Delegation>(path), deployment.id) });
  const routes = useQuery({ queryKey: ["published-routes"], queryFn: () => list<PublishedRoute>("/published-routes") });
  const choices = (routes.data || []).filter(route => route.deploymentId === deployment.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => readDelegation(await request<Delegation>(path, { method: "PUT", body: JSON.stringify(body) }), deployment.id),
    onSuccess: value => { client.setQueryData(key, value); setDraft(null); setError(""); },
    onError: err => { setError(err instanceof APIError && err.status === 409 ? "授权或路径已变化。请取消编辑并重新读取，核对后再保存。" : "保存未确认成功，请重新读取授权状态后再尝试。输入已保留。"); },
  });
  const begin = () => {
    if (!query.data || query.isError || query.isFetching) return;
    const value = query.data;
    setError("");
    save.reset();
    setDraft({ enabled: value.enabled, revision: value.revision, routes: [...(value.allowedRouteIds || [])], principals: String(value.maxPrincipalsPerUser || 1), pending: String(value.maxPendingIntents || 1), expiry: localInput(value.expiresAt || new Date(Date.now()+7*86400000).toISOString()), acknowledge: false });
  };
  const submit = () => {
    if (!draft || save.isPending) return;
    if (!draft.enabled) { save.mutate({ expectedRevision: draft.revision, enabled: false }); return; }
    const expiry = Date.parse(draft.expiry), principals = Number(draft.principals), pending = Number(draft.pending);
    if (routes.isError || !routes.data || draft.routes.length < 1 || draft.routes.length > 16 || draft.routes.some(route => !choices.some(value => value.id === route))) { setError("请选择此路径的 1 至 16 条线路；无法读取线路时不能启用。"); return; }
    if (!/^\d+$/.test(draft.principals) || !Number.isInteger(principals) || principals < 1 || principals > 64 || !/^\d+$/.test(draft.pending) || !Number.isInteger(pending) || pending < 1 || pending > 4) { setError("每位用户限额须为 1 至 64，同时待处理限额须为 1 至 4。"); return; }
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now()+30*86400000) { setError("有效期须在未来 30 天内。"); return; }
    if (!draft.acknowledge) { setError("请先确认授权范围及实例重载风险。"); return; }
    save.mutate({ expectedRevision: draft.revision, enabled: true, allowedRouteIds: [...draft.routes], maxPrincipalsPerUser: principals, maxPendingIntents: pending, expiresAt: new Date(expiry).toISOString(), allowRuntimeRestart: true });
  };
  const value = query.data;
  const expired = value?.enabled && Date.parse(value.expiresAt || "") <= Date.now();
  return <div className="space-y-4 pt-2">
    <p className="text-sm text-muted-foreground">允许已获配下列平台线路的用户创建独立订阅，无需管理员逐次审批。不会更改已有订阅凭据。</p>
    <Notice tone="warning">新增独立订阅可能重载本路径的入口及中转实例，中断现有连接。仅适用于已确认应用的受管独立入口；权限、线路和配置变化后会重新校验。</Notice>
    {!value && <p role="status">{query.isError ? "无法读取授权状态。" : "正在读取授权状态…"}</p>}
    {query.isError && value && <Notice tone="warning">授权状态刷新失败，以下为上次读取的记录。</Notice>}
    {!draft && <>
      {value && <div className="space-y-2 text-sm"><Badge variant="outline">{value.enabled ? expired ? "已过期" : "已启用" : "未启用"}</Badge>
        {value.enabled && <><p>有效期至 {dateLabel(value.expiresAt!)}</p><p>每位用户最多 {value.maxPrincipalsPerUser} 个身份（包含旧身份），每位用户同时待处理上限 {value.maxPendingIntents}。</p><p className="break-words">线路：{value.allowedRouteIds?.map(route => choices.find(choice => choice.id === route)?.name || route).join("、")}</p><p className="break-words text-muted-foreground">涉及实例：{value.instanceIds?.join("、")}</p></>}
      </div>}
      <div className="flex flex-wrap gap-2"><ActionButton variant="outline" disabled={!value || query.isError || query.isFetching} onClick={begin}>编辑授权</ActionButton><ActionButton variant="ghost" pending={query.isFetching} onClick={() => query.refetch()}>重新读取</ActionButton></div>
    </>}
    {draft && <fieldset disabled={save.isPending} className="space-y-4">
      <Label className="flex items-start gap-2"><Checkbox checked={draft.enabled} onCheckedChange={enabled => { setDraft({...draft,enabled:enabled===true,acknowledge:false}); setError(""); }} />启用独立订阅授权</Label>
      {draft.enabled && <>
        <fieldset className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">允许的线路（最多 16 条）</legend>{routes.isError && <p role="alert">线路读取失败，暂不能启用。</p>}{!choices.length && <p className="text-sm text-muted-foreground">此路径暂无可选择的线路。</p>}{choices.map(route => <Label key={route.id} className="flex items-start gap-2"><Checkbox checked={draft.routes.includes(route.id)} onCheckedChange={checked => setDraft({...draft,routes:checked ? [...draft.routes,route.id] : draft.routes.filter(id=>id!==route.id),acknowledge:false})} /><span className="break-words">{route.name}</span></Label>)}</fieldset>
        <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-limit`}>每位用户的身份上限（含旧身份）</Label><Input id={`${id}-limit`} inputMode="numeric" value={draft.principals} onChange={e=>setDraft({...draft,principals:e.target.value,acknowledge:false})} /></div><div className="space-y-2"><Label htmlFor={`${id}-pending`}>每位用户同时待处理上限</Label><Input id={`${id}-pending`} inputMode="numeric" value={draft.pending} onChange={e=>setDraft({...draft,pending:e.target.value,acknowledge:false})} /></div></div>
        <div className="space-y-2"><Label htmlFor={`${id}-expiry`}>有效期至（本地时间，最多 30 天）</Label><Input id={`${id}-expiry`} type="datetime-local" value={draft.expiry} onChange={e=>setDraft({...draft,expiry:e.target.value,acknowledge:false})} /></div>
        <Label className="flex items-start gap-2"><Checkbox checked={draft.acknowledge} onCheckedChange={checked=>setDraft({...draft,acknowledge:checked===true})} /><span>我授权在上述范围和有效期内自动新增独立身份，并允许相关实例重载及可能的连接中断。</span></Label>
      </>}
      {!draft.enabled && <p className="text-sm text-muted-foreground">关闭后不再接受新的自助授权；不会删除现有独立身份。</p>}
      {error && <Notice tone="warning" role="alert">{error}</Notice>}
      <div className="flex flex-wrap gap-2"><ActionButton pending={save.isPending} disabled={save.isError || (draft.enabled && !draft.acknowledge)} onClick={submit}>{draft.enabled ? "保存授权" : "关闭授权"}</ActionButton><ActionButton variant="outline" disabled={save.isPending} onClick={()=>{setDraft(null);setError("");query.refetch();}}>取消并重新读取</ActionButton></div>
    </fieldset>}
  </div>;
}

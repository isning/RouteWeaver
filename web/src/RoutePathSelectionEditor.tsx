import { useContext, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { TaskSheet } from "@/ui-patterns/task-overlays";
import { APIError, post, request } from "./api";
import { ErrorNotice } from "./components";
import { loadInfrastructure } from "./infrastructure-data";
import { useUnsavedChanges } from "./navigation";
import { invalidateOutputInputs } from "./output-comparison";
import { publicRouteFields, reviewedPublicRoute } from "./PublicRouteEditComparison";
import type { PublishedRoute } from "./PublishedRoutes";
import { readOrderedServerPath } from "./server-path-model";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import type { Infrastructure } from "./types";
import { useDiscardConfirmation } from "./useDiscardConfirmation";
import { WORKSPACE_NAVIGATION_EVENT } from "./workspace-history";

type PublishedRouteHop = NonNullable<PublishedRoute["hops"]>[number];
type Candidate = ReturnType<typeof publicRouteFields>;
type PathSummary = { hops: {kind?: "managed" | "connector"; endpointId?: string; connectorId?: string; programEndpointId?: string; name?: string; metadataState: "snapshot" | "unavailable"}[] };
type Review = { before: PathSummary; after: PathSummary; routeId: string; reviewToken: string; revisionToken: string; status: "reviewed" | "draft-saved"; candidate: Candidate };
type Input = { expectedRouteRevision: string; hops: PublishedRouteHop[] };
const routeHops = (route: Candidate): PublishedRouteHop[] => route.hops?.length ? route.hops : route.endpointIds.map(endpointId => ({ kind: "managed", endpointId }));
const same = (a: Candidate, b: Candidate) => JSON.stringify(publicRouteFields(a)) === JSON.stringify(publicRouteFields(b));
function candidateFrom(route: PublishedRoute, inventory: Infrastructure): Candidate {
  const reviewed = reviewedPublicRoute(route, route.id);
  if (!reviewed) throw new Error("线路信息不完整，请重新读取。");
  const deployment = inventory.deployments.find(item => item.id === route.deploymentId);
  if (!deployment) throw new Error("转发路径已不存在。");
  const ordered = readOrderedServerPath(deployment, inventory);
  if (!ordered.editable) throw new Error(ordered.reason);
  if (ordered.hops[0]?.kind !== "managed" || ordered.hops[0].endpointId !== route.endpointIds[0])
    throw new Error("入口已变化，不能在这里更新路径。");
  const hops = ordered.hops.map(hop => hop.kind === "managed" ? { kind: "managed" as const, endpointId: hop.endpointId } : { kind: "connector" as const, connectorId: hop.connectorId });
  if (JSON.stringify(hops) === JSON.stringify(routeHops(reviewed))) throw new Error("线路已使用当前完整路径，无需更新。");
  return publicRouteFields({ ...reviewed, hops, endpointIds: hops.flatMap(hop => hop.kind === "managed" ? [hop.endpointId] : []) });
}
function confirmed(value: Review, expected: Candidate, status: Review["status"]): boolean {
  return value?.routeId === expected.id && value.status === status && typeof value.reviewToken === "string" && !!value.reviewToken &&
    typeof value.revisionToken === "string" && !!value.revisionToken &&
    !!reviewedPublicRoute({ ...value.candidate, revisionToken: value.revisionToken }, expected.id) && same(value.candidate, expected);
}
function matchesSummary(summary: PathSummary, value: Candidate): boolean {
  const expected = routeHops(value);
  if (!summary || !Array.isArray(summary.hops) || summary.hops.length !== expected.length) return false;
  let owner = "";
  return summary.hops.every((hop, index) => {
    if (!hop || !["snapshot", "unavailable"].includes(hop.metadataState) || (hop.name !== undefined && typeof hop.name !== "string")) return false;
    const target = expected[index];
    if (target.kind === "managed") {
      owner = target.endpointId!;
      return (!hop.kind || hop.kind === "managed") && hop.endpointId === owner && !hop.connectorId && !hop.programEndpointId;
    }
    return hop.kind === "connector" && hop.connectorId === target.connectorId && hop.programEndpointId === owner && !hop.endpointId;
  });
}
function PathList({ title, value, summary }: { title: string; value: Candidate; summary?: PathSummary }) {
  return <section className="min-w-0 space-y-2"><h3 className="text-sm font-medium">{title}</h3><ol className="list-decimal space-y-2 pl-5 text-sm [overflow-wrap:anywhere]">{routeHops(value).map((hop, index) => {
    const info = summary?.hops[index];
    const identity = hop.kind === "managed" ? hop.endpointId : hop.connectorId;
    return <li key={index}><span>{hop.kind === "managed" ? "服务器入口" : "外部代理"} {info?.metadataState === "snapshot" && info.name ? info.name : identity}</span>{info?.name && info.name !== identity && <span className="ml-2 text-muted-foreground">{identity}</span>}</li>;
  })}</ol></section>;
}
/** Adopts only the current deployment's proven path. It never edits server IR. */
export function RoutePathSelectionEditor({ route, returnFocus, onClose, onSaved }: {
  route: PublishedRoute; returnFocus: HTMLElement | null; onClose(): void; onSaved(): void;
}) {
  const client = useQueryClient();
  const workspace = useContext(WorkspaceHistoryContext);
  const mounted = useRef(true), sequence = useRef(0), running = useRef(false);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [review, setReview] = useState<{ input: Input; result: Review; before: Candidate; candidate: Candidate }>();
  const [uncertain, setUncertain] = useState<Candidate>();
  const { confirm, confirming } = useDiscardConfirmation(`path:${route.id}`);
  const invalidate = () => { sequence.current++; setReview(undefined); };
  useUnsavedChanges(!!review || !!uncertain, uncertain ? "路径保存结果尚未确认，离开不会撤销已经提交的保存。" : undefined, invalidate);
  useLayoutEffect(() => {
    mounted.current = true;
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, invalidate);
    window.addEventListener("hashchange", invalidate);
    return () => { mounted.current = false; sequence.current++; window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, invalidate); window.removeEventListener("hashchange", invalidate); };
  }, []);
  const own = () => {
    const seq = ++sequence.current, hash = location.hash, owner = workspace?.current, lease = owner?.bindView(hash);
    return () => mounted.current && sequence.current === seq && location.hash === hash && (!workspace || (workspace.current === owner && !!lease?.(hash)));
  };
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["published-routes"] });
    client.invalidateQueries({ queryKey: ["published-route-resolve", route.id] });
    invalidateOutputInputs(client);
  };
  const inspect = async () => {
    if (running.current || uncertain) return;
    running.current = true; setBusy(true); setError(null); setReview(undefined);
    const current = own();
    try {
      const [latest, inventory] = await Promise.all([request<PublishedRoute>(`/published-routes/${encodeURIComponent(route.id)}/resolve`), loadInfrastructure()]);
      if (!current()) return;
      if (latest.id !== route.id || latest.deploymentId !== route.deploymentId || latest.endpointIds[0] !== route.endpointIds[0]) throw new Error("线路所属路径或入口已变化，请关闭后重新打开。");
      const candidate = candidateFrom(latest, inventory);
      const input = { expectedRouteRevision: latest.revisionToken!, hops: routeHops(candidate) };
      const result = await post<Review>(`/published-routes/${encodeURIComponent(route.id)}/path-selection/preview`, input);
      if (!current()) return;
      if (!confirmed(result, candidate, "reviewed") || result.revisionToken !== input.expectedRouteRevision || !matchesSummary(result.before, latest) || !matchesSummary(result.after, candidate)) throw new Error("无法确认路径检查结果，请重新检查。");
      setReview({ input, result, before: publicRouteFields(latest), candidate });
    } catch (e) { if (current()) setError(e as Error); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const save = async () => {
    if (running.current || !review || uncertain) return;
    const checked = review, current = own();
    running.current = true; setBusy(true); setError(null);
    // Until a recognized refusal or complete success is received, never replay.
    setUncertain(checked.candidate); setReview(undefined); refresh();
    try {
      const result = await post<Review>(`/published-routes/${encodeURIComponent(route.id)}/path-selection`, { ...checked.input, reviewToken: checked.result.reviewToken });
      if (!current()) return;
      if (!confirmed(result, checked.candidate, "draft-saved") || result.revisionToken === checked.input.expectedRouteRevision || !matchesSummary(result.before, checked.before) || !matchesSummary(result.after, checked.candidate)) throw new Error("无法确认返回的路径身份，请核对保存结果。");
      setUncertain(undefined); refresh(); onSaved(); setOpen(false);
    } catch (e) {
      if (!current()) return;
      // A generic 422 can wrap an indeterminate store commit. Only structured,
      // known pre-commit refusals permit a fresh mutation; otherwise read back.
      if (e instanceof APIError && e.details !== null && typeof e.details === "object" && !Array.isArray(e.details)) {
        const code = (e.details as { code?: unknown }).code;
        if ([400, 401, 403, 409].includes(e.status) || (e.status === 422 &&
          typeof code === "string" && ["PATH_SELECTION_UNSUPPORTED", "PATH_SELECTION_PRINCIPAL_CHANGED", "PATH_SELECTION_UNCHANGED"].includes(code))) setUncertain(undefined);
      }
      setError(e as Error);
    } finally { running.current = false; if (mounted.current) setBusy(false); refresh(); }
  };
  const recover = async () => {
    if (running.current || !uncertain) return;
    const expected = uncertain, current = own();
    running.current = true; setBusy(true); setError(null);
    try {
      const value = await request<PublishedRoute>(`/published-routes/${encodeURIComponent(route.id)}/resolve`);
      if (!current()) return;
      if (!reviewedPublicRoute(value, route.id)) throw new Error("无法核对当前线路，请稍后重试。");
      setUncertain(undefined); refresh();
      if (same(value, expected)) { onSaved(); setOpen(false); }
      else setError(new Error("当前线路与提交的路径不同，请重新检查后再决定是否更新。"));
    } catch (e) { if (current()) setError(e as Error); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const close = () => {
    if (running.current || confirming) return;
    if (!review && !uncertain) { setOpen(false); return; }
    const current = own();
    confirm({ title: uncertain ? "离开尚未确认的保存？" : "放弃本次路径检查？", description: uncertain ? "离开不会撤销已经提交的保存。再次更新前请核对线路。" : "之后更新仍需重新检查完整路径。", confirmLabel: "离开" }, () => { if (current()) setOpen(false); });
  };
  return <TaskSheet title="更新完整路径" description={route.name} open={open} onOpenChange={next => { if (!next) close(); }} onClosed={onClose} returnFocus={returnFocus} pending={busy || confirming} size="lg" bodyProps={{ className: "space-y-5" }} footer={<><ActionButton variant="outline" disabled={busy || confirming} onClick={close}>取消</ActionButton><ActionButton variant="default" pending={busy} disabled={confirming} onClick={uncertain ? recover : review ? save : inspect}>{uncertain ? "核对保存结果" : review ? "保存路径更新" : "检查完整路径"}</ActionButton></>}>
    <ErrorNotice error={error} />
    <p className="text-sm text-muted-foreground">采用当前转发路径中已保存的完整链路；名称、对外地址和入口保持不变。</p>
    {uncertain && <Notice tone="warning" title="保存结果尚未确认">先核对当前线路，不会再次提交保存。</Notice>}
    <PathList title="当前线路" value={review?.before || route} summary={review?.result.before} />
    {review && <><PathList title="待采用的完整路径" value={review.candidate} summary={review.result.after} /><Notice title="路径检查完成">保存仅更新线路草稿，不会修改或应用服务器配置。</Notice></>}
  </TaskSheet>;
}

import { useId, useRef, useState } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ActionButton } from "@/ui-patterns/actions";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import type { Infrastructure } from "./types";
import type { PublishedRoute } from "./PublishedRoutes";

// Only editable public identity fields enter the review. Resolution metadata,
// runtime observations and any unrelated response fields are not draft input.
export function publicRouteFields(route: Pick<PublishedRoute, "id" | "name" | "deploymentId" | "endpointIds" | "publicHost" | "publicPort" | "hops">) {
  return {
    id: route.id,
    name: route.name,
    deploymentId: route.deploymentId,
    endpointIds: [...route.endpointIds],
    ...(Array.isArray(route.hops) && route.hops.some(hop => hop?.kind === "connector") ? { hops: route.hops.map(hop => ({...hop})) } : {}),
    publicHost: route.publicHost,
    publicPort: route.publicPort,
  };
}
export type PublicRouteFields = ReturnType<typeof publicRouteFields>;
export type ReviewedPublicRoute = PublicRouteFields & { revisionToken: string };

export function reviewedPublicRoute(value: unknown, id: string): ReviewedPublicRoute | undefined {
  if (!value || typeof value !== "object") return;
  const route = value as Partial<PublishedRoute>;
  if (route.id !== id || typeof route.revisionToken !== "string" || !route.revisionToken.trim() ||
    typeof route.name !== "string" || typeof route.deploymentId !== "string" || !route.deploymentId ||
    !Array.isArray(route.endpointIds) || !route.endpointIds.length || !route.endpointIds.every(id => typeof id === "string" && !!id) ||
    typeof route.publicHost !== "string" || typeof route.publicPort !== "number" ||
    !Number.isInteger(route.publicPort) || route.publicPort < 1 || route.publicPort > 65535) return;
  // The API emits null when no explicit hops are stored; an empty list uses
  // endpointIds in the backend. Only nonempty explicit paths need projection.
  if (route.hops != null && (!Array.isArray(route.hops) || route.hops.length)) {
    if (!Array.isArray(route.hops) || !route.hops.every(hop => hop &&
      (hop.kind === "managed" ? typeof hop.endpointId === "string" && !!hop.endpointId && Object.keys(hop).every(key => key === "kind" || key === "endpointId") :
       hop.kind === "connector" && typeof hop.connectorId === "string" && !!hop.connectorId && Object.keys(hop).every(key => key === "kind" || key === "connectorId")))) return;
    if (JSON.stringify(route.hops.filter(hop => hop.kind === "managed").map(hop => hop.endpointId)) !== JSON.stringify(route.endpointIds)) return;
  }
  return { ...publicRouteFields(route as PublishedRoute), revisionToken: route.revisionToken };
}

export function PublicRouteEditComparison({ current, publicPort, latest, inventory, returnFocus, continueFocus, onCancel, onContinue }: {
  current: PublicRouteFields;
  publicPort: number | string;
  latest: ReviewedPublicRoute;
  inventory: Infrastructure;
  returnFocus: HTMLElement | null;
  continueFocus: HTMLElement | null;
  onCancel(): void;
  onContinue(selected: PublicRouteFields, port: number | string): void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(true);
  const continuing = useRef(false);
  const lockedPath = !!current.hops?.some(hop => hop.kind === "connector") || !!latest.hops?.some(hop => hop.kind === "connector");
  const path = (route: PublicRouteFields) => {
    const deployment = inventory.deployments.find(item => item.id === route.deploymentId);
    return <div className="space-y-2 break-words [overflow-wrap:anywhere]">
      <p>{deployment?.name || route.deploymentId}</p>
      {deployment?.name && <p className="text-sm text-muted-foreground">{route.deploymentId}</p>}
      <ol className="list-decimal space-y-2 pl-5">
        {(route.hops || route.endpointIds.map(endpointId => ({kind: "managed" as const, endpointId}))).map((hop, index) => {
          if (hop.kind === "connector") return <li key={`${index}:connector`}>外部代理 {hop.connectorId}</li>;
          const endpointId = hop.endpointId;
          const endpoint = deployment?.ir.programs.find(program => program.listener.id === endpointId)?.listener;
          return <li key={`${index}:${endpointId}`}>
            {endpoint?.name || endpointId}
            {endpoint?.name && endpoint.name !== endpointId && <span className="block text-sm text-muted-foreground">{endpointId}</span>}
          </li>;
        })}
      </ol>
    </div>;
  };
  const groups = [
    { key: "name", label: "线路名称", differs: current.name !== latest.name, current: current.name || "未填写", latest: latest.name || "未填写" },
    { key: "path", label: "转发路径与顺序", differs: current.deploymentId !== latest.deploymentId || JSON.stringify(current.endpointIds) !== JSON.stringify(latest.endpointIds) || JSON.stringify(current.hops) !== JSON.stringify(latest.hops), current: path(current), latest: path(latest) },
    { key: "address", label: "对外地址与端口", differs: current.publicHost !== latest.publicHost || String(publicPort) !== String(latest.publicPort), current: <><p>{current.publicHost || "地址未填写"}</p><p>端口：{String(publicPort) || "未填写"}</p></>, latest: <><p>{latest.publicHost}</p><p>端口：{latest.publicPort}</p></> },
  ].filter(group => group.differs);
  const complete = groups.every(group => (lockedPath && group.key === "path") || choices[group.key]);
  return <TaskDialog
    title="比较公开线路修改"
    description="逐项选择要保留的内容。继续编辑不会保存，仍需重新检查后明确保存。"
    open={open}
    onOpenChange={next => { if (!next) setOpen(false); }}
    onClosed={onCancel}
    returnFocus={returnFocus}
    onCloseAutoFocus={event => {
      if (continuing.current) {
        event.preventDefault();
        queueMicrotask(() => { if (continueFocus?.isConnected) continueFocus.focus({ preventScroll: true }); });
      }
    }}
    size="lg"
    footer={<>
      <ActionButton variant="outline" onClick={() => setOpen(false)}>取消比较</ActionButton>
      <ActionButton variant="default" disabled={!complete} onKeyDown={event => { if (event.repeat) event.preventDefault(); }} onClick={event => {
        if (!complete || event.detail > 1) return;
        continuing.current = true;
        onContinue({
          ...current,
          ...(choices.name === "latest" ? { name: latest.name } : {}),
          ...((lockedPath || choices.path === "latest") ? { deploymentId: latest.deploymentId, endpointIds: [...latest.endpointIds], hops: latest.hops?.map(hop => ({...hop})) } : {}),
          ...(choices.address === "latest" ? { publicHost: latest.publicHost, publicPort: latest.publicPort } : {}),
        }, choices.address === "latest" ? latest.publicPort : publicPort);
      }}>使用所选内容继续编辑</ActionButton>
    </>}
  >
    <div className="space-y-5">
      {!groups.length && <p>最新版本与当前输入相同。继续编辑后仍需重新检查。</p>}
      {groups.map(group => lockedPath && group.key === "path" ? <section key="path" className="space-y-3"><h3 className="font-semibold">转发路径已更新</h3><p className="text-sm text-muted-foreground">继续编辑将保留以下最新完整路径；此处仅修改名称和对外地址。</p>{group.latest}</section> : <fieldset key={group.key} className="min-w-0 space-y-3">
        <legend className="text-base font-semibold">{group.label}</legend>
        <RadioGroup aria-label={group.label} value={choices[group.key] || ""} onValueChange={value => setChoices(current => ({ ...current, [group.key]: value }))} className="grid gap-3 sm:grid-cols-2">
          {(["current", "latest"] as const).map(choice => <div key={choice} className="min-w-0 rounded-lg border p-3 space-y-3">
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-${group.key}-${choice}`} value={choice} aria-label={choice === "current" ? "保留当前输入" : "使用最新版本"} />
              <label htmlFor={`${id}-${group.key}-${choice}`} className="text-sm font-medium">{choice === "current" ? "保留当前输入" : "使用最新版本"}</label>
            </div>
            <div className="space-y-2 text-sm break-words [overflow-wrap:anywhere]">{group[choice]}</div>
          </div>)}
        </RadioGroup>
      </fieldset>)}
    </div>
  </TaskDialog>;
}

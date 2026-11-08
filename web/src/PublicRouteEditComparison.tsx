import { useId, useRef, useState } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ActionButton } from "@/ui-patterns/actions";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import type { Infrastructure } from "./types";
import type { PublishedRoute } from "./PublishedRoutes";

// Only editable public identity fields enter the review. Resolution metadata,
// runtime observations and any unrelated response fields are not draft input.
export function publicRouteFields(route: Pick<PublishedRoute, "id" | "name" | "deploymentId" | "endpointIds" | "publicHost" | "publicPort">) {
  return {
    id: route.id,
    name: route.name,
    deploymentId: route.deploymentId,
    endpointIds: [...route.endpointIds],
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
  const path = (route: PublicRouteFields) => {
    const deployment = inventory.deployments.find(item => item.id === route.deploymentId);
    return <div className="space-y-2 break-words [overflow-wrap:anywhere]">
      <p>{deployment?.name || route.deploymentId}</p>
      {deployment?.name && <p className="text-sm text-muted-foreground">{route.deploymentId}</p>}
      <ol className="list-decimal space-y-2 pl-5">
        {route.endpointIds.map((endpointId, index) => {
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
    { key: "path", label: "转发路径与顺序", differs: current.deploymentId !== latest.deploymentId || JSON.stringify(current.endpointIds) !== JSON.stringify(latest.endpointIds), current: path(current), latest: path(latest) },
    { key: "address", label: "对外地址与端口", differs: current.publicHost !== latest.publicHost || String(publicPort) !== String(latest.publicPort), current: <><p>{current.publicHost || "地址未填写"}</p><p>端口：{String(publicPort) || "未填写"}</p></>, latest: <><p>{latest.publicHost}</p><p>端口：{latest.publicPort}</p></> },
  ].filter(group => group.differs);
  const complete = groups.every(group => choices[group.key]);
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
          ...(choices.path === "latest" ? { deploymentId: latest.deploymentId, endpointIds: [...latest.endpointIds] } : {}),
          ...(choices.address === "latest" ? { publicHost: latest.publicHost, publicPort: latest.publicPort } : {}),
        }, choices.address === "latest" ? latest.publicPort : publicPort);
      }}>使用所选内容继续编辑</ActionButton>
    </>}
  >
    <div className="space-y-5">
      {!groups.length && <p>最新版本与当前输入相同。继续编辑后仍需重新检查。</p>}
      {groups.map(group => <fieldset key={group.key} className="min-w-0 space-y-3">
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

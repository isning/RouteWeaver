import { ActionButton } from "@/ui-patterns/actions";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "./model";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import type { Infrastructure, ServerProgram } from "./types";

/** Presentation for a chain already proven editable by canEditLegacyPath.
 * All rewrites still go through the owner's reveal/revision/compilePath guard.
 */
export function ServerPathWorkspace({
  programs,
  inventory,
  onChangePath,
  onPendingChange,
  changing = false,
}: {
  programs: ServerProgram[];
  inventory: Infrastructure;
  onChangePath: (ids: string[]) => Promise<boolean>;
  onPendingChange: (key: string, pending: boolean) => void;
  changing?: boolean;
}) {
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const endpointControls = useRef(new Map<string, HTMLButtonElement>());
  const addControl = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const intermediatePicker = useRef<HTMLDivElement>(null);
  const addTask = useRef(0);
  const [addingIntermediate, setAddingIntermediate] = useState(false);
  const path = programs.map((program) => program.listener.id);
  const addKey = `add-${path.join("/")}`;
  const pendingFocus = useRef<{
    path: string[];
    endpointId?: string;
    trigger: HTMLElement;
    popup: HTMLElement | null;
    dialog: Element | null;
  } | null>(null);

  useLayoutEffect(() => {
    if (addingIntermediate && document.activeElement === addButton.current)
      intermediatePicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [addingIntermediate]);

  useLayoutEffect(() => {
    const owner = pendingFocus.current;
    if (!owner || owner.path.join("/") !== path.join("/")) return;
    pendingFocus.current = null;
    const target = owner.endpointId
      ? endpointControls.current.get(owner.endpointId)
      : workspace.current?.querySelector<HTMLButtonElement>('[aria-label="入口服务器"]');
    const active = document.activeElement;
    // A completed selection can replace or move a control. Return only focus
    // still owned by that operation, never focus from a newer field or task.
    if (target?.isConnected && !target.disabled &&
      !target.closest("[hidden],[inert],[aria-hidden='true']") &&
      (active === owner.trigger || active === owner.dialog || active === document.body ||
        (active && owner.popup?.contains(active)))) target.focus();
  }, [programs, path]);

  const changePath = async (
    ids: string[],
    trigger: HTMLElement | null,
    endpointId?: string,
  ) => {
    const popupId = trigger?.getAttribute("aria-controls");
    const popup = popupId ? document.getElementById(popupId) : null;
    const active = document.activeElement;
    const owner = trigger && (active === trigger || (active && popup?.contains(active)))
      ? { path: ids, endpointId, trigger, popup, dialog: trigger.closest('[role="dialog"]') }
      : null;
    pendingFocus.current = owner;
    const task = addTask.current;
    const changed = await onChangePath(ids);
    if (!changed && pendingFocus.current === owner) pendingFocus.current = null;
    if (changed && task === addTask.current) setAddingIntermediate(false);
  };
  const hostName = (program: ServerProgram) =>
    inventory.hosts.find((host) => host.id === program.instance.hostId)?.name || "服务器不可用";
  const unusedIds = inventory.endpoints.filter((endpoint) =>
    !programs.some((program) => program.instance.id === endpoint.instanceId),
  ).map((endpoint) => endpoint.id);
  const unavailableReason = "不可选端点的核心已在路径中使用；请选择其他核心的端点。";

  const row = (program: ServerProgram, index: number) => (
    <div key={program.listener.id} className="hop-row min-w-0 space-y-3">
      <ServerEndpointSelect
        inventory={inventory}
        endpointRef={(control) => {
          if (control) endpointControls.current.set(program.listener.id, control);
          else endpointControls.current.delete(program.listener.id);
        }}
        label={`第 ${index + 1} 跳`}
        unavailableReason={unavailableReason}
        value={program.listener.id}
        current={{ endpoint: program.listener, hostId: program.instance.hostId }}
        displayCurrentSnapshot
        allowedIds={inventory.endpoints.filter((endpoint) =>
          endpoint.id === program.listener.id || !programs.some((other, otherIndex) =>
            otherIndex !== index && other.instance.id === endpoint.instanceId),
        ).map((endpoint) => endpoint.id)}
        onPendingChange={(pending) => onPendingChange(program.listener.id, pending)}
        onChange={(endpointId) => void changePath(
          path.map((value, otherIndex) => otherIndex === index ? endpointId : value),
          endpointControls.current.get(program.listener.id) || null,
          endpointId,
        )}
      />
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          顺序与移除
        </summary>
        <div className="mt-3 space-y-2">
          {path.length > 1 && (
            <p className="text-xs text-muted-foreground">入口和最终出口由顺序决定。</p>
          )}
          <div className="flex flex-wrap gap-2" role="group" aria-label={`第 ${index + 1} 跳顺序操作`}>
            <ActionButton aria-label={`上移第 ${index + 1} 跳`} leadingIcon={<ArrowUp aria-hidden="true" />}
              disabled={index === 0} variant="outline"
              onClick={(event) => void changePath(moveItem(path, index, index - 1), event.currentTarget, program.listener.id)}>
              上移
            </ActionButton>
            <ActionButton aria-label={`下移第 ${index + 1} 跳`} leadingIcon={<ArrowDown aria-hidden="true" />}
              disabled={index === path.length - 1} variant="outline"
              onClick={(event) => void changePath(moveItem(path, index, index + 1), event.currentTarget, program.listener.id)}>
              下移
            </ActionButton>
            <ActionButton aria-label={`移除第 ${index + 1} 跳`} leadingIcon={<Trash2 aria-hidden="true" />} variant="ghost"
              onClick={(event) => void changePath(path.filter((_, otherIndex) => otherIndex !== index), event.currentTarget, path[index + 1] || path[index - 1])}>
              移除
            </ActionButton>
          </div>
          {index === path.length - 1 && path.length > 1 ? (
            <p className="text-xs text-muted-foreground">移除后，从 {hostName(programs[index - 1])} 直接访问目标。</p>
          ) : index === 0 ? (
            <p className="text-xs text-muted-foreground">
              {programs[1] ? `移除后，${programs[1].listener.name} 成为入口。` : "移除后，需要重新选择入口。"}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );

  const entry = programs[0];
  const exit = programs.at(-1);
  return (
    <div ref={workspace} className="ordered-path min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <ServerPathSummary programs={programs} />
      <section aria-labelledby={`${id}-entry`} className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
        <h3 id={`${id}-entry`} className="text-base font-semibold">入口</h3>
        <p className="text-sm text-muted-foreground">客户端首先连接哪台服务器？</p>
        {entry ? row(entry, 0) : (
          <ServerEndpointSelect
            inventory={inventory} endpointRef={addControl} label="入口"
            allowedIds={unusedIds} unavailableReason={unavailableReason}
            onPendingChange={(pending) => onPendingChange(addKey, pending)}
            onChange={(endpointId) => void changePath([endpointId], addControl.current, endpointId)}
          />
        )}
        {!inventory.endpoints.length && <p className="text-sm text-muted-foreground">先在「服务器」中配置监听端点，再编排路径。</p>}
      </section>

      <section aria-labelledby={`${id}-exit`} className="space-y-3 rounded-xl border bg-muted/20 p-4 sm:p-5">
        <h3 id={`${id}-exit`} className="text-base font-semibold">最终出口</h3>
        <p className="text-sm text-muted-foreground">由哪台服务器访问目标网站？</p>
        {!exit ? <p className="text-sm text-muted-foreground">选择入口后，默认从入口服务器直接访问目标。</p>
          : programs.length === 1 ? (
            <>
              <div className="space-y-1">
                <p className="font-medium">{hostName(exit)}</p>
                <p className="text-sm text-muted-foreground">从入口服务器直接访问目标</p>
              </div>
              <div className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">使用独立出口（可选）</p>
                <ServerEndpointSelect
                  key={addKey} inventory={inventory} endpointRef={addControl} label="下一跳"
                  allowedIds={unusedIds} unavailableReason={unavailableReason}
                  onPendingChange={(pending) => onPendingChange(addKey, pending)}
                  onChange={(endpointId) => void changePath([...path, endpointId], addControl.current, endpointId)}
                />
              </div>
            </>
          ) : <>{row(exit, programs.length - 1)}<p className="text-sm text-muted-foreground">从此服务器直接访问目标</p></>}
      </section>
      {programs.length > 1 && (
        <section aria-labelledby={`${id}-middle`} className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${id}-middle`} className="text-base font-semibold">中转</h3>
            <span className="text-xs text-muted-foreground">可选</span>
          </div>
          {programs.length > 2 ? (
            <ol className="space-y-4">
              {programs.slice(1, -1).map((program, index) => (
                <li key={program.listener.id} className="space-y-2 border-b pb-4 last:border-0 last:pb-0">
                  <h4 className="text-sm font-medium">中转 {index + 1}</h4>
                  {row(program, index + 1)}
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-muted-foreground">不经过中转</p>}
          {programs.length > 1 && (
            <ActionButton ref={addButton} variant="outline" leadingIcon={<Plus aria-hidden="true" />}
              aria-expanded={addingIntermediate} aria-controls={`${id}-add-middle`}
              onClick={() => {
                addTask.current++;
                setAddingIntermediate(true);
              }}>添加中转</ActionButton>
          )}
          {programs.length > 1 && addingIntermediate && (
            <div ref={intermediatePicker} id={`${id}-add-middle`} className="space-y-3 rounded-lg border border-dashed p-3">
              <ServerEndpointSelect
                key={addKey} inventory={inventory} endpointRef={addControl} label="中转"
                allowedIds={unusedIds} unavailableReason={unavailableReason}
                onPendingChange={(pending) => onPendingChange(addKey, pending)}
                onChange={(endpointId) => void changePath([...path.slice(0, -1), endpointId, path[path.length - 1]], addControl.current, endpointId)}
              />
              <ActionButton variant="ghost" disabled={changing} onClick={() => {
                addTask.current++;
                onPendingChange(addKey, false);
                setAddingIntermediate(false);
                addButton.current?.focus();
              }}>取消添加中转</ActionButton>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function ServerPathSummary({ programs }: { programs: ServerProgram[] }) {
  return (
    <section aria-label="路径摘要" className="space-y-1 rounded-lg bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]">
      <h3 className="font-medium">路径摘要</h3>
      <p className="text-muted-foreground">
        {programs.length ? `客户端 → ${programs.map((program) => program.listener.name).join(" → ")} → 目标` : "客户端 → 选择入口服务器 → 目标"}
      </p>
    </section>
  );
}


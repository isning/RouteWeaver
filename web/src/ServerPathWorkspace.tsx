import { ActionButton } from "@/ui-patterns/actions";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "./model";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import type { Infrastructure, ServerProgram } from "./types";

/** Presentation for a chain already proven editable by canEditLegacyPath.
 * All rewrites still go through the owner's reveal/revision/compilePath guard.
 * Hierarchy: ordered listeners first; append and per-hop actions second.
 * Save remains the owner's primary action. Use existing shadcn semantic tokens.
 */
export function ServerPathWorkspace({
  programs,
  inventory,
  onChangePath,
  onPendingChange,
  onSelectionChange,
  changing = false,
}: {
  programs: ServerProgram[];
  inventory: Infrastructure;
  onChangePath: (ids: string[]) => Promise<boolean>;
  onPendingChange: (key: string, pending: boolean) => void;
  onSelectionChange?: () => void;
  changing?: boolean;
}) {
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const endpointControls = useRef(new Map<string, HTMLButtonElement>());
  const addControl = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const addPicker = useRef<HTMLLIElement>(null);
  const addTask = useRef(0);
  const cancelledControl = useRef<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const path = programs.map((program) => program.listener.id);
  const addKey = `add-${path.join("/")}`;
  const pendingFocus = useRef<{
    path: string[];
    endpointId?: string;
    trigger: HTMLElement;
    popup: HTMLElement | null;
    dialog: Element | null;
  } | null>(null);

  const invalidateSelection = () => {
    addTask.current++;
    pendingFocus.current = null;
    onSelectionChange?.();
  };

  useLayoutEffect(() => {
    if (adding && document.activeElement === addButton.current)
      addPicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [adding]);

  useLayoutEffect(() => {
    // A parent may commit a new path before the append promise settles. Clear
    // the new add key when its temporary picker closes, not just the old key.
    if (path.length) onPendingChange(addKey, adding);
  }, [addKey, adding, onPendingChange, path.length]);

  useLayoutEffect(() => {
    const owner = cancelledControl.current;
    if (!owner || adding || changing) return;
    cancelledControl.current = null;
    if (document.activeElement === owner || document.activeElement === document.body)
      addButton.current?.focus();
  }, [adding, changing]);

  useLayoutEffect(() => {
    const owner = pendingFocus.current;
    if (!owner || owner.path.join("/") !== path.join("/")) return;
    pendingFocus.current = null;
    const target = owner.endpointId
      ? endpointControls.current.get(owner.endpointId)
      : workspace.current?.querySelector<HTMLButtonElement>('[aria-label="第 1 跳服务器"]');
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
    const task = ++addTask.current;
    const changed = await onChangePath(ids);
    if (!changed && pendingFocus.current === owner) pendingFocus.current = null;
    if (changed && task === addTask.current) setAdding(false);
  };
  const unusedIds = inventory.endpoints.filter((endpoint) =>
    !programs.some((program) => program.instance.id === endpoint.instanceId),
  ).map((endpoint) => endpoint.id);
  const unavailableReason = "不可选端点的核心已在路径中使用；请选择其他核心的端点。";

  return (
    <div ref={workspace} className="ordered-path min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <ServerPathSummary programs={programs} pendingHop={adding || (!path.length && changing) ? (changing ? "loading" : "selecting") : undefined} />
      {changing && <p role="status" className="text-sm text-muted-foreground">正在读取所选监听配置…</p>}
      <ol aria-label="代理链" className="space-y-3">
        {programs.map((program, index) => (
          <li key={program.listener.id} className="hop-row min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold">第 {index + 1} 跳</h3>
            <ServerEndpointSelect
              onSelectionChange={invalidateSelection}
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
            <div className="flex flex-wrap gap-2" role="group" aria-label={`第 ${index + 1} 跳顺序操作`}>
              <ActionButton aria-label={`上移第 ${index + 1} 跳`} leadingIcon={<ArrowUp aria-hidden="true" />}
                disabled={changing || index === 0} variant="ghost"
                onClick={(event) => void changePath(moveItem(path, index, index - 1), event.currentTarget, program.listener.id)}>
                上移
              </ActionButton>
              <ActionButton aria-label={`下移第 ${index + 1} 跳`} leadingIcon={<ArrowDown aria-hidden="true" />}
                disabled={changing || index === path.length - 1} variant="ghost"
                onClick={(event) => void changePath(moveItem(path, index, index + 1), event.currentTarget, program.listener.id)}>
                下移
              </ActionButton>
              <ActionButton aria-label={`移除第 ${index + 1} 跳`} leadingIcon={<Trash2 aria-hidden="true" />} variant="ghost"
                disabled={changing}
                onClick={(event) => void changePath(path.filter((_, otherIndex) => otherIndex !== index), event.currentTarget, path[index + 1] || path[index - 1])}>
                移除
              </ActionButton>
            </div>
          </li>
        ))}
        {(!path.length || adding) && (
          <li key={addKey} ref={addPicker} id={`${id}-add-hop`} className="min-w-0 space-y-3 rounded-xl border border-dashed p-4 sm:p-5">
            <h3 className="text-sm font-semibold">第 {path.length + 1} 跳</h3>
            <ServerEndpointSelect
              onSelectionChange={invalidateSelection}
              inventory={inventory} endpointRef={addControl} label={`第 ${path.length + 1} 跳`}
              allowedIds={unusedIds} unavailableReason={unavailableReason}
              onPendingChange={(pending) => onPendingChange(addKey, adding || pending)}
              onChange={(endpointId) => void changePath([...path, endpointId], addControl.current, endpointId)}
            />
            {adding && (
              <ActionButton variant="ghost" onClick={(event) => {
                cancelledControl.current = event.currentTarget;
                invalidateSelection();
                onPendingChange(addKey, false);
                setAdding(false);
              }}>取消添加</ActionButton>
            )}
            {!inventory.endpoints.length && <p className="text-sm text-muted-foreground">先在「服务器」中配置监听端点，再编排路径。</p>}
          </li>
        )}
      </ol>
      {!!path.length && (
        <ActionButton ref={addButton} variant="outline" leadingIcon={<Plus aria-hidden="true" />}
          aria-expanded={adding} aria-controls={`${id}-add-hop`} disabled={changing}
          onClick={() => {
            if (adding) {
              addPicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
              return;
            }
            invalidateSelection();
            onPendingChange(addKey, true);
            setAdding(true);
          }}>添加下一跳</ActionButton>
      )}
      <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
        <ArrowDown className="size-4" aria-hidden="true" />目标
      </p>
    </div>
  );
}

export function ServerPathSummary({ programs, pendingHop }: {
  programs: ServerProgram[];
  pendingHop?: "selecting" | "loading";
}) {
  const hops = programs.map((program) => program.listener.name);
  if (pendingHop) hops.push(`第 ${programs.length + 1} 跳（${pendingHop === "loading" ? "正在读取" : "待选择"}）`);
  return (
    <section aria-label="路径摘要" className="space-y-1 rounded-lg bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]">
      <h3 className="font-medium">路径摘要</h3>
      <p className="text-muted-foreground">客户端 → {hops.length ? hops.join(" → ") : "选择第一跳"} → 目标</p>
    </section>
  );
}

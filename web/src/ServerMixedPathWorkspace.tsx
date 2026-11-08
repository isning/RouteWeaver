import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "./model";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import { orderedServerHopKey, type OrderedServerHop, type ScopedConnectorChoice } from "./server-path-model";
import type { Infrastructure, ServerProgram } from "./types";

/** One traffic-order list. The model proves every replacement is lossless;
 * this view never infers ownership from an address or copies credentials. */
export function ServerMixedPathWorkspace({
  programs, inventory, hops, connectorChoices, onChangePath, changeReason,
  onPendingChange, onSelectionChange, onEditConnector, changing = false,
}: {
  programs: ServerProgram[];
  inventory: Infrastructure;
  hops: OrderedServerHop[];
  connectorChoices: ScopedConnectorChoice[];
  onChangePath: (hops: OrderedServerHop[]) => Promise<boolean>;
  changeReason: (hops: OrderedServerHop[]) => string | undefined;
  onPendingChange: (key: string, pending: boolean) => void;
  onSelectionChange: () => void;
  onEditConnector: (programEndpointId: string, connectorId: string, focusLabel: string) => void;
  changing?: boolean;
}) {
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const addButtons = useRef(new Map<number, HTMLButtonElement>());
  const addPicker = useRef<HTMLLIElement>(null);
  const addControl = useRef<HTMLButtonElement>(null);
  const sequence = useRef(0);
  const [adding, setAdding] = useState<{ index: number; kind: "managed" | "connector"; connectorId?: string } | null>(null);
  const addOrigin = useRef<HTMLButtonElement | null>(null);
  const cancelledControl = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<{
    path: string; key?: string; trigger: HTMLElement; popup: HTMLElement | null; dialog: Element | null;
  } | null>(null);
  const pathKey = hops.map(orderedServerHopKey).join("/");
  const invalidate = () => {
    sequence.current++;
    pendingFocus.current = null;
    onSelectionChange();
  };
  useLayoutEffect(() => {
    onPendingChange("ordered-add", !!adding);
  }, [adding, onPendingChange]);
  useLayoutEffect(() => {
    if (adding && document.activeElement === addOrigin.current)
      addPicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
  }, [adding]);
  useLayoutEffect(() => {
    const owner = cancelledControl.current;
    if (!owner || adding || changing) return;
    cancelledControl.current = null;
    if (document.activeElement === owner || document.activeElement === document.body)
      addOrigin.current?.focus();
  }, [adding, changing]);
  useLayoutEffect(() => {
    const owner = pendingFocus.current;
    if (!owner || owner.path !== pathKey) return;
    pendingFocus.current = null;
    const target = owner.key ? controls.current.get(owner.key)
      : workspace.current?.querySelector<HTMLButtonElement>('[aria-label="第 1 跳服务器"]');
    const active = document.activeElement;
    if (target?.isConnected && !target.disabled && !target.closest("[hidden],[inert],[aria-hidden='true']") &&
      (active === owner.trigger || active === owner.dialog || active === document.body ||
        (active && owner.popup?.contains(active)))) target.focus();
  }, [hops, pathKey]);
  const change = async (next: OrderedServerHop[], trigger: HTMLElement | null, focus?: OrderedServerHop) => {
    if (changeReason(next)) return;
    const popupId = trigger?.getAttribute("aria-controls");
    const popup = popupId ? document.getElementById(popupId) : null;
    const active = document.activeElement;
    const owner = trigger && (active === trigger || (active && popup?.contains(active)))
      ? { path: next.map(orderedServerHopKey).join("/"), key: focus && orderedServerHopKey(focus), trigger, popup, dialog: trigger.closest('[role="dialog"]') }
      : null;
    pendingFocus.current = owner;
    const request = ++sequence.current;
    const accepted = await onChangePath(next);
    if (!accepted && pendingFocus.current === owner) pendingFocus.current = null;
    if (accepted && request === sequence.current) setAdding(null);
  };
  const insert = (index: number, hop: OrderedServerHop) => [...hops.slice(0, index), hop, ...hops.slice(index)];
  const replace = (index: number, hop: OrderedServerHop) => hops.map((current, i) => i === index ? hop : current);
  const previousManaged = (index: number) => {
    for (let i = index - 1; i >= 0; i--) if (hops[i].kind === "managed") return (hops[i] as Extract<OrderedServerHop, { kind: "managed" }>).endpointId;
    return undefined;
  };
  const choicesAt = (index: number, replacing = false) => connectorChoices.filter((choice) =>
    choice.programEndpointId === previousManaged(index) && !hops.some((hop, i) =>
      (!replacing || i !== index) && hop.kind === "connector" && hop.programEndpointId === choice.programEndpointId && hop.connectorId === choice.connectorId));
  const connectorHop = (choice: ScopedConnectorChoice): OrderedServerHop => ({ kind: "connector", programEndpointId: choice.programEndpointId, connectorId: choice.connectorId });
  const name = (hop: OrderedServerHop) => hop.kind === "managed"
    ? programs.find((program) => program.listener.id === hop.endpointId)?.listener.name || hop.endpointId
    : connectorChoices.find((choice) => choice.programEndpointId === hop.programEndpointId && choice.connectorId === hop.connectorId)?.label || hop.connectorId;
  const summary = hops.map(name);
  if (adding) summary.splice(adding.index, 0, `第 ${adding.index + 1} 跳（${changing ? "正在读取" : "待选择"}）`);
  const openAdd = (index: number, trigger: HTMLButtonElement) => {
    if (adding?.index === index) {
      addPicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
      return;
    }
    invalidate();
    addOrigin.current = trigger;
    onPendingChange("ordered-add", true);
    setAdding({ index, kind: "managed" });
  };
  const picker = (index: number) => {
    if (hops.length && adding?.index !== index) return null;
    const choices = choicesAt(index);
    const kind = adding?.kind || "managed";
    return <li ref={addPicker} id={`${id}-add-hop`} className="min-w-0 space-y-3 rounded-xl border border-dashed p-4 sm:p-5">
      <h3 className="text-sm font-semibold">第 {index + 1} 跳</h3>
      {!!choices.length && <label className="grid gap-2 text-sm font-medium">类型
        <ChoiceSelect aria-label={`第 ${index + 1} 跳类型`} value={kind}
          options={[{ value: "managed", label: "服务器监听" }, { value: "connector", label: "外部代理" }]}
          onValueChange={(value) => {
            if (value !== "managed" && value !== "connector") return;
            invalidate();
            setAdding({ index, kind: value });
          }} />
      </label>}
      {kind === "managed" ? <ServerEndpointSelect key={`managed-${index}`} inventory={inventory}
        endpointRef={addControl} label={`第 ${index + 1} 跳`}
        onSelectionChange={invalidate}
        allowedIds={inventory.endpoints.filter((endpoint) => !changeReason(insert(index, { kind: "managed", endpointId: endpoint.id }))).map((endpoint) => endpoint.id)}
        unavailableReason="此端点不能插入当前位置；同一核心不能重复使用，外部代理也不能转移到另一核心。"
        onPendingChange={(pending) => onPendingChange("ordered-add", !!adding || pending)}
        onChange={(endpointId) => {
          const hop: OrderedServerHop = { kind: "managed", endpointId };
          void change(insert(index, hop), addControl.current, hop);
        }} /> : <label className="grid gap-2 text-sm font-medium">外部代理
        <ChoiceSelect ref={addControl} aria-label={`第 ${index + 1} 跳外部代理`} placeholder="选择外部代理" value={adding?.connectorId}
          options={choices.map((choice) => ({ value: choice.connectorId, label: choice.label,
            disabled: !!changeReason(insert(index, connectorHop(choice))) }))}
          onValueChange={(value) => {
            const choice = choices.find((item) => item.connectorId === value);
            if (!choice) return;
            invalidate();
            setAdding({ index, kind: "connector", connectorId: choice.connectorId });
            const hop = connectorHop(choice);
            void change(insert(index, hop), addControl.current, hop);
          }} />
      </label>}
      {kind === "connector" && <p className="text-sm text-muted-foreground">仅显示前一台服务器已配置的外部代理。</p>}
      {adding && <ActionButton variant="ghost" onClick={(event) => {
        cancelledControl.current = event.currentTarget;
        invalidate();
        onPendingChange("ordered-add", false);
        setAdding(null);
      }}>取消添加</ActionButton>}
    </li>;
  };
  return <div ref={workspace} className="ordered-path min-w-0 space-y-3 [overflow-wrap:anywhere]">
    <section aria-label="路径摘要" className="space-y-1 rounded-lg bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]">
      <h3 className="font-medium">路径摘要</h3>
      <p className="text-muted-foreground">客户端 → {summary.length ? summary.join(" → ") : "选择第一跳"} → 目标</p>
    </section>
    {changing && <p role="status" className="text-sm text-muted-foreground">正在读取所选监听配置…</p>}
    <ol aria-label="代理链" className="space-y-3">
      {!hops.length && picker(0)}
      {hops.map((hop, index) => {
        const key = orderedServerHopKey(hop);
        // An insertion is itself a numbered pending hop. Keep all following
        // controls uniquely labelled while that choice remains open.
        const hopNumber = index + 1 + (adding && adding.index <= index ? 1 : 0);
        const program = hop.kind === "managed" ? programs.find((item) => item.listener.id === hop.endpointId) : undefined;
        const up = moveItem(hops, index, index - 1);
        const down = moveItem(hops, index, index + 1);
        const removed = hops.filter((_, i) => i !== index);
        const upReason = index > 0 ? changeReason(up) : undefined;
        const downReason = index < hops.length - 1 ? changeReason(down) : undefined;
        const removeReason = changeReason(removed);
        const reasons = [...new Set([upReason, downReason, removeReason].filter(Boolean))];
        const reasonID = `${id}-hop-${index}-reason`;
        const editLabel = `编辑第 ${hopNumber} 跳外部代理连接参数`;
        return <Fragment key={key}>
          <li className="hop-row min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">第 {hopNumber} 跳</h3>
              <span className="text-sm text-muted-foreground">{hop.kind === "managed" ? "服务器监听" : "外部代理"}</span>
            </div>
            {hop.kind === "managed" && program ? <ServerEndpointSelect inventory={inventory}
              endpointRef={(control) => { if (control) controls.current.set(key, control); else controls.current.delete(key); }}
              value={hop.endpointId} label={`第 ${hopNumber} 跳`} displayCurrentSnapshot
              current={{ endpoint: program.listener, hostId: program.instance.hostId }}
              onSelectionChange={invalidate}
              allowedIds={inventory.endpoints.filter((endpoint) => !changeReason(replace(index, { kind: "managed", endpointId: endpoint.id }))).map((endpoint) => endpoint.id)}
              unavailableReason="此端点不能替换当前监听；请先移除关联的外部代理跳，且不要重复使用同一核心。"
              onPendingChange={(pending) => onPendingChange(hop.endpointId, pending)}
              onChange={(endpointId) => {
                const next: OrderedServerHop = { kind: "managed", endpointId };
                void change(replace(index, next), controls.current.get(key) || null, next);
              }} /> : hop.kind === "connector" ? <>
              <label className="grid gap-2 text-sm font-medium">外部代理
                <ChoiceSelect ref={(control) => { if (control) controls.current.set(key, control); else controls.current.delete(key); }}
                  aria-label={`第 ${hopNumber} 跳外部代理`} value={hop.connectorId} selectedLabel={name(hop)}
                  options={choicesAt(index, true).map((choice) => ({ value: choice.connectorId, label: choice.label,
                    disabled: !!changeReason(replace(index, connectorHop(choice))) }))}
                  onValueChange={(value) => {
                    const choice = choicesAt(index, true).find((item) => item.connectorId === value);
                    if (!choice) return;
                    invalidate();
                    const next = connectorHop(choice);
                    void change(replace(index, next), controls.current.get(key) || null, next);
                  }} />
              </label>
              <ActionButton variant="outline" aria-label={editLabel} disabled={changing || !!adding}
                leadingIcon={<Pencil aria-hidden="true" />} onClick={() => onEditConnector(hop.programEndpointId, hop.connectorId, editLabel)}>
                编辑连接参数
              </ActionButton>
            </> : null}
            <div className="flex flex-wrap gap-2" role="group" aria-label={`第 ${hopNumber} 跳顺序操作`}>
              <ActionButton variant="ghost" aria-label={`上移第 ${hopNumber} 跳`} leadingIcon={<ArrowUp aria-hidden="true" />}
                disabled={changing || index === 0 || !!upReason} aria-describedby={upReason ? reasonID : undefined}
                onClick={(event) => void change(up, event.currentTarget, hop)}>上移</ActionButton>
              <ActionButton variant="ghost" aria-label={`下移第 ${hopNumber} 跳`} leadingIcon={<ArrowDown aria-hidden="true" />}
                disabled={changing || index === hops.length - 1 || !!downReason} aria-describedby={downReason ? reasonID : undefined}
                onClick={(event) => void change(down, event.currentTarget, hop)}>下移</ActionButton>
              <ActionButton variant="ghost" aria-label={`移除第 ${hopNumber} 跳`} leadingIcon={<Trash2 aria-hidden="true" />}
                disabled={changing || !!removeReason} aria-describedby={removeReason ? reasonID : undefined}
                onClick={(event) => void change(removed, event.currentTarget, hops[index + 1] || hops[index - 1])}>移除</ActionButton>
              {index < hops.length - 1 && <ActionButton variant="ghost" aria-label={`在第 ${hopNumber} 跳后插入下一跳`}
                leadingIcon={<Plus aria-hidden="true" />} disabled={changing}
                ref={(button) => { if (button) addButtons.current.set(index + 1, button); else addButtons.current.delete(index + 1); }}
                aria-expanded={adding?.index === index + 1} aria-controls={adding?.index === index + 1 ? `${id}-add-hop` : undefined}
                onClick={(event) => openAdd(index + 1, event.currentTarget)}>插入下一跳</ActionButton>}
            </div>
            {!!reasons.length && <p id={reasonID} className="text-sm text-muted-foreground">{reasons.join(" ")}</p>}
          </li>
          {adding?.index === index + 1 && picker(index + 1)}
        </Fragment>;
      })}
    </ol>
    {!!hops.length && <ActionButton variant="outline" leadingIcon={<Plus aria-hidden="true" />}
      ref={(button) => { if (button) addButtons.current.set(hops.length, button); else addButtons.current.delete(hops.length); }}
      aria-expanded={adding?.index === hops.length} aria-controls={adding?.index === hops.length ? `${id}-add-hop` : undefined}
      disabled={changing} onClick={(event) => openAdd(hops.length, event.currentTarget)}>添加下一跳</ActionButton>}
    <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground"><ArrowDown className="size-4" aria-hidden="true" />目标</p>
  </div>;
}

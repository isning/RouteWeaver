import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, ChevronDown, Globe, Laptop, LockKeyhole, MoreHorizontal, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "./model";
import { ServerEndpointSelect } from "./ServerEndpointSelect";
import { connectorEditReason } from "./server-connector-editor";
import { connectorConnectionShapeReason } from "./server-connector-connection";
import { orderedServerHopKey, type OrderedServerHop, type ScopedConnectorChoice } from "./server-path-model";
import type { Infrastructure, ServerProgram } from "./types";

/** One traffic-order list. The model proves every replacement is lossless;
 * this view never infers ownership from an address or copies credentials. */
export function ServerMixedPathWorkspace({
  programs, inventory, schemaVersion, hops, connectorChoices, onChangePath, changeReason,
  onPendingChange, onSelectionChange, onEditConnector, changing = false, expandedHops, onExpandedHopsChange,
}: {
  programs: ServerProgram[];
  inventory: Infrastructure;
  schemaVersion: string;
  hops: OrderedServerHop[];
  connectorChoices: ScopedConnectorChoice[];
  onChangePath: (hops: OrderedServerHop[]) => Promise<boolean>;
  changeReason: (hops: OrderedServerHop[]) => string | undefined;
  onPendingChange: (key: string, pending: boolean) => void;
  onSelectionChange: () => void;
  onEditConnector: (programEndpointId: string, connectorId: string, focusLabel: string) => void;
  changing?: boolean;
  expandedHops?: ReadonlySet<string>;
  onExpandedHopsChange?: (keys: Set<string>) => void;
}) {
  const id = useId();
  const workspace = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const rowControls = useRef(new Map<string, HTMLButtonElement>());
  const menuControls = useRef(new Map<string, HTMLButtonElement>());
  const menuAction = useRef<"change" | "insert" | null>(null);
  const [localExpanded, setLocalExpanded] = useState(new Set<string>());
  const expanded = expandedHops ?? localExpanded;
  const [pendingRows, setPendingRows] = useState(new Set<string>());
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
  const currentPath = useRef(pathKey);
  currentPath.current = pathKey;
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
  const restorePendingFocus = () => {
    const owner = pendingFocus.current;
    if (!owner || owner.path !== currentPath.current) return;
    pendingFocus.current = null;
    const field = owner.key ? controls.current.get(owner.key) : undefined;
    const target = field && !field.closest("[hidden]") ? field
      : owner.key ? rowControls.current.get(owner.key) : workspace.current?.querySelector<HTMLButtonElement>('.hop-summary, [aria-label="第 1 跳服务器"]');
    const active = document.activeElement;
    if (target?.isConnected && !target.disabled && !target.closest("[hidden],[inert],[aria-hidden='true']") &&
      (active === owner.trigger || active === owner.dialog || active === document.body ||
        (active && owner.popup?.contains(active)))) target.focus();
  };
  useLayoutEffect(() => {
    if (menuAction.current !== "change") restorePendingFocus();
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
    return <li ref={addPicker} id={`${id}-add-hop`} className="relative ml-11 min-w-0 space-y-3 rounded-lg border border-dashed bg-background p-4">
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
  // §2.1 / §2.8: primary = route identity and order; secondary = configuration
  // on demand; tertiary = node menu. One primary Save stays in the sheet footer.
  // §3.6: neutral shadcn tokens, 4/8/12/16px rhythm, 44px targets. No new palette.
  return <div ref={workspace} className="ordered-path min-w-0 [overflow-wrap:anywhere]">
    <section aria-label="路径摘要" className="sr-only">
      <h3 className="font-medium">路径摘要</h3>
      <p className="text-muted-foreground">客户端 → {summary.length ? summary.join(" → ") : "选择第一跳"} → 目标</p>
    </section>
    {changing && <p role="status" className="text-sm text-muted-foreground">正在读取所选监听配置…</p>}
    <div className="flex items-center gap-3 pb-3 text-xs text-muted-foreground">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"><Laptop className="size-4" aria-hidden="true" /></span>
      客户端
    </div>
    <ol aria-label="代理链" className="relative space-y-3 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-border">
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
        const editLabel = `编辑第 ${hopNumber} 跳外部代理连接参数`;
        const connectorOwner = hop.kind === "connector" ? programs.find((program) => program.listener.id === hop.programEndpointId) : undefined;
        const editReason = hop.kind === "connector" && connectorOwner
          ? connectorEditReason(connectorOwner, schemaVersion, hop.connectorId) ||
            connectorConnectionShapeReason(connectorOwner.connectors?.find((connector) => connector.id === hop.connectorId)?.connection)
          : undefined;
        const isExpanded = expanded.has(key);
        const isPending = pendingRows.has(key);
        const host = program && inventory.hosts.find((item) => item.id === program.instance.hostId);
        const connector = hop.kind === "connector" ? connectorOwner?.connectors?.find((item) => item.id === hop.connectorId) : undefined;
        const connectorHost = connectorOwner && inventory.hosts.find((item) => item.id === connectorOwner.instance.hostId);
        return <Fragment key={key}>
          <li className="hop-row relative grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3">
            <span className="relative z-10 mt-5 flex size-8 items-center justify-center rounded-full border bg-background text-xs font-medium tabular-nums text-muted-foreground">
              <span className="sr-only">第 </span>{hopNumber}<span className="sr-only"> 跳</span>
            </span>
            <div className={cn("min-w-0 rounded-lg border bg-background", isExpanded && "ring-1 ring-border")}>
              <div className="flex min-w-0 items-center gap-1 pr-2">
                <button type="button" className="hop-summary group flex min-h-18 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring sm:px-4"
                  aria-label={`配置第 ${hopNumber} 跳 ${name(hop)}`} aria-describedby={`${id}-identity-${index}`} aria-expanded={isExpanded} aria-controls={`${id}-fields-${index}`}
                  ref={(control) => { if (control) rowControls.current.set(key, control); else rowControls.current.delete(key); }}
                  onClick={() => { const next = new Set(expanded); if (next.has(key)) next.delete(key); else next.add(key); setLocalExpanded(next); onExpandedHopsChange?.(next); }}>
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                      {hop.kind === "managed" ? <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                      <span className="min-w-0 break-words">{name(hop)}</span>
                    </span>
                    <span id={`${id}-identity-${index}`} className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {isPending ? <span>待选择监听端点</span> : program ? <><span>{host?.name || "原服务器"}</span><span>{program.listener.connection.protocol.toUpperCase()}</span><span>端口 {program.listener.connection.port}</span></> : <><span>外部代理{connector ? ` ${connector.connection.protocol.toUpperCase()}` : ""}</span>{connectorHost && <span>由 {connectorHost.name} 连接</span>}</>}
                    </span>
                  </span>
                  <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", isExpanded && "rotate-180")} aria-hidden="true" />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ActionButton variant="ghost" size="icon" aria-label={`第 ${hopNumber} 跳更多操作`} title="更多操作" leadingIcon={<MoreHorizontal aria-hidden="true" />}
                      ref={(control) => { if (control) menuControls.current.set(key, control); else menuControls.current.delete(key); }} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64" aria-label={`第 ${hopNumber} 跳操作`}
                    onCloseAutoFocus={(event) => {
                      if (!menuAction.current) return;
                      event.preventDefault();
                      if (menuAction.current === "change") {
                        restorePendingFocus();
                        // A rejected or still-pending change has no new row to
                        // focus yet. Keep keyboard users on the action owner.
                        const active = document.activeElement;
                        if (active === document.body || active?.closest('[role="menu"]')) menuControls.current.get(key)?.focus();
                      }
                      if (menuAction.current === "insert") addPicker.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
                      menuAction.current = null;
                    }}>
                    <DropdownMenuItem className="min-h-11 data-disabled:opacity-100 data-disabled:text-muted-foreground" aria-label={`上移第 ${hopNumber} 跳`} disabled={changing || index === 0 || !!upReason}
                      aria-describedby={upReason ? `${id}-up-${index}` : undefined}
                      onSelect={() => { menuAction.current = "change"; void change(up, menuControls.current.get(key) || null, hop); }}>
                      <ArrowUp aria-hidden="true" /><span>上移{upReason && <span id={`${id}-up-${index}`} className="mt-1 block text-xs font-normal">{upReason}</span>}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11 data-disabled:opacity-100 data-disabled:text-muted-foreground" aria-label={`下移第 ${hopNumber} 跳`} disabled={changing || index === hops.length - 1 || !!downReason}
                      aria-describedby={downReason ? `${id}-down-${index}` : undefined}
                      onSelect={() => { menuAction.current = "change"; void change(down, menuControls.current.get(key) || null, hop); }}>
                      <ArrowDown aria-hidden="true" /><span>下移{downReason && <span id={`${id}-down-${index}`} className="mt-1 block text-xs font-normal">{downReason}</span>}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem className="min-h-11 data-disabled:opacity-100 data-disabled:text-muted-foreground" aria-label={`在第 ${hopNumber} 跳后插入下一跳`} disabled={changing}
                      onSelect={() => { menuAction.current = "insert"; openAdd(index + 1, menuControls.current.get(key)!); }}>
                      <Plus aria-hidden="true" />在此后插入
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="min-h-11 data-disabled:opacity-100 data-disabled:text-muted-foreground" variant="destructive" aria-label={`移除第 ${hopNumber} 跳`} disabled={changing || !!removeReason}
                      aria-describedby={removeReason ? `${id}-remove-${index}` : undefined}
                      onSelect={() => { menuAction.current = "change"; void change(removed, menuControls.current.get(key) || null, hops[index + 1] || hops[index - 1]); }}>
                      <Trash2 aria-hidden="true" /><span>移除此跳{removeReason && <span id={`${id}-remove-${index}`} className="mt-1 block text-xs font-normal">{removeReason}</span>}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div id={`${id}-fields-${index}`} hidden={!isExpanded} className="border-t bg-muted/20 p-3 sm:p-4">
            {hop.kind === "managed" && program ? <ServerEndpointSelect inventory={inventory}
              endpointRef={(control) => { if (control) controls.current.set(key, control); else controls.current.delete(key); }}
              value={hop.endpointId} label={`第 ${hopNumber} 跳`} displayCurrentSnapshot
              current={{ endpoint: program.listener, hostId: program.instance.hostId }}
              onSelectionChange={invalidate}
              allowedIds={inventory.endpoints.filter((endpoint) => !changeReason(replace(index, { kind: "managed", endpointId: endpoint.id }))).map((endpoint) => endpoint.id)}
              unavailableReason="此端点不能替换当前监听；请先移除关联的外部代理跳，且不要重复使用同一核心。"
              onPendingChange={(pending) => {
                onPendingChange(hop.endpointId, pending);
                setPendingRows((current) => {
                  if (current.has(key) === pending) return current;
                  const next = new Set(current); if (pending) next.add(key); else next.delete(key); return next;
                });
              }}
              onChange={(endpointId) => {
                const next: OrderedServerHop = { kind: "managed", endpointId };
                void change(replace(index, next), controls.current.get(key) || null, next);
              }} /> : hop.kind === "connector" ? <>
              <div className="grid min-w-0 gap-1 text-sm font-medium">
                <label htmlFor={`${id}-hop-${index}-proxy`}>外部代理</label>
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                <ChoiceSelect ref={(control) => { if (control) controls.current.set(key, control); else controls.current.delete(key); }}
                  id={`${id}-hop-${index}-proxy`} className="min-w-0 basis-full sm:basis-0 sm:flex-1"
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
              {editReason ? <Popover>
                <PopoverTrigger asChild>
                  <ActionButton variant="ghost" aria-label={`第 ${hopNumber} 跳连接参数只读原因`} leadingIcon={<LockKeyhole aria-hidden="true" />}>参数只读</ActionButton>
                </PopoverTrigger>
                <PopoverContent aria-label={`第 ${hopNumber} 跳连接参数只读原因`} className="text-sm font-normal" align="end">{editReason}</PopoverContent>
              </Popover> : <ActionButton variant="ghost" aria-label={editLabel} disabled={changing || !!adding || !connectorOwner}
                leadingIcon={<Pencil aria-hidden="true" />} onClick={() => onEditConnector(hop.programEndpointId, hop.connectorId, editLabel)}>
                参数
              </ActionButton>}
                </div>
              </div>
            </> : null}
              </div>
            </div>
          </li>
          {adding?.index === index + 1 && picker(index + 1)}
        </Fragment>;
      })}
    </ol>
    <div className="relative flex items-center gap-3 py-3 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-border">
      <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"><ArrowDown className="size-4 text-muted-foreground" aria-hidden="true" /></span>
      {!!hops.length && <ActionButton variant="outline" className="border-dashed" leadingIcon={<Plus aria-hidden="true" />}
        ref={(button) => { if (button) addButtons.current.set(hops.length, button); else addButtons.current.delete(hops.length); }}
        aria-expanded={adding?.index === hops.length} aria-controls={adding?.index === hops.length ? `${id}-add-hop` : undefined}
        disabled={changing} onClick={(event) => openAdd(hops.length, event.currentTarget)}>添加下一跳</ActionButton>}
    </div>
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="relative z-10 flex size-8 items-center justify-center rounded-full border bg-background"><Globe className="size-4" aria-hidden="true" /></span>
      目标
    </div>
  </div>;
}

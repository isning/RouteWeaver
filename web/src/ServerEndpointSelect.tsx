import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { cn } from "@/lib/utils";
import { useEffect, useId, useState, type Ref } from "react";
import type { Infrastructure, ManagedEndpoint } from "./types";
/** Presentation only: callers supply the authoritative role/capability/path filter. */
export function ServerEndpointSelect({
  inventory,
  value,
  label,
  allowedIds,
  current,
  displayCurrentSnapshot = false,
  compact = false,
  unavailableReason,
  endpointRef,
  onChange,
  onPendingChange,
  onSelectionChange,
}: {
  inventory: Infrastructure;
  value?: string;
  label: string;
  allowedIds: string[];
  current?: {
    endpoint: ManagedEndpoint;
    hostId: string;
  };
  /** Saved route editors show their retained snapshot, not an unadopted catalog change. */
  displayCurrentSnapshot?: boolean;
  /** Keep adjacent server/listener choices together in an ordered path row. */
  compact?: boolean;
  unavailableReason?: string;
  endpointRef?: Ref<HTMLButtonElement>;
  onChange: (id: string) => void;
  onPendingChange: (pending: boolean) => void;
  /** A newer server choice invalidates in-flight endpoint resolution. */
  onSelectionChange?: () => void;
}) {
  const owner = (endpoint?: ManagedEndpoint) =>
    inventory.instances.find(
      (instance) => instance.id === endpoint?.instanceId,
    );
  const endpoint = inventory.endpoints.find((entry) => entry.id === value);
  const currentHost = current?.hostId || owner(endpoint)?.hostId;
  const sameOwner =
    !current ||
    (endpoint?.instanceId === current.endpoint.instanceId &&
      owner(endpoint)?.hostId === current.hostId);
  const [server, setServer] = useState(currentHost);
  // A completed endpoint change (or external edit) follows its exact stable owner.
  useEffect(() => {
    setServer(currentHost);
  }, [value, currentHost]);
  const compatible = !!endpoint && owner(endpoint)?.hostId === server;
  const available =
    !!endpoint &&
    sameOwner &&
    allowedIds.includes(endpoint.id) &&
    inventory.hosts.some((host) => host.id === owner(endpoint)?.hostId);
  const pending = value ? !compatible || !available : !!server;
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  const entries = inventory.endpoints.filter(
    (entry) => owner(entry)?.hostId === server,
  );
  const noteId = useId();
  const showUnavailableReason =
    !!unavailableReason &&
    entries.some((entry) => !allowedIds.includes(entry.id));
  const baseLabel = (entry: ManagedEndpoint) =>
    `${entry.name} ${entry.connection.protocol}:${entry.connection.port} ${owner(entry)?.adapterId.replace("routeweaver/", "") || "未知核心"}`;
  const endpointLabel = (entry: ManagedEndpoint) => {
    const duplicates = entries.filter(
      (other) => baseLabel(other) === baseLabel(entry),
    );
    if (duplicates.length < 2) return baseLabel(entry);
    const instance = owner(entry);
    const name = instance?.name;
    const sameName =
      duplicates.filter((other) => owner(other)?.name === name).length > 1;
    return `${baseLabel(entry)} ${name || "核心"}${sameName || !name ? ` (${instance?.id || entry.instanceId} / ${entry.id})` : ""}`;
  };
  const endpointPresentation = (entry: ManagedEndpoint, status = "", compactSelection = false) => (
    <span className="grid min-w-0 gap-1">
      <span>
        {entry.name}
        {status}
      </span>{" "}
      <span className={cn("text-xs font-normal text-muted-foreground", compactSelection && "max-[360px]:sr-only")}>
        {endpointLabel(entry).slice(entry.name.length).trim()}
      </span>
    </span>
  );
  const selected = compatible
    ? value
    : currentHost === server
      ? value
      : undefined;
  const missing = selected && !entries.some((entry) => entry.id === selected);
  const hosts = inventory.hosts.map((host) => ({
    value: host.id,
    label: inventory.hosts.filter((other) => other.name === host.name).length > 1
      ? <span className="grid min-w-0 gap-1">
          <span>{host.name}</span>{" "}
          <span className="text-xs font-normal text-muted-foreground">服务器 ID {host.id}</span>
        </span>
      : host.name,
  }));
  if (server && !hosts.some((host) => host.value === server))
    hosts.push({ value: server, label: "原服务器（当前不可用）" });
  const retainedLabel =
    displayCurrentSnapshot &&
    available &&
    current &&
    current.endpoint.id === selected
      ? endpointPresentation(
          current.endpoint,
          endpoint &&
            endpointLabel(current.endpoint) !== endpointLabel(endpoint)
            ? "（草稿）"
            : "",
          compact,
        )
      : undefined;
  return (
    <div className={cn("server-endpoint-select grid min-w-0 flex-1 gap-2 sm:grid-cols-2 [&>p]:col-span-full", compact && "grid-cols-2")}>
      <div className={cn("grid min-w-0 content-start gap-2", compact && "gap-1")}>
        <label htmlFor={`${noteId}-server`} className="text-sm font-medium">服务器</label>
        <ChoiceSelect
          id={`${noteId}-server`}
          aria-label={`${label}服务器`}
          placeholder="选择服务器"
          clearable
          value={server}
          options={hosts}
          onValueChange={(next) => { onSelectionChange?.(); setServer(next); }}
        />
      </div>
      <div className={cn("grid min-w-0 content-start gap-2", compact && "gap-1")}>
        <label htmlFor={`${noteId}-endpoint`} className="text-sm font-medium">监听端点</label>
        <ChoiceSelect
          id={`${noteId}-endpoint`}
          ref={endpointRef}
          aria-label={`${label}端点`}
          aria-describedby={showUnavailableReason ? noteId : undefined}
          placeholder={server ? "选择该服务器的端点" : "先选择服务器"}
          disabled={!server}
          value={selected}
          selectedLabel={retainedLabel}
          emptyMessage={server ? "此服务器暂无可选端点" : "先选择服务器"}
          aria-invalid={Boolean(selected && (!available || missing))}
          options={[
            ...entries.map((entry) => ({
              value: entry.id,
              label: endpointPresentation(
                entry,
                entry.id === value && !available ? "（当前不可选）" : "",
              ),
              searchText: endpointLabel(entry),
              disabled: !allowedIds.includes(entry.id),
            })),
            ...(missing
              ? [
                  {
                    value: selected,
                    label: `${current?.endpoint.name || "原端点"}（当前不可用）`,
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onValueChange={(id) => {
            if (id !== undefined) onChange(id);
          }}
        />
      </div>
      {showUnavailableReason && (
        <p
          id={noteId}
          className="endpoint-selection-note text-xs leading-relaxed text-muted-foreground"
        >
          {unavailableReason}
        </p>
      )}
    </div>
  );
}


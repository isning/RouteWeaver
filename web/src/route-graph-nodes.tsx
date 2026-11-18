import { Badge } from "@/components/ui/badge";
import { useLayoutEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { Server } from "lucide-react";
import { coreName } from "./infrastructure-data";
import type { Infrastructure, ManagedEndpoint } from "./types";

export type RouteGraphNode = Node<{
  name: string;
  ports: { id: string; name: string; port: number; protocol: string; core: string; role?: string }[];
  onSelect: (id: string) => void;
}, "server">;

export function routeGraphOwner(inventory: Infrastructure, endpoint: ManagedEndpoint) {
  return inventory.instances.find((instance) => instance.id === endpoint.instanceId)?.hostId || endpoint.instanceId;
}

function ServerGraphNode({ id, data }: NodeProps<RouteGraphNode>) {
  const updateHandles = useUpdateNodeInternals();
  useLayoutEffect(() => updateHandles(id), [id, data.ports, updateHandles]);
  return (
    <div className="w-64 rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <strong className="min-w-0 wrap-anywhere text-sm">{data.name}</strong>
      </div>
      {data.ports.map((port) => (
        <div key={port.id} className="relative border-t">
          <Handle type="target" position={Position.Left} id={port.id} className="!top-1/2" />
          <button
            type="button"
            onClick={() => data.onSelect(port.id)}
            className="nodrag grid w-full gap-1 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 wrap-anywhere text-sm font-medium">{port.name}</span>
              {port.role && <Badge variant="secondary">{port.role}</Badge>}
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">{port.protocol.toUpperCase()} :{port.port}</span>
              <span className="min-w-0 wrap-anywhere">{port.core}</span>
            </span>
          </button>
          <Handle type="source" position={Position.Right} id={port.id} className="!top-1/2" />
        </div>
      ))}
    </div>
  );
}

export const routeGraphNodeTypes = { server: ServerGraphNode };

export function routeGraphNodes(
  inventory: Infrastructure,
  path: string[],
  previous: RouteGraphNode[],
  onSelect: (id: string) => void,
): RouteGraphNode[] {
  const previousNodes = new Map(previous.map((node) => [node.id, node]));
  const groups = new Map(inventory.hosts.map((host) => [host.id, { name: host.name, ports: [] as RouteGraphNode["data"]["ports"] }]));
  for (const endpoint of inventory.endpoints) {
    const owner = routeGraphOwner(inventory, endpoint);
    const instance = inventory.instances.find((item) => item.id === endpoint.instanceId);
    const group = groups.get(owner) || { name: owner, ports: [] };
    const step = path.indexOf(endpoint.id);
    group.ports.push({
      id: endpoint.id, name: endpoint.name, port: endpoint.connection.port, protocol: endpoint.connection.protocol,
      core: coreName(instance),
      role: step < 0 ? undefined : step === 0 ? "入口" : step === path.length - 1 ? "出口" : "中转",
    });
    groups.set(owner, group);
  }
  let y = 45;
  let rowHeight = 0;
  return Array.from(groups, ([id, group], index) => {
    const old = previousNodes.get(id);
    const column = index % 3;
    const position = old?.position || { x: 45 + column * 320, y };
    rowHeight = Math.max(rowHeight, 82 + group.ports.length * 68);
    if (column === 2) {
      y += rowHeight;
      rowHeight = 0;
    }
    return { ...old, id, type: "server", position, data: { ...group, onSelect } };
  });
}

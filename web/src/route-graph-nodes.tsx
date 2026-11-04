import { Badge } from "@/components/ui/badge";
import { Position, type Node } from "@xyflow/react";
import type { ReactNode } from "react";
import { coreName } from "./infrastructure-data";
import type { Infrastructure } from "./types";
export type RouteGraphNode = Node<{
  label: ReactNode;
}>;
/** Refresh domain labels while retaining React Flow's measured, transient UI state. */
export function routeGraphNodes(
  inventory: Infrastructure,
  path: string[],
  previous: RouteGraphNode[],
): RouteGraphNode[] {
  const byID = new Map(previous.map((node) => [node.id, node]));
  return inventory.endpoints.map((endpoint, index) => {
    const old = byID.get(endpoint.id);
    const instance = inventory.instances.find(
      (i) => i.id === endpoint.instanceId,
    );
    const host = inventory.hosts.find((h) => h.id === instance?.hostId);
    const selected = path.includes(endpoint.id);
    return {
      ...old,
      id: endpoint.id,
      position: old?.position || {
        x: 45 + (index % 3) * 250,
        y: 45 + Math.floor(index / 3) * 170,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <div className="managed-graph-node min-w-48 max-w-72 rounded-lg border bg-card p-4 shadow-sm">
            <strong>{endpoint.name}</strong>
            <small className="block text-xs text-muted-foreground my-2">
              <span className="block">{host?.name}</span>{" "}
              <span className="block">{coreName(instance)}</span>
            </small>
            {selected && (
              <Badge variant="secondary">
                {path.indexOf(endpoint.id) === 0
                  ? "入口"
                  : path.indexOf(endpoint.id) === path.length - 1
                    ? "出口"
                    : "中转"}
              </Badge>
            )}
          </div>
        ),
      },
      style: {
        width: 220,
        padding: 0,
        borderRadius: 8,
        border: selected
          ? "2px solid var(--primary)"
          : "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--card-foreground)",
      },
    };
  });
}

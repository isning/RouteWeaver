import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { TaskDialog } from "@/ui-patterns/task-overlays";
import { InventoryEditor, type InventoryEditTask } from "./InventoryEditor";
import { ServerRouteEditor } from "./ServerRoutes";
import { APIError, request } from "./api";
import { loadInfrastructure } from "./infrastructure-data";
import { normalizeDeployment } from "./infrastructure-model";
import type {
  Infrastructure,
  ManagedEndpoint,
  ServerDeployment,
} from "./types";

export interface PublicRouteTLSRepairTarget {
  lineId: string;
  deploymentId: string;
  endpointId: string;
}

/** The parent retains its draft and suspends its overlay for this task. */
export function PublicRouteTLSRepair({
  target,
  inventory,
  isCurrent,
  onClose,
  onRecheck,
}: {
  target: PublicRouteTLSRepairTarget;
  inventory: Infrastructure;
  /** Revoked when the originating draft, navigation or account changes. */
  isCurrent: () => boolean;
  onClose: () => void;
  /** An explicit user request, after a fresh summary read. No secrets cross it. */
  onRecheck: () => void;
}) {
  const client = useQueryClient();
  const [origin] = useState(() => {
    const deployment = inventory.deployments.find(
      (value) => value.id === target.deploymentId,
    );
    const programs =
      deployment?.ir.programs.filter(
        (value) => value.listener.id === target.endpointId,
      ) || [];
    const program = programs.length === 1 ? programs[0] : undefined;
    // Retain only identity and display metadata, never a revealed TLS snapshot.
    return {
      target,
      deploymentName: deployment?.name,
      endpointName: program?.listener.name,
      instanceId: program?.instance.id,
      valid: !!program && program.listener.instanceId === program.instance.id,
    };
  });
  const [endpointTask, setEndpointTask] = useState<InventoryEditTask | null>(
    null,
  );
  const [pathTask, setPathTask] = useState<ServerDeployment | null>(null);
  const [busy, setBusy] = useState<"endpoint" | "path" | "recheck" | null>(
    null,
  );
  const [error, setError] = useState<string>();
  const [endpointSaved, setEndpointSaved] = useState(false);
  const [pathSaved, setPathSaved] = useState(false);
  const operation = useRef(0);
  const mounted = useRef(false);
  const current = useRef({ target, isCurrent, onClose, onRecheck });
  current.current = { target, isCurrent, onClose, onRecheck };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current++;
    };
  }, []);
  const ownsOperation = (sequence = operation.current) =>
    mounted.current &&
    sequence === operation.current &&
    current.current.target === origin.target;
  const owns = (sequence = operation.current) =>
    ownsOperation(sequence) && current.current.isCurrent();
  const close = () => {
    // Dismissal grants no read/write permission. An expired navigation lease
    // must not trap the user in an overlay they can no longer act within.
    if (!mounted.current || current.current.target !== origin.target) return;
    operation.current++;
    current.current.onClose();
  };
  const failure = (cause: unknown) =>
    cause instanceof APIError && [401, 403].includes(cause.status)
      ? "无法读取此配置。请先确认登录状态和访问权限，公开线路输入已保留。"
      : cause instanceof APIError && cause.status === 404
        ? "所选入口或路径已不存在。请返回公开线路重新选择，当前输入已保留。"
        : "未能读取最新配置。请重试，公开线路输入已保留。";
  const identityError =
    "所选入口与当前路径不再匹配。请返回公开线路重新选择，当前输入已保留。";
  const matchesPath = (deployment: ServerDeployment | undefined) => {
    const programs =
      deployment?.ir.programs.filter(
        (program) => program.listener.id === target.endpointId,
      ) || [];
    return (
      deployment?.id === target.deploymentId &&
      programs.length === 1 &&
      programs[0].instance.id === origin.instanceId &&
      programs[0].listener.instanceId === origin.instanceId
    );
  };
  const read = async (kind: "endpoint" | "path") => {
    if (!owns() || busy || !origin.valid) return;
    const sequence = ++operation.current;
    setBusy(kind);
    setError(undefined);
    try {
      if (kind === "endpoint") {
        const endpoint = await request<ManagedEndpoint>(
          `/managed-endpoints/${encodeURIComponent(target.endpointId)}/reveal`,
        );
        if (!owns(sequence)) return;
        if (
          endpoint.id !== target.endpointId ||
          endpoint.instanceId !== origin.instanceId
        ) {
          setError(identityError);
          return;
        }
        setEndpointTask({
          kind: "managed-endpoints",
          value: endpoint,
          id: endpoint.id,
        });
      } else {
        const deployment = normalizeDeployment(
          await request<ServerDeployment>(
            `/server-deployments/${encodeURIComponent(target.deploymentId)}/reveal`,
          ),
        );
        if (!owns(sequence)) return;
        if (!matchesPath(deployment)) {
          setError(identityError);
          return;
        }
        setPathTask(deployment);
      }
    } catch (cause) {
      if (owns(sequence)) setError(failure(cause));
    } finally {
      // A pending navigation decision can temporarily withhold view authority.
      // Release this task's spinner without accepting its result or retrying.
      if (ownsOperation(sequence)) setBusy(null);
    }
  };
  const recheck = async () => {
    if (!owns() || busy || !origin.valid) return;
    const sequence = ++operation.current;
    setBusy("recheck");
    setError(undefined);
    try {
      // Only the summary DTO enters the shared cache. Revealed endpoints and
      // server private keys stay within the explicitly opened child editor.
      await client.cancelQueries({ queryKey: ["infrastructure"] });
      if (!owns(sequence)) return;
      const refreshed = await loadInfrastructure();
      if (!owns(sequence)) return;
      if (
        !matchesPath(
          refreshed.deployments.find(
            (value) => value.id === target.deploymentId,
          ),
        )
      ) {
        setError(identityError);
        return;
      }
      client.setQueryData(["infrastructure"], refreshed);
      operation.current++;
      current.current.onRecheck();
    } catch (cause) {
      if (owns(sequence)) setError(failure(cause));
    } finally {
      if (ownsOperation(sequence)) setBusy(null);
    }
  };
  // Editors own their discard, impact, revision and file-read confirmations.
  // Replacing this overview keeps only one foreground editing surface active.
  if (endpointTask)
    return (
      <InventoryEditor
        entity={endpointTask}
        inventory={inventory}
        onHostCreated={() => {}}
        onCoreCreated={() => {}}
        onEndpointSaved={(endpoint) => {
          if (owns() && endpoint.id === target.endpointId) {
            setEndpointSaved(true);
            setPathSaved(false);
          }
        }}
        onClose={() => {
          if (owns()) setEndpointTask(null);
          else close();
        }}
      />
    );
  if (pathTask)
    return (
      <ServerRouteEditor
        initial={pathTask}
        initialRefreshEndpoint={target.endpointId}
        initialSection="tls"
        inventory={inventory}
        isNew={false}
        onClose={() => {
          if (owns()) setPathTask(null);
          else close();
        }}
        onSaved={(saved) => {
          if (!owns() || saved.id !== target.deploymentId) return false;
          setPathSaved(true);
          setPathTask(null);
          return true;
        }}
      />
    );
  return (
    <TaskDialog
      open
      title="修复公开线路 TLS"
      size="lg"
      bodyProps={{ className: "space-y-5" }}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
          <ActionButton variant="outline" onClick={close}>
            返回公开线路
          </ActionButton>
          <ActionButton
            disabled={!origin.valid || !!busy}
            pending={busy === "recheck"}
            onKeyDown={(event) => {
              if (event.repeat && ["Enter", " "].includes(event.key))
                event.preventDefault();
            }}
            onClick={(event) => {
              if (event.detail > 1) return;
              void recheck();
            }}
          >
            返回并重新检查
          </ActionButton>
        </div>
      }
    >
      <dl className="grid gap-3 break-words sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">转发路径</dt>
          <dd>{origin.deploymentName || target.deploymentId}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">公网入口</dt>
          <dd>{origin.endpointName || target.endpointId}</dd>
        </div>
      </dl>
      {(!origin.valid || error) && (
        <Notice tone="warning" title="尚不能继续修复">
          {error || identityError}
        </Notice>
      )}
      <ol className="space-y-4">
        <li className="space-y-2 rounded-lg border p-4">
          <h3 className="font-medium">1. 入口连接保护</h3>
          <p className="text-sm text-muted-foreground">
            启用监听端点的 TLS，核对受影响的配置后保存。
          </p>
          {endpointSaved && !pathSaved && (
            <p role="status">监听端点已保存，路径仍使用原有快照。</p>
          )}
          <ActionButton
            variant="outline"
            disabled={!origin.valid || !!busy}
            pending={busy === "endpoint"}
            onClick={() => void read("endpoint")}
          >
            配置入口 TLS
          </ActionButton>
        </li>
        <li className="space-y-2 rounded-lg border p-4">
          <h3 className="font-medium">2. 路径快照与证书</h3>
          <p className="text-sm text-muted-foreground">
            比较并接受监听更新，再填写服务端证书与安全参数。保存路径不会应用到服务器。
          </p>
          {pathSaved && (
            <p role="status">转发路径已保存，公开线路尚待重新检查。</p>
          )}
          <ActionButton
            variant="outline"
            disabled={!origin.valid || !!busy}
            pending={busy === "path"}
            onClick={() => void read("path")}
          >
            更新路径 TLS
          </ActionButton>
        </li>
      </ol>
      <details className="text-sm text-muted-foreground">
        <summary>目标身份</summary>
        <dl className="mt-2 space-y-2 break-all">
          <div>
            <dt>公开线路</dt>
            <dd>{target.lineId}</dd>
          </div>
          <div>
            <dt>转发路径</dt>
            <dd>{target.deploymentId}</dd>
          </div>
          <div>
            <dt>入口端点</dt>
            <dd>{target.endpointId}</dd>
          </div>
        </dl>
      </details>
    </TaskDialog>
  );
}

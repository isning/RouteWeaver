import { ActionButton } from "@/ui-patterns/actions";
import type {
  ActionRef,
  Infrastructure,
  MatchExpression,
  ServerProgram,
} from "./types";
/** A program is one listener's policy, not one hop in the programs array. */
export function ServerForwarding({
  programs,
  inventory,
  compact = false,
  onRefreshListener,
}: {
  programs: ServerProgram[];
  inventory: Infrastructure;
  compact?: boolean;
  onRefreshListener?: (endpointId: string) => void;
}) {
  return (
    <div
      className={
        compact
          ? "server-forwarding grid min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere] gap-3 [&>section]:min-w-0 [&_dl]:grid [&_dl]:gap-1 [&_dl>div]:grid [&_dl>div]:min-w-0 [&_dl>div]:gap-x-1.5 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:max-w-full [&_dd]:[overflow-wrap:anywhere]"
          : "server-forwarding grid min-w-0 max-w-full [overflow-wrap:anywhere] gap-4 [&>section]:min-w-0 [&>section]:border-b [&>section]:py-4 [&>section:last-child]:border-0 [&_dl]:grid [&_dl]:gap-3 [&_dl>div]:grid [&_dl>div]:gap-1 sm:[&_dl>div]:grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] sm:[&_dl>div]:gap-4 [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:max-w-full [&_dd]:[overflow-wrap:anywhere]"
      }
    >
      {programs.map((program) => (
        <section
          key={program.listener.id}
          aria-label={`${program.listener.name}的转发`}
        >
          <div
            className={
              compact
                ? "server-forwarding-heading mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                : "server-forwarding-heading mb-4 flex flex-wrap items-center justify-between gap-3"
            }
          >
            <strong className={compact ? "text-xs font-medium" : undefined}>
              {program.listener.name}
            </strong>
            <small
              className={compact ? "text-xs text-muted-foreground" : undefined}
            >
              {inventory.hosts.find(
                (host) => host.id === program.instance.hostId,
              )?.name || "服务器不可用"}
              {!compact &&
                ` · ${program.instance.name || program.instance.adapterId.replace("routeweaver/", "")}`}
            </small>
            {onRefreshListener && (
              <ActionButton
                className="listener-refresh-action flex flex-wrap gap-2"
                aria-label={`检查监听更新 ${program.listener.name}`}
                onClick={() => onRefreshListener(program.listener.id)}
                variant="link"
              >
                检查监听更新
              </ActionButton>
            )}
          </div>
          <dl className={compact ? "text-xs leading-relaxed" : undefined}>
            {(program.principals || []).map((principal, index) => (
              <div key={`${principal.accountId}:${principal.routeId}:${index}`}>
                <dt>
                  用户入口 {principal.accountId} · {principal.routeId}
                </dt>
                <dd>{actionLabel(program, principal.action)}</dd>
              </div>
            ))}
            {(program.rules || []).map((rule, index) => (
              <div key={rule.id}>
                <dt>
                  规则 {index + 1} · {matchLabel(rule.match)}
                </dt>
                <dd>{actionLabel(program, rule.action)}</dd>
              </div>
            ))}
            <div>
              <dt
                className={
                  compact &&
                  !program.rules?.length &&
                  !program.principals?.length
                    ? "sr-only"
                    : undefined
                }
              >
                {program.rules?.length || program.principals?.length
                  ? "其余流量"
                  : "默认流量"}
              </dt>
              <dd>{defaultLabel(program)}</dd>
            </div>
          </dl>
          {!compact && !!program.connectors?.length && (
            <details className="server-forwarding-connectors mt-4 rounded-lg border bg-muted/20 p-3 text-sm [&_summary]:cursor-pointer [&_summary]:font-medium [&_summary]:text-muted-foreground [&_dl]:mt-3">
              <summary>连接器设置 · {program.connectors.length} 个</summary>
              <dl>
                {program.connectors.map((connector) => (
                  <div key={connector.id}>
                    <dt>{connector.id}</dt>
                    <dd>{connectorPath(program, connector.id)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}
function destination(connection?: { host: string; port: number }) {
  if (
    !connection ||
    typeof connection.host !== "string" ||
    !connection.host ||
    !Number.isFinite(connection.port)
  )
    return "目标地址未设置";
  const host = connection.host.includes(":")
    ? `[${connection.host}]`
    : connection.host;
  return `${host}:${connection.port}`;
}
function connectors(program: ServerProgram) {
  return program.connectors?.length
    ? program.connectors
    : (program.egress || []).map((connection, index) => ({
        id: `egress-${index + 1}`,
        connection,
        via: index ? `egress-${index}` : undefined,
      }));
}
function connectorPath(
  program: ServerProgram,
  id: string,
  visited = new Set<string>(),
): string {
  if (visited.size > 128) return "连接器路径过于复杂，摘要未展开";
  if (visited.has(id)) return `连接器循环：${id}`;
  const connector = connectors(program).find((item) => item.id === id);
  if (!connector) return `连接器不可用：${id || "未指定"}`;
  const next = new Set(visited).add(id);
  const target = destination(connector.connection);
  return connector.via
    ? `${connectorPath(program, connector.via, next)} → ${target}`
    : target;
}
function actionLabel(program: ServerProgram, action?: ActionRef) {
  if (program.egress?.length && program.connectors?.length)
    return "转发设置冲突：同时配置了两种出口";
  if (action?.kind === "reject") return "拒绝连接";
  if (action?.kind === "direct") return "直连";
  if (action?.kind === "forward")
    return `转发至 ${connectorPath(program, action.ref || "")}`;
  return action?.kind ? `未识别的处理方式：${action.kind}` : "未设置处理方式";
}
function defaultLabel(program: ServerProgram) {
  if (program.defaultAction?.kind)
    return actionLabel(program, program.defaultAction);
  if (program.defaultAction?.ref) return "未设置默认处理";
  if (program.egress?.length)
    return actionLabel(program, {
      kind: "forward",
      ref: `egress-${program.egress.length}`,
    });
  if (program.connectors?.length) return "未设置默认处理";
  return "直连";
}
function matchLabel(match?: MatchExpression, depth = 0): string {
  // Match validation has the same safety limit in domain/profile_validation.go.
  if (depth > 128) return "条件过于复杂，摘要未展开";
  if (!match) return "未识别条件：未指定";
  const value = match.value || "未指定";
  const children = Array.isArray(match.children) ? match.children : [];
  const childLabels = () =>
    children.length
      ? children.map((child) => matchLabel(child, depth + 1))
      : ["条件未设置"];
  switch (match.op) {
    case "domain":
      return `域名 ${value}`;
    case "domain-suffix":
      return `域名后缀 ${value}`;
    case "ip-cidr":
      return `IP 网段 ${value}`;
    case "resource":
      return `规则资源 ${value}`;
    case "and":
      return `(${childLabels().join(" 且 ")})`;
    case "or":
      return `(${childLabels().join(" 或 ")})`;
    case "not":
      return `不匹配 (${childLabels().join("，")})`;
    default:
      return `未识别条件：${match.op || "未指定"}`;
  }
}

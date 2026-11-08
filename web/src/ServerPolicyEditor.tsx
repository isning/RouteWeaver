import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import {
  actionLabel,
  connectorPath,
  defaultLabel,
  matchLabel,
} from "./ServerForwarding";
import type { ActionRef, Infrastructure, ServerProgram } from "./types";

// This is a bounded editing surface, not a replacement for server validation.
// Keep the saved target identity: inventory upgrades do not upgrade a draft.
const defaultActionTargets: Record<string, string[]> = {
  "routeweaver/xray": ["26.3.27", "26.10.29", "26.10.31"],
  "routeweaver/sing-box": ["1.14.3", "1.14.4"],
};

function defaultEditReason(program: ServerProgram, schemaVersion: string) {
  if (schemaVersion !== "1.0")
    return "此配置版本不能用默认去向表单修改，请使用完整 JSON。";
  if (
    program.instance.adapterId === "routeweaver/managed-xray" ||
    program.listener.authentication === "principals" ||
    program.principals?.length
  )
    return "此监听关联用户入口或托管计量，默认处理需与线路授权一同维护；此处仅查看。";
  if (
    !defaultActionTargets[program.instance.adapterId]?.includes(
      program.instance.version,
    )
  )
    return "此核心版本不在默认去向表单的支持范围，请使用完整 JSON 并检查配置。";
  if (program.egress?.length && program.connectors?.length)
    return "同时存在顺序出口和命名连接器，请先在完整 JSON 中解决冲突。";
  if (program.egress?.length)
    return "此监听使用顺序出口；请在完整 JSON 中修改，保留原出口顺序。";
  const action = program.defaultAction;
  if (
    action &&
    (Object.keys(action).some((key) => !["kind", "ref"].includes(key)) ||
      !["", "direct", "reject", "forward"].includes(action.kind) ||
      (action.kind !== "forward" && action.ref))
  )
    return "默认处理包含此表单无法解释的设置，请使用完整 JSON。";
  return undefined;
}

function connectorReason(program: ServerProgram, id: string) {
  if (!id) return "连接器引用缺失，需先修复";
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current) {
    if (seen.has(current)) return "连接器存在循环，需先修复";
    if (seen.size >= 128) return "连接器路径过深，需在完整 JSON 中检查";
    seen.add(current);
    const matches = (program.connectors || []).filter(
      (connector) => connector.id === current,
    );
    if (matches.length !== 1) return "连接器引用缺失或身份重复，需先修复";
    const connector = matches[0];
    if (
      !connector.connection?.host ||
      !Number.isInteger(connector.connection.port) ||
      connector.connection.port < 1 ||
      connector.connection.port > 65535
    )
      return "连接器目标地址不完整，需先修复";
    current = connector.via;
  }
  return undefined;
}

function DefaultDestination({
  program,
  label,
  schemaVersion,
  onChange,
}: {
  program: ServerProgram;
  label: string;
  schemaVersion: string;
  onChange: (action: ActionRef) => void;
}) {
  const reason = defaultEditReason(program, schemaVersion);
  if (reason)
    return (
      <div className="space-y-2">
        <p>{defaultLabel(program)}</p>
        <p className="text-sm text-muted-foreground">{reason}</p>
      </div>
    );
  const action = program.defaultAction;
  const explicit = !!action?.kind;
  const value = explicit
    ? action.kind === "forward"
      ? `connector:${action.ref || ""}`
      : action.kind
    : "implicit";
  const connectors = program.connectors || [];
  const options = [
    ...(!explicit
      ? [
          {
            value: "implicit",
            label: connectors.length ? "未设置默认去向" : "未显式设置（直连）",
            disabled: true,
          },
        ]
      : []),
    { value: "direct", label: "直连" },
    { value: "reject", label: "拒绝连接" },
    ...connectors
      .filter(
        (connector, index) =>
          connectors.findIndex((other) => other.id === connector.id) === index,
      )
      .map((connector) => {
        const reason = connectorReason(program, connector.id);
        return {
          value: `connector:${connector.id}`,
          label: `转发至连接器 ${connector.id}`,
          "aria-label": `转发至连接器 ${connector.id}`,
          description: reason || connectorPath(program, connector.id),
          disabled: !!reason,
        };
      }),
    ...(action?.kind === "forward" &&
    !connectors.some((connector) => connector.id === action.ref)
      ? [
          {
            value,
            label: `连接器不可用：${action.ref || "未指定"}`,
            disabled: true,
          },
        ]
      : []),
  ];
  const selectedIssue =
    action?.kind === "forward"
      ? connectorReason(program, action.ref || "")
      : undefined;
  return (
    <div className="space-y-2">
      <ChoiceSelect
        aria-label={`${label} 默认去向`}
        value={value}
        options={options}
        onValueChange={(next) => {
          if (!next || next === value || next === "implicit") return;
          if (next === "direct" || next === "reject") onChange({ kind: next });
          else if (next.startsWith("connector:")) {
            const ref = next.slice("connector:".length);
            if (
              connectors.some((connector) => connector.id === ref) &&
              !connectorReason(program, ref)
            )
              onChange({ kind: "forward", ref });
          }
        }}
      />
      {selectedIssue && (
        <p className="text-sm text-destructive">{selectedIssue}</p>
      )}
      {!!program.rules?.length && (
        <p className="text-sm text-muted-foreground">
          未命中条件规则的流量使用此去向。
        </p>
      )}
    </div>
  );
}

/** Patch only the chosen default action. Never turn policy programs into a chain. */
export function ServerPolicyEditor({
  programs,
  schemaVersion,
  inventory,
  onDefaultActionChange,
  onRefreshListener,
  onEditJSON,
}: {
  programs: ServerProgram[];
  schemaVersion: string;
  inventory: Infrastructure;
  onDefaultActionChange: (index: number, action: ActionRef) => void;
  onRefreshListener: (endpointId: string) => void;
  onEditJSON: () => void;
}) {
  const programViews = programs.map((program, programIndex) => {
    const listenerName = program.listener.name?.trim() || "未命名监听";
    const coreName =
      program.instance.name?.trim() ||
      program.instance.adapterId.replace("routeweaver/", "");
    const duplicateListener = programs.some(
      (other, index) =>
        index !== programIndex &&
        other.listener.name?.trim() === program.listener.name?.trim(),
    );
    const needsIdentity =
      !program.listener.name?.trim() ||
      !program.instance.name?.trim() ||
      programs.some(
        (other, index) =>
          index !== programIndex &&
          (other.listener.name?.trim() === program.listener.name?.trim() ||
            other.instance.name?.trim() === program.instance.name?.trim()),
      );
    const identityLabel =
      !program.listener.name?.trim() || duplicateListener
        ? `${listenerName}，核心 ${coreName}，核心标识 ${program.instance.id}，监听标识 ${program.listener.id}`
        : listenerName;
    return {
      program,
      programIndex,
      listenerName,
      coreName,
      needsIdentity,
      identityLabel,
    };
  });
  return (
    <div className="space-y-4">
      {programViews.map(
        ({
          program,
          programIndex,
          listenerName,
          coreName,
          needsIdentity,
          identityLabel,
        }) => (
          <section
            key={`${program.instance.id}:${program.listener.id}:${programIndex}`}
            aria-label={`${identityLabel}的策略设置`}
            className="min-w-0 space-y-5 rounded-xl border bg-card p-4 sm:p-5 [overflow-wrap:anywhere]"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold">{listenerName}</h3>
                <p className="text-sm text-muted-foreground">
                  {inventory.hosts.find(
                    (host) => host.id === program.instance.hostId,
                  )?.name || "服务器不可用"}
                </p>
                <p className="text-sm text-muted-foreground">{coreName}</p>
                <details
                  open={needsIdentity}
                  aria-label="监听与核心身份"
                  className="text-sm"
                >
                  <summary className="cursor-pointer text-muted-foreground">
                    监听与核心身份
                  </summary>
                  <dl className="mt-2 space-y-2">
                    <div>
                      <dt className="text-muted-foreground">核心标识</dt>
                      <dd>{program.instance.id}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">监听标识</dt>
                      <dd>{program.listener.id}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">核心类型</dt>
                      <dd>{program.instance.adapterId}</dd>
                    </div>
                  </dl>
                </details>
              </div>
              <ActionButton
                variant="link"
                onClick={() => onRefreshListener(program.listener.id)}
                aria-label={`检查监听更新 ${identityLabel}`}
              >
                检查监听更新
              </ActionButton>
            </div>
            <section
              aria-label={`${identityLabel}的默认去向`}
              className="space-y-2"
            >
              <h4 className="text-sm font-medium">默认去向</h4>
              <DefaultDestination
                program={program}
                label={identityLabel}
                schemaVersion={schemaVersion}
                onChange={(action) =>
                  onDefaultActionChange(programIndex, action)
                }
              />
            </section>
            <section
              aria-label={`${identityLabel}的条件规则`}
              className="space-y-3"
            >
              <h4 className="text-sm font-medium">条件规则</h4>
              {program.rules?.length ? (
                <>
                  <ol className="space-y-2">
                    {program.rules.map((rule, index) => (
                      <li
                        key={`${rule.id}:${index}`}
                        className="grid min-w-0 gap-1 rounded-lg bg-muted/30 p-3 text-sm"
                      >
                        <span className="text-xs text-muted-foreground">
                          规则 {index + 1}
                        </span>
                        <span>{matchLabel(rule.match)}</span>
                        <span>{actionLabel(program, rule.action)}</span>
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            规则身份
                          </summary>
                          <span>{rule.id}</span>
                        </details>
                      </li>
                    ))}
                  </ol>
                  <p className="text-sm text-muted-foreground">
                    条件与动作在完整 JSON 中编辑，按当前顺序保留。
                  </p>
                  {program.instance.adapterId === "routeweaver/xray" &&
                    program.rules.some(
                      (rule) =>
                        !["domain", "domain-suffix", "ip-cidr"].includes(
                          rule.match?.op,
                        ),
                    ) && (
                      <p className="text-sm text-destructive">
                        此 Xray 配置包含尚不支持的条件类型，检查时会拒绝应用。
                      </p>
                    )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">未配置条件规则</p>
              )}
            </section>
            <details className="space-y-3 rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                <span>连接器与策略依赖</span>
                <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
                  <span>{program.connectors?.length || 0} 个连接器</span>
                  <span>{program.principals?.length || 0} 个用户入口</span>
                  <span>{program.resources?.length || 0} 个规则资源</span>
                </span>
              </summary>
              <div className="space-y-4 pt-2">
                <section
                  aria-label={`${identityLabel}的连接器`}
                  className="space-y-2"
                >
                  <h4 className="font-medium">连接器</h4>
                  {program.connectors?.length ? (
                    <>
                      <dl className="space-y-2">
                        {program.connectors.map((connector, index) => (
                          <div
                            key={`${connector.id}:${index}`}
                            className="grid gap-1 rounded-lg bg-muted/30 p-3"
                          >
                            <dt className="font-medium">{connector.id}</dt>
                            <dd>{connectorPath(program, connector.id)}</dd>
                            <dd className="text-muted-foreground">
                              {connector.via
                                ? `经由连接器 ${connector.via}`
                                : "无上游连接器"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <p className="text-muted-foreground">
                        连接参数与经由关系在完整 JSON
                        中编辑，保留连接器身份与引用。
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      {program.egress?.length
                        ? `使用 ${program.egress.length} 个顺序出口，请在完整 JSON 中查看和编辑。`
                        : "未配置连接器"}
                    </p>
                  )}
                </section>
                <section
                  aria-label={`${identityLabel}的用户入口`}
                  className="space-y-2"
                >
                  <h4 className="font-medium">用户入口</h4>
                  {program.principals?.length ? (
                    <>
                      <ul className="space-y-2">
                        {program.principals.map((principal, index) => (
                          <li
                            key={`${principal.subjectId}:${index}`}
                            className="grid gap-1 rounded-lg bg-muted/30 p-3"
                          >
                            <span>账号 {principal.accountId}</span>
                            <span>线路 {principal.routeId}</span>
                            <span>
                              {actionLabel(program, principal.action)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground">
                        入口身份、凭据与授权版本由线路维护，此处不提供修改。
                      </p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">未配置用户入口</p>
                  )}
                </section>
                <section
                  aria-label={`${identityLabel}的规则资源`}
                  className="space-y-2"
                >
                  <h4 className="font-medium">规则资源</h4>
                  {program.resources?.length ? (
                    <>
                      <ul className="space-y-2">
                        {program.resources.map((resource, index) => (
                          <li
                            key={`${resource.id}:${index}`}
                            className="grid gap-1 rounded-lg bg-muted/30 p-3"
                          >
                            <span className="font-medium">
                              {resource.name || resource.id}
                            </span>
                            <span>
                              {resource.format}
                              {resource.formatVersion
                                ? ` 版本 ${resource.formatVersion}`
                                : ""}
                            </span>
                            <details>
                              <summary className="cursor-pointer text-muted-foreground">
                                资源引用
                              </summary>
                              <dl className="space-y-1 pt-2">
                                <div>
                                  <dt>资源身份</dt>
                                  <dd>{resource.id}</dd>
                                </div>
                                <div>
                                  <dt>快照版本</dt>
                                  <dd>{resource.revision || "未指定"}</dd>
                                </div>
                              </dl>
                            </details>
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground">
                        资源位置与版本在完整 JSON
                        中维护，此处不展示可能含凭据的资源地址。
                      </p>
                      {program.instance.adapterId === "routeweaver/xray" && (
                        <p className="text-destructive">
                          此 Xray 配置不支持规则资源，检查时会拒绝应用。
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-muted-foreground">未配置规则资源</p>
                  )}
                </section>
              </div>
            </details>
          </section>
        ),
      )}
      <ActionButton onClick={onEditJSON} variant="outline">
        编辑转发设置
      </ActionButton>
    </div>
  );
}

import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import {
  actionLabel,
  connectorPath,
  defaultLabel,
  matchLabel,
} from "./ServerForwarding";
import type { ActionRef, Infrastructure, Rule, ServerProgram } from "./types";

// This is a bounded editing surface, not a replacement for server validation.
// Keep the saved target identity: inventory upgrades do not upgrade a draft.
const actionTargets: Record<string, string[]> = {
  "routeweaver/xray": ["26.3.27", "26.10.29", "26.10.31"],
  "routeweaver/sing-box": ["1.14.3", "1.14.4"],
};

function programEditReason(program: ServerProgram, schemaVersion: string) {
  if (schemaVersion !== "1.0")
    return "此配置版本不能用策略表单修改，请使用完整 JSON。";
  if (
    program.instance.adapterId === "routeweaver/managed-xray" ||
    program.listener.authentication === "principals" ||
    program.principals?.length
  )
    return "此监听关联用户入口或托管计量，为保留入口授权和计量关系，此处仅查看。";
  if (
    !actionTargets[program.instance.adapterId]?.includes(
      program.instance.version,
    )
  )
    return "此核心版本不在策略表单的支持范围，请使用完整 JSON 并检查配置。";
  if (program.egress?.length && program.connectors?.length)
    return "同时存在顺序出口和命名连接器，请先在完整 JSON 中解决冲突。";
  if (program.egress?.length)
    return "此监听使用顺序出口；请在完整 JSON 中修改，保留原出口顺序。";
  return undefined;
}

function unknownAction(action: ActionRef | undefined, allowImplicit = false) {
  return !action
    ? !allowImplicit
    : typeof action !== "object" ||
        Array.isArray(action) ||
        typeof action.kind !== "string" ||
        (action.ref !== undefined && typeof action.ref !== "string") ||
        Object.keys(action).some((key) => !["kind", "ref"].includes(key)) ||
        ![
          ...(allowImplicit ? [""] : []),
          "direct",
          "reject",
          "forward",
        ].includes(action.kind) ||
        (action.kind !== "forward" && !!action.ref);
}

function defaultEditReason(program: ServerProgram, schemaVersion: string) {
  const reason = programEditReason(program, schemaVersion);
  if (reason) return reason;
  if (unknownAction(program.defaultAction, true))
    return "默认处理包含此表单无法解释的设置，请使用完整 JSON。";
  return undefined;
}

const leafConditions = ["domain", "domain-suffix", "ip-cidr"];
const usesXrayRules = (program: ServerProgram) =>
  ["routeweaver/xray", "routeweaver/managed-xray"].includes(
    program.instance.adapterId,
  );
function conditionLimit(program: ServerProgram, rule: Rule) {
  return usesXrayRules(program) && !leafConditions.includes(rule.match?.op)
    ? "此 Xray 核心不支持该条件，检查不会通过。"
    : undefined;
}
function ruleEditReason(
  program: ServerProgram,
  schemaVersion: string,
  rule: Rule,
) {
  const scope = programEditReason(program, schemaVersion);
  if (scope) return scope;
  if (
    typeof rule.id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rule.id) ||
    program.rules.filter((other) => other.id === rule.id).length !== 1
  )
    return "规则身份缺失或重复，请先在完整 JSON 中修复。";
  const limit = conditionLimit(program, rule);
  if (limit) return limit;
  if (!leafConditions.includes(rule.match?.op))
    return ["and", "or", "not", "resource"].includes(rule.match?.op)
      ? "该条件尚未提供去向表单，请在完整 JSON 中修改。"
      : "此表单无法解释该条件，请在完整 JSON 中检查。";
  if (
    Object.keys(rule.match).some(
      (key) => !["op", "value", "children"].includes(key),
    ) ||
    typeof rule.match.value !== "string" ||
    !rule.match.value.trim() ||
    (rule.match.children !== undefined &&
      (!Array.isArray(rule.match.children) || rule.match.children.length > 0))
  )
    return "条件包含扩展或不完整设置，请在完整 JSON 中检查。";
  if (unknownAction(rule.action))
    return "此处理方式尚无表单支持，请在完整 JSON 中修改。";
  return undefined;
}

function connectorReason(program: ServerProgram, id: string) {
  if (!id) return "连接器引用缺失，需先修复";
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(current) ||
      ["rw-direct", "rw-reject"].includes(current)
    )
      return "连接器身份无效或为保留名称，需先修复";
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
        {reason !== programEditReason(program, schemaVersion) && (
          <p className="text-sm text-muted-foreground">{reason}</p>
        )}
      </div>
    );
  return (
    <div className="space-y-2">
      <ServerActionSelect
        program={program}
        action={program.defaultAction}
        label={`${label} 默认去向`}
        onChange={onChange}
      />
      {!!program.rules?.length && (
        <p className="text-sm text-muted-foreground">
          未命中条件规则的流量使用此去向。
        </p>
      )}
    </div>
  );
}

function ServerActionSelect({
  program,
  action,
  label,
  onChange,
}: {
  program: ServerProgram;
  action?: ActionRef;
  label: string;
  onChange: (action: ActionRef) => void;
}) {
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
        aria-label={label}
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
    </div>
  );
}

/** Patch only the chosen action. Never turn policy programs into a chain. */
export function ServerPolicyEditor({
  programs,
  schemaVersion,
  inventory,
  onDefaultActionChange,
  onRuleActionChange,
  onRefreshListener,
  onEditJSON,
}: {
  programs: ServerProgram[];
  schemaVersion: string;
  inventory: Infrastructure;
  onDefaultActionChange: (index: number, action: ActionRef) => void;
  onRuleActionChange: (
    programIndex: number,
    ruleID: string,
    action: ActionRef,
  ) => void;
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
            {programEditReason(program, schemaVersion) && (
              <p className="text-sm text-muted-foreground">
                {programEditReason(program, schemaVersion)}
              </p>
            )}
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
                        {ruleEditReason(program, schemaVersion, rule) ? (
                          <>
                            <span>{actionLabel(program, rule.action)}</span>
                            {ruleEditReason(program, schemaVersion, rule) !==
                              programEditReason(program, schemaVersion) && (
                              <p className="text-sm text-muted-foreground">
                                {ruleEditReason(program, schemaVersion, rule)}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <ServerActionSelect
                              program={program}
                              action={rule.action}
                              label={`${identityLabel} 规则 ${index + 1} 去向`}
                              onChange={(action) =>
                                onRuleActionChange(
                                  programIndex,
                                  rule.id,
                                  action,
                                )
                              }
                            />
                            {rule.action.kind === "forward" && (
                              <p className="text-xs text-muted-foreground">
                                {actionLabel(program, rule.action)}
                              </p>
                            )}
                          </>
                        )}
                        {conditionLimit(program, rule) &&
                          conditionLimit(program, rule) !==
                            ruleEditReason(program, schemaVersion, rule) && (
                            <p className="text-sm text-destructive">
                              {conditionLimit(program, rule)}
                            </p>
                          )}
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
                    条件与顺序尚未提供表单，请在完整 JSON 中编辑。
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">未配置条件规则</p>
              )}
            </section>
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
                    连接参数与经由关系尚未提供表单，请在完整 JSON
                    中编辑；保留连接器身份与引用。
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
                        <span>{actionLabel(program, principal.action)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    用户入口涉及身份、凭据与授权，此表单仅供查看；请通过原入口管理流程维护。
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
                    资源位置与版本尚未提供表单，请在完整 JSON
                    中维护。资源地址可能含凭据，此处不展示。
                  </p>
                  {usesXrayRules(program) && (
                    <p className="text-destructive">
                      此 Xray 核心不支持规则资源，检查不会通过。
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">未配置规则资源</p>
              )}
            </section>
          </section>
        ),
      )}
      <ActionButton onClick={onEditJSON} variant="outline">
        编辑转发设置
      </ActionButton>
    </div>
  );
}

import { connectorEditReason, updateServerConnector } from "./server-connector-editor";
import type { ServerProgram } from "./types";
type Connector = NonNullable<ServerProgram["connectors"]>[number];
type Result = { program?: ServerProgram; error?: string };
const targets: Record<string, string[]> = {
  "routeweaver/xray": ["26.3.27", "26.10.29", "26.10.31"],
  "routeweaver/sing-box": ["1.14.3", "1.14.4"],
};

function collectionShapeReason(program: ServerProgram) {
  for (const key of ["connectors", "rules", "resources", "principals", "egress"] as const) {
    const value = program[key];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))))
      return "连接器或策略列表格式无效，请在完整 JSON 中修正后继续。";
  }
  return undefined;
}

export function connectorCollectionEditReason(program: ServerProgram, schemaVersion: string) {
  const shapeReason = collectionShapeReason(program);
  if (shapeReason) return shapeReason;
  if (schemaVersion !== "1.0") return "此配置版本请使用完整 JSON 编辑。";
  if (program.instance.adapterId === "routeweaver/managed-xray" || program.listener.authentication === "principals" || program.principals?.length)
    return "此监听关联用户入口或托管计量，连接器集合仅供查看。";
  if (!targets[program.instance.adapterId]?.includes(program.instance.version)) return "此核心版本不支持连接器集合表单，请使用完整 JSON。";
  if (program.egress?.length) return "顺序出口不能与命名连接器混用，请先在完整 JSON 中明确转换。";
  for (const connector of program.connectors || []) {
    const reason = connectorEditReason(program, schemaVersion, connector.id);
    if (reason) return reason;
  }
  return undefined;
}

/** Explains why Add is unavailable before opening an isolated connection task. */
export function connectorAddReason(program: ServerProgram, schemaVersion: string) {
  const reason = connectorCollectionEditReason(program, schemaVersion);
  if (reason) return reason;
  const action = program.defaultAction;
  if (!action) return "添加命名连接器前，请明确选择默认去向。";
  if (extraKeys(action, ["kind", "ref"]) || (action.ref !== undefined && typeof action.ref !== "string") || !["direct", "reject", "forward"].includes(action.kind) ||
    (action.kind === "forward" ? !(program.connectors || []).some((item) => item.id === action.ref) : !!action.ref))
    return "默认去向无效，请明确选择直连、拒绝或已有连接器。";
  return undefined;
}

/** Requires an explicit existing default decision; adding never activates an unresolved target. */
export function addServerConnector(program: ServerProgram, schemaVersion: string, connector: Connector): Result {
  const reason = connectorAddReason(program, schemaVersion);
  if (reason) return { error: reason };
  const next = { ...program, connectors: [...(program.connectors || []), connector] };
  return updateServerConnector(next, schemaVersion, connector.id, {
    host: connector.connection?.host,
    port: String(connector.connection?.port ?? ""),
    via: connector.via || "",
  });
}

/** Names consumers without exposing any credential-bearing configuration. */
export function serverConnectorReferences(program: ServerProgram, id: string): string[] {
  const shapeReason = collectionShapeReason(program);
  if (shapeReason) return [shapeReason];
  const references: string[] = [];
  if (program.defaultAction?.ref === id) references.push("默认去向");
  for (const [index, rule] of (program.rules || []).entries()) if (rule?.action?.ref === id) references.push(`规则 ${index + 1}`);
  for (const [index, principal] of (program.principals || []).entries()) if (principal.action?.ref === id) references.push(`用户入口 ${index + 1}`);
  for (const [index, connector] of (program.connectors || []).entries()) if (connector.via === id) references.push(`连接器 ${index + 1} 的上游`);
  return references;
}
function extraKeys(value: object | undefined, known: string[]) {
  return !!value && Object.keys(value).some((key) => !known.includes(key));
}
function unknownConnection(c: ServerProgram["listener"]["connection"]) {
  return extraKeys(c, ["host", "port", "protocol", "username", "password", "method", "uuid", "flow", "packetEncoding", "vmessSecurity", "tls", "transport"]) ||
    extraKeys(c?.tls, ["enabled", "serverName", "fingerprint", "alpn", "reality"]) ||
    extraKeys(c?.tls?.reality, ["publicKey", "shortId"]) ||
    extraKeys(c?.transport, ["type", "path", "host", "serviceName", "headers", "authority"]);
}
function unknownCondition(match: ServerProgram["rules"][number]["match"]) {
  const queue = [match];
  const seen = new Set<object>();
  for (let index = 0; index < queue.length; index++) {
    const condition = queue[index];
    if (!condition || typeof condition !== "object" || seen.has(condition) || extraKeys(condition, ["op", "value", "children"]) ||
      !["domain", "domain-suffix", "ip-cidr", "resource", "and", "or", "not"].includes(condition.op)) return true;
    seen.add(condition);
    if (condition.children !== undefined) {
      if (!Array.isArray(condition.children)) return true;
      for (const child of condition.children) queue.push(child);
    }
  }
  return false;
}
function unknownReferences(program: ServerProgram) {
  if (extraKeys(program, ["instance", "listener", "egress", "rules", "resources", "tls", "defaultAction", "connectors", "principals", "destinationPolicy"])) return true;
  if (extraKeys(program.instance, ["id", "name", "hostId", "adapterId", "version"]) ||
    extraKeys(program.listener, ["revisionToken", "authentication", "id", "instanceId", "name", "connection"]) || unknownConnection(program.listener.connection) ||
    extraKeys(program.tls, ["certificatePem", "privateKeyPem", "certificatePath", "keyPath", "reality"]) ||
    extraKeys(program.tls?.reality, ["privateKey", "handshakeServer", "handshakePort", "shortIds", "serverNames"]) ||
    extraKeys(program.destinationPolicy, ["allowCidrs"])) return true;
  if (extraKeys(program.defaultAction, ["kind", "ref"]) || (program.defaultAction && !["direct", "reject", "forward"].includes(program.defaultAction.kind))) return true;
  for (const rule of program.rules || []) if (!rule?.action || extraKeys(rule, ["id", "match", "action"]) || extraKeys(rule.action, ["kind", "ref"]) || !["direct", "reject", "forward"].includes(rule.action.kind) || unknownCondition(rule.match)) return true;
  for (const resource of program.resources || []) if (extraKeys(resource, ["revisionToken", "acceptedVersion", "sizeBytes", "canRefresh", "acceptedAt", "refreshStatus", "lastRefreshError", "inspection", "id", "name", "ownerId", "revision", "digest", "format", "formatVersion", "behavior", "location", "path", "url", "visibility", "updatePolicy", "intervalSeconds"])) return true;
  for (const connector of program.connectors || []) if (extraKeys(connector, ["id", "connection", "via"]) || unknownConnection(connector.connection)) return true;
  return false;
}
export function removeServerConnector(program: ServerProgram, schemaVersion: string, id: string): Result {
  const reason = connectorCollectionEditReason(program, schemaVersion);
  if (reason) return { error: reason };
  if (!program.connectors?.some((connector) => connector.id === id)) return { error: "连接器不存在，请重新选择。" };
  const references = serverConnectorReferences(program, id);
  if (references.length) return { error: `此连接器仍被引用：${references.join("、")}。请先明确修改这些去向。` };
  if (unknownReferences(program)) return { error: "配置含有扩展参数，无法确认所有连接器引用；请在完整 JSON 中检查后移除。" };
  return { program: { ...program, connectors: program.connectors.filter((connector) => connector.id !== id) } };
}

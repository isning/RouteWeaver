import type { ServerProgram } from "./types";

type Connector = NonNullable<ServerProgram["connectors"]>[number];
export type ConnectorFields = { host: string; port: string; via: string };
const targets: Record<string, string[]> = {
  "routeweaver/xray": ["26.3.27", "26.10.29", "26.10.31"],
  "routeweaver/sing-box": ["1.14.3", "1.14.4"],
};

function graphError(connectors: Connector[]) {
  const ids = new Set<string>();
  for (const connector of connectors) {
    if (typeof connector.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(connector.id) ||
      ["rw-direct", "rw-reject"].includes(connector.id) || ids.has(connector.id))
      return "连接器身份无效或重复，请在完整 JSON 中修正。";
    if (connector.via !== undefined && typeof connector.via !== "string")
      return "上游连接器引用格式无效，请在完整 JSON 中修正。";
    ids.add(connector.id);
  }
  const byId = new Map(connectors.map((connector) => [connector.id, connector]));
  const completed = new Set<string>();
  for (const connector of connectors) {
    const visited = new Set<string>();
    let current: Connector | undefined = connector;
    while (current) {
      if (completed.has(current.id)) break;
      if (visited.has(current.id)) return "经由关系形成循环，请选择其他上游连接器。";
      visited.add(current.id);
      if (!current.via) break;
      const next: Connector | undefined = byId.get(current.via);
      if (!next) return "上游连接器不存在，请在完整 JSON 中修正引用。";
      current = next;
    }
    for (const id of visited) completed.add(id);
  }
  return undefined;
}

/** A bounded draft edit, never an application or compiler-validation result. */
export function connectorEditReason(program: ServerProgram, schemaVersion: string, id: string) {
  if (schemaVersion !== "1.0") return "此配置版本请使用完整 JSON 编辑。";
  if (program.instance.adapterId === "routeweaver/managed-xray" ||
    program.listener.authentication === "principals" || program.principals?.length)
    return "此监听关联用户入口或托管计量，连接器仅供查看。";
  if (!targets[program.instance.adapterId]?.includes(program.instance.version))
    return "此核心版本不支持连接器表单，请使用完整 JSON。";
  if (program.egress?.length) return "顺序出口请使用完整 JSON 编辑，不能与命名连接器混用。";
  const connectors = program.connectors || [];
  const graphReason = graphError(connectors);
  if (graphReason) return graphReason;
  const connector = connectors.find((item) => item.id === id);
  if (!connector) return "连接器不存在，请重新选择。";
  if (!connector.connection || !["socks", "shadowsocks", "vless", "trojan", "vmess"].includes(connector.connection.protocol))
    return "此协议尚不支持连接器表单，请使用完整 JSON。";
  return undefined;
}

function validHost(host: string) {
  if (typeof host !== "string" || !host || /[\s/\\@?#\[\]]/.test(host)) return false;
  if (!host.includes(":")) return true;
  // URL's IPv6 parser validates the literal; do not replace it with normalized output.
  try { return new URL(`http://[${host}]/`).hostname.startsWith("["); }
  catch { return false; }
}

export function updateServerConnector(
  program: ServerProgram,
  schemaVersion: string,
  id: string,
  fields: ConnectorFields,
): { program?: ServerProgram; error?: string } {
  const reason = connectorEditReason(program, schemaVersion, id);
  if (reason) return { error: reason };
  if (!validHost(fields.host)) return { error: "请输入主机名或 IP 地址，不含网址、空格或端口。" };
  if (!/^[0-9]+$/.test(fields.port) || Number(fields.port) < 1 || Number(fields.port) > 65535)
    return { error: "端口必须是 1 至 65535 的整数。" };
  const connectors = program.connectors!.map((connector) => {
    if (connector.id !== id) return connector;
    const next = { ...connector, connection: { ...connector.connection, host: fields.host, port: Number(fields.port) } };
    // Preserve an explicitly empty saved via unless the user changes it.
    if (fields.via !== (connector.via || "")) {
      if (fields.via) next.via = fields.via;
      else delete next.via;
    }
    return next;
  });
  const error = graphError(connectors);
  return error ? { error } : { program: { ...program, connectors } };
}

/** Invalid typed hosts remain in the parent's draft so navigation/save guards see them. */
export function connectorInputError(program: ServerProgram, schemaVersion: string) {
  for (const connector of program.connectors || []) {
    if (!connectorEditReason(program, schemaVersion, connector.id) && !validHost(connector.connection.host))
      return "连接器地址必须是主机名或 IP 地址，不含网址、空格或端口。";
  }
  return undefined;
}

export function updateServerConnectorVia(program: ServerProgram, schemaVersion: string, id: string, via: string): { program?: ServerProgram; error?: string } {
  const reason = connectorEditReason(program, schemaVersion, id);
  if (reason) return { error: reason };
  const connectors = program.connectors!.map((connector) => {
    if (connector.id !== id || via === (connector.via || "")) return connector;
    const next = { ...connector };
    if (via) next.via = via;
    else delete next.via;
    return next;
  });
  const error = graphError(connectors);
  return error ? { error } : { program: { ...program, connectors } };
}

/** Candidates depending on this connector cannot become its upstream. */
export function connectorViaChoices(program: ServerProgram, id: string) {
  const dependents = new Map<string, string[]>();
  for (const connector of program.connectors || []) {
    if (connector.via) dependents.set(connector.via, [...(dependents.get(connector.via) || []), connector.id]);
  }
  const blocked = new Set<string>([id]);
  const queue = [id];
  for (let index = 0; index < queue.length; index++) {
    for (const dependent of dependents.get(queue[index]) || []) {
      if (!blocked.has(dependent)) { blocked.add(dependent); queue.push(dependent); }
    }
  }
  return (program.connectors || []).map((connector) => ({
    value: connector.id,
    label: connector.id,
    disabled: blocked.has(connector.id),
    description: blocked.has(connector.id) ? "会形成连接器循环" : undefined,
  }));
}

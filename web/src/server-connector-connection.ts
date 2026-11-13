import { operationalInteger } from "./OperationalIntegerInput";
import type { Connection } from "./types";

type RecordValue = Record<string, unknown>;
export type ConnectorConnectionDraft = Omit<Connection, "port"> & { port: number | string };
const connectionKeys = ["host", "port", "protocol", "username", "password", "method", "uuid", "flow", "packetEncoding", "vmessSecurity", "tls", "transport"];
const tlsKeys = ["enabled", "serverName", "fingerprint", "alpn", "reality"];
const fieldLabels: Record<string, string> = { uuid: "UUID", flow: "VLESS 流控", packetEncoding: "数据包编码", tls: "TLS 参数", transport: "传输参数", path: "传输路径", host: "传输 Host", serviceName: "gRPC 服务名", headers: "请求头", authority: "gRPC authority" };
const transportKeys = ["type", "path", "host", "serviceName", "headers", "authority", "headerRows"];
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function connectionShapeReason(value: unknown, allowHeaderRows: boolean): string | undefined {
  const reason = "安全或传输参数的结构不能由此表单无损编辑，请在完整 JSON 中检查。";
  if (!isRecord(value)) return reason;
  const strings = (record: Record<string, unknown>, keys: string[]) => keys.every((key) => record[key] === undefined || typeof record[key] === "string");
  if (value.tls !== undefined) {
    if (!isRecord(value.tls)) return reason;
    const tls = value.tls;
    if ((tls.enabled !== undefined && typeof tls.enabled !== "boolean") || !strings(tls, ["serverName", "fingerprint"])) return reason;
    if (tls.alpn !== undefined && (!Array.isArray(tls.alpn) || tls.alpn.some((item) => typeof item !== "string"))) return reason;
    if (tls.reality !== undefined && (!isRecord(tls.reality) || !strings(tls.reality, ["publicKey", "shortId"]))) return reason;
  }
  if (value.transport !== undefined) {
    if (!isRecord(value.transport)) return reason;
    const transport = value.transport;
    if (!strings(transport, ["type", "path", "host", "serviceName", "authority"])) return reason;
    if (transport.headers !== undefined && (!isRecord(transport.headers) || Object.values(transport.headers).some((header) => typeof header !== "string"))) return reason;
    if (Object.prototype.hasOwnProperty.call(transport, "headerRows")) {
      if (!allowHeaderRows) return "连接器含有与请求头表单冲突的扩展参数，请在完整 JSON 中编辑。";
      if (!Array.isArray(transport.headerRows) || transport.headerRows.some((row) => !isRecord(row) || typeof row.name !== "string" || typeof row.value !== "string")) return reason;
    }
  }
  return undefined;
}

/** Read-only gate for source shapes that ConnectionFields would otherwise coerce. */
export function connectorConnectionShapeReason(connection: unknown): string | undefined {
  return connectionShapeReason(connection, false);
}

function unknownKeys(value: object | undefined, keys: string[]) {
  return !!value && Object.keys(value).some((key) => !keys.includes(key));
}

function preserveUnknown<T extends object>(original: object | undefined, draft: T, known: string[]): T {
  const next = { ...draft };
  for (const [key, value] of Object.entries(original || {})) {
    if (!known.includes(key)) Object.defineProperty(next, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return next;
}

/** Converts only explicit form decisions, preserving untouched nested metadata. */
export function prepareConnectorConnection(original: Connection, draft: ConnectorConnectionDraft): {
  connection?: Connection;
  removedFields: string[];
  error?: string;
} {
  const removedFields: string[] = [];
  const fail = (error: string) => ({ error, removedFields: [] });
  const shapeReason = connectorConnectionShapeReason(original) || connectionShapeReason(draft, true);
  if (shapeReason) return fail(shapeReason);
  const port = operationalInteger(draft.port, 1, 65535);
  if (port === undefined) return fail("端口范围为 1–65535，且必须是整数。");
  if (typeof draft.host !== "string" || !draft.host || /[\s/\\@?#\[\]]/.test(draft.host)) return fail("地址必须是主机名或 IP，不能是网址。");
  if (draft.host.includes(":")) {
    try { new URL(`http://[${draft.host}]/`); } catch { return fail("请输入有效的 IP 地址，不要附加端口。"); }
  }
  if (!["socks", "shadowsocks", "vless", "vmess", "trojan", "hysteria2"].includes(draft.protocol)) return fail("此协议请使用完整 JSON 编辑。");
  const next = preserveUnknown(original, { ...original, ...draft, port }, connectionKeys) as Connection;
  if (next.tls) {
    next.tls = preserveUnknown(original.tls, next.tls, tlsKeys);
    if (next.tls.reality) next.tls.reality = preserveUnknown(original.tls?.reality, next.tls.reality, ["publicKey", "shortId"]);
  }
  if (next.transport) next.transport = preserveUnknown(original.transport, next.transport, transportKeys);
  const remove = (object: object, key: string, label: string) => {
    const record = object as RecordValue;
    if (key !== "headerRows" && record[key] !== undefined && record[key] !== "") removedFields.push(label);
    delete record[key];
  };
  const protocolChanged = original.protocol !== draft.protocol;
  const transportChanged = (original.transport?.type || "tcp") !== (next.transport?.type || "tcp");
  const unknownSecurity = unknownKeys(original.tls, tlsKeys) || unknownKeys(original.tls?.reality, ["publicKey", "shortId"]);
  const tlsDisabled = original.tls?.enabled && Object.prototype.hasOwnProperty.call(draft, "tls") && !draft.tls?.enabled;
  const tlsRemoved = !!original.tls && !next.tls;
  const transportRemoved = !!original.transport && !next.transport;
  if (tlsRemoved && unknownSecurity) return fail("TLS 含有扩展参数，无法安全移除；请使用完整 JSON。");
  if (transportRemoved && unknownKeys(original.transport, transportKeys)) return fail("传输设置含有扩展参数，无法安全移除；请使用完整 JSON。");
  if (tlsRemoved) removedFields.push("TLS 参数");
  if (transportRemoved) removedFields.push("传输参数");
  if (protocolChanged && unknownKeys(original, connectionKeys)) return fail("连接中含有扩展参数，无法安全切换协议；请在完整 JSON 中处理这些参数。");
  if (transportChanged && unknownKeys(original.transport, transportKeys)) return fail("传输设置含有扩展参数，无法安全切换传输方式；请使用完整 JSON。");
  if (tlsDisabled && unknownSecurity) return fail("TLS 含有扩展参数，无法安全关闭；请使用完整 JSON。");
  // SecurityModePicker intentionally clears REALITY when switching to ordinary TLS.
  if (original.tls?.reality && !next.tls?.reality) {
    if (unknownKeys(original.tls.reality, ["publicKey", "shortId"])) return fail("REALITY 含有扩展参数，无法安全移除；请使用完整 JSON。");
    removedFields.push("REALITY 参数");
  }
  if (protocolChanged) {
    const secured = ["vless", "vmess", "trojan", "hysteria2"].includes(next.protocol);
    if (!secured) {
      if (unknownSecurity || unknownKeys(next.transport, transportKeys)) return fail("安全或传输设置含有扩展参数，无法安全切换此协议；请使用完整 JSON。");
      for (const key of ["uuid", "flow", "packetEncoding", "tls", "transport"]) remove(next, key, fieldLabels[key] || key);
    } else {
      remove(next, "username", "用户名"); remove(next, "method", "加密方法");
      if (!["trojan", "hysteria2"].includes(next.protocol)) remove(next, "password", "密码");
      if (next.protocol !== "vless") { remove(next, "flow", "VLESS 流控"); remove(next, "packetEncoding", "数据包编码"); }
      if (["trojan", "hysteria2"].includes(next.protocol)) remove(next, "uuid", "UUID");
      if (next.protocol !== "vless" && next.tls?.reality) {
        if (unknownKeys(next.tls.reality, ["publicKey", "shortId"])) return fail("REALITY 含有扩展参数，无法安全切换协议；请使用完整 JSON。");
        remove(next.tls, "reality", "REALITY 参数");
      }
    }
    if (next.protocol !== "vmess") remove(next, "vmessSecurity", "VMess 加密");
    if (next.protocol === "socks") remove(next, "method", "加密方法");
    if (next.protocol === "shadowsocks") remove(next, "username", "用户名");
  }
  if (tlsDisabled && next.tls) remove(next, "tls", "TLS 参数");
  if (transportChanged && next.transport) {
    const allowed = next.transport.type === "tcp" ? ["type"] : next.transport.type === "grpc" ? ["type", "serviceName", "authority"] : ["type", "path", "host", "headers", "headerRows"];
    for (const key of transportKeys) if (!allowed.includes(key)) remove(next.transport, key, fieldLabels[key] || key);
  }
  // Header rows are UI state, not a transport extension or exported credential store.
  const transport = next.transport as (NonNullable<Connection["transport"]> & { headerRows?: { name: string; value: string }[] }) | undefined;
  if (transport?.headerRows) {
    const headers: Record<string, string> = {};
    for (const row of transport.headerRows) {
      if (!row.name || row.name.trim() !== row.name || /[\r\n]/.test(row.name + row.value) || Object.keys(headers).some((key) => key.toLowerCase() === row.name.toLowerCase()))
        return fail("请求头名称不能留空、重复或包含空格边界与换行。");
      Object.defineProperty(headers, row.name, { value: row.value, enumerable: true, configurable: true, writable: true });
    }
    if (Object.keys(headers).length || original.transport?.headers !== undefined) transport.headers = headers;
    else delete transport.headers;
    delete transport.headerRows;
  }
  return { connection: next, removedFields: [...new Set(removedFields)] };
}

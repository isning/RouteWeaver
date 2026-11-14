import type { NodeRecord } from "./types";

const optionalStrings = [
  "username",
  "password",
  "method",
  "region",
  "uuid",
  "flow",
  "vmessSecurity",
  "packetEncoding",
  "coreId",
  "coreVersion",
] as const;
const nodeKeys = [
  "id",
  "name",
  "host",
  "port",
  "protocol",
  "status",
  ...optionalStrings,
  "tags",
  "tls",
  "transport",
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysWithin = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const optionalText = (
  value: Record<string, unknown>,
  keys: readonly string[],
) =>
  keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === "string");

/** Only fields persisted by domain.Node. The caller first normalizes the form's
 * connection intent; shared editor defaults such as enabled are not Node data. */
export function nodeCreationSnapshot(value: NodeRecord): NodeRecord {
  return structuredClone({
    ...Object.fromEntries(
      nodeKeys
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, value[key]]),
    ),
    status: "unregistered",
  }) as NodeRecord;
}

/** Validate the complete persisted DTO before comparing it. Do not run the
 * editor's protocol normalizer on a receipt: that could erase a real difference.
 * Empty omitempty values and map ordering follow Go's wire representation. */
export function readNodeRecord(value: unknown): NodeRecord | null {
  if (
    !object(value) ||
    !keysWithin(value, [...nodeKeys, "$schema"]) ||
    !optionalText(value, [...optionalStrings, "$schema"]) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.host !== "string" ||
    !value.host ||
    !Number.isInteger(value.port) ||
    Number(value.port) < 1 ||
    Number(value.port) > 65535 ||
    typeof value.protocol !== "string" ||
    ![
      "socks",
      "shadowsocks",
      "vless",
      "trojan",
      "vmess",
      "hysteria2",
      "anytls",
    ].includes(value.protocol) ||
    typeof value.status !== "string" ||
    !value.status ||
    (value.tags !== undefined && !strings(value.tags))
  )
    return null;
  const result: NodeRecord = {
    id: value.id,
    name: value.name,
    host: value.host,
    port: value.port as number,
    protocol: value.protocol,
    status: value.status,
  };
  for (const key of optionalStrings)
    if (value[key]) result[key] = value[key] as string;
  if (strings(value.tags) && value.tags.length) result.tags = [...value.tags];
  if (value.tls !== undefined) {
    const tls = value.tls;
    if (
      !object(tls) ||
      !keysWithin(tls, [
        "enabled",
        "serverName",
        "fingerprint",
        "alpn",
        "reality",
      ]) ||
      typeof tls.enabled !== "boolean" ||
      !optionalText(tls, ["serverName", "fingerprint"]) ||
      (tls.alpn !== undefined && !strings(tls.alpn))
    )
      return null;
    result.tls = { enabled: tls.enabled };
    if (tls.serverName) result.tls.serverName = tls.serverName as string;
    if (tls.fingerprint) result.tls.fingerprint = tls.fingerprint as string;
    if (strings(tls.alpn) && tls.alpn.length) result.tls.alpn = [...tls.alpn];
    if (tls.reality !== undefined) {
      const reality = tls.reality;
      if (
        !object(reality) ||
        !keysWithin(reality, ["publicKey", "shortId"]) ||
        typeof reality.publicKey !== "string" ||
        typeof reality.shortId !== "string"
      )
        return null;
      result.tls.reality = {
        publicKey: reality.publicKey,
        shortId: reality.shortId,
      };
    }
  }
  if (value.transport !== undefined) {
    const transport = value.transport;
    const textKeys = ["path", "host", "serviceName", "authority"] as const;
    if (
      !object(transport) ||
      !keysWithin(transport, ["type", ...textKeys, "headers"]) ||
      typeof transport.type !== "string" ||
      !["tcp", "ws", "httpupgrade", "grpc"].includes(transport.type) ||
      !optionalText(transport, textKeys)
    )
      return null;
    result.transport = { type: transport.type };
    for (const key of textKeys)
      if (transport[key]) result.transport[key] = transport[key] as string;
    if (transport.headers !== undefined) {
      const headers = transport.headers;
      if (
        !object(headers) ||
        !Object.values(headers).every((entry) => typeof entry === "string")
      )
        return null;
      const entries = Object.entries(headers).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      if (entries.length)
        result.transport.headers = Object.fromEntries(entries) as Record<
          string,
          string
        >;
    }
  }
  return result;
}

export function sameCreatedNode(
  submitted: NodeRecord,
  current: NodeRecord,
): boolean {
  const expected = readNodeRecord(submitted),
    observed = readNodeRecord(current);
  return (
    !!expected &&
    !!observed &&
    JSON.stringify(expected) === JSON.stringify(observed)
  );
}

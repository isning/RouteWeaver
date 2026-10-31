import type { Profile, PipelineStep, ClientNode, Group } from "./types";
export const newID = (prefix = "item") =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
export function bytesLabel(bytes: number | undefined) {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes,
    i = 0;
  while (Math.abs(n) >= 1024 && i < 4) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("zh-CN", { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
/** Decimal network rate; policy storage is bytes per second. */
export function bitrateLabel(bytesPerSecond: number | undefined) {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond))
    return "—";
  return `${(bytesPerSecond / 125000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} Mbps`;
}
export function dateLabel(value?: string, timezone = "Asia/Shanghai") {
  if (!value || value.startsWith("0001")) return "未设置";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "未设置"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone === "UTC+8" ? "Asia/Shanghai" : timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
}
export function resetCountdown(value?: string, now = Date.now()) {
  if (!value) return null;
  const left = new Date(value).getTime() - now;
  if (!Number.isFinite(left) || left < 0) return null;
  const days = Math.floor(left / 86400000),
    hours = Math.floor((left % 86400000) / 3600000);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}
export function moveItem<T>(items: T[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length)
    return items;
  const copy = [...items];
  copy.splice(to, 0, copy.splice(from, 1)[0]);
  return copy;
}
export function emptyProfile(): Profile {
  const id = newID("profile");
  return {
    id,
    name: "",
    target: { adapterId: "mihomo", version: "1.19.32" },
    mode: "full",
    sourceIds: [],
    ir: {
      schemaVersion: "1.0",
      id,
      name: "",
      ownerId: "",
      revision: "1",
      endpoints: [],
      groups: [],
      rules: [],
      resources: [],
      defaultAction: { kind: "direct" },
      runtime: {
        mixedPort: 7890,
        dns: {
          servers: [{ id: "dns1", type: "tls", address: "1.1.1.1", port: 853 }],
          final: "dns1",
        },
        sniff: false,
        tun: { enabled: false, addresses: ["172.19.0.1/30"], autoRoute: true },
      },
    },
  };
}
export function newStep(kind: string): PipelineStep {
  return {
    id: newID("step"),
    kind,
    enabled: true,
    filter: {},
    template: "{name}",
    sortBy: "name",
  };
}
export function groupErrors(groups: Group[]): string[] {
  const errors: string[] = [];
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) {
      errors.push("策略组不能循环引用。");
      return;
    }
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    const next = new Set(path).add(id);
    group.members
      .filter((m) => m.kind === "group")
      .forEach((m) => visit(m.ref || "", next));
  };
  groups.forEach((g) => {
    if (!g.name.trim()) errors.push("请为策略组命名。");
    if (!g.members.length && !g.dynamic)
      errors.push(
        `「${g.name || "新策略组"}」：请添加固定成员或开启自动加入连接。`,
      );
    visit(g.id, new Set());
  });
  return [...new Set(errors)];
}
export function stableNodeLabel(node: ClientNode, nodes: ClientNode[]) {
  const duplicates = nodes.filter((n) => n.name === node.name);
  return duplicates.length > 1
    ? `${node.name} · ${node.provenance?.[0]?.sourceId || node.region || node.id.slice(-6)}`
    : node.name;
}
export function redact(content: string) {
  return content
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[私钥已隐藏]",
    )
    .replace(
      /("(?:password|pass|uuid|token|private_key|privateKey|privateKeyPem|username|user|id|short_id|shortId)"\s*:\s*")[^"\\]*(?:\\.[^"\\]*)*(")/gi,
      "$1••••••$2",
    )
    .replace(/(password:\s*)[^\n]+/gi, "$1••••••");
}
export const actionValue = (action: { kind: string; ref?: string }) =>
  action.ref ? `${action.kind}:${action.ref}` : action.kind;
export const parseAction = (value: string) => {
  const separator = value.indexOf(":");
  return separator < 0
    ? { kind: value }
    : { kind: value.slice(0, separator), ref: value.slice(separator + 1) };
};

export function diagnosticText(
  value: string | { message?: string; code?: string; line?: number },
) {
  return typeof value === "string"
    ? value
    : [
        value.line ? `第 ${value.line} 行` : "",
        value.message || value.code || "导入需要检查",
      ]
        .filter(Boolean)
        .join("：");
}

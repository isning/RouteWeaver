import type { MatchExpression, RuleResource, ServerProgram } from "./types";

export const conditionDepthLimit = 128;
export const leafConditionOptions = [
  { value: "domain", label: "完整域名" },
  { value: "domain-suffix", label: "域名后缀" },
  { value: "ip-cidr", label: "IP 网段" },
];
const leafOps = leafConditionOptions.map((option) => option.value);
export function conditionTargetSupported(program: ServerProgram, schemaVersion: string) {
  return schemaVersion === "1.0" && (program.principals == null || (Array.isArray(program.principals) && program.principals.length === 0)) &&
    program.listener?.authentication !== "principals" && (program.egress == null || (Array.isArray(program.egress) && program.egress.length === 0)) &&
    ((program.instance.adapterId === "routeweaver/sing-box" && ["1.14.3", "1.14.4"].includes(program.instance.version)) ||
      (program.instance.adapterId === "routeweaver/xray" && ["26.3.27", "26.10.29", "26.10.31"].includes(program.instance.version)));
}
export const hasStructuredConditions = (program: ServerProgram) => program.instance.adapterId === "routeweaver/sing-box";

// Shape checks protect extension data. Value errors remain editable.
export function knownConditionShape(match: MatchExpression): boolean {
  if (!match || typeof match !== "object" || Array.isArray(match) ||
    Object.keys(match).some((key) => !["op", "value", "children"].includes(key))) return false;
  if (["and", "or", "not"].includes(match.op))
    return (match.value === undefined || match.value === "") && Array.isArray(match.children);
  return [...leafOps, "resource"].includes(match.op) && typeof match.value === "string" &&
    (match.children === undefined || (Array.isArray(match.children) && match.children.length === 0));
}
export function conditionEditable(program: ServerProgram, schemaVersion: string, match: MatchExpression) {
  return conditionTargetSupported(program, schemaVersion) && knownConditionShape(match) &&
    (hasStructuredConditions(program) || leafOps.includes(match.op)) &&
    (match.op !== "resource" || selectableConditionResources(program).length > 0);
}
// Only wholly understood subtrees may be removed or unwrapped through the form.
export function understoodConditionTree(match: MatchExpression, depth = 0): boolean {
  return depth <= conditionDepthLimit && knownConditionShape(match) &&
    (match.children || []).every((child) => understoodConditionTree(child, depth + 1));
}
export function conditionTreeDepth(match: MatchExpression, depth = 0): number {
  if (depth > conditionDepthLimit) return depth;
  if (!knownConditionShape(match)) return conditionDepthLimit + 1;
  return (match.children || []).reduce((max, child) => Math.max(max, conditionTreeDepth(child, depth + 1)), depth);
}

// Existing descriptors only. No resource creation, URL changes, or implicit acceptance.
export function selectableConditionResources(program: ServerProgram): RuleResource[] {
  return (Array.isArray(program.resources) ? program.resources : []).filter((resource, _, all) => {
    if (!resource || typeof resource !== "object" ||
      typeof resource.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(resource.id) ||
      all.filter((other) => other?.id === resource.id).length !== 1 || resource.ownerId ||
      !["sing-box-source", "srs"].includes(resource.format) ||
      !Number.isInteger(resource.formatVersion) || resource.formatVersion! < 1 || resource.formatVersion! > 5 ||
      typeof resource.revision !== "string" || !resource.revision || !/^sha256:[0-9a-f]{64}$/.test(resource.digest) ||
      ![undefined, "", "private", "public"].includes(resource.visibility) ||
      !["pinned", "follow"].includes(resource.updatePolicy)) return false;
    if (resource.location === "local") {
      const path = resource.path;
      return typeof path === "string" && !!path && !resource.url && !path.startsWith("/") &&
        !path.includes("\\") && path.split("/").every((part) => !!part && part !== "." && part !== "..");
    }
    if (resource.location !== "remote" || resource.path || resource.updatePolicy !== "follow" ||
      !Number.isInteger(resource.intervalSeconds) || resource.intervalSeconds! < 1) return false;
    try {
      const url = new URL(resource.url || "");
      return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.hash;
    } catch { return false; }
  });
}

export function leafConditionError(match: MatchExpression) {
  const value = match.value || "";
  if (!value) return "请输入条件值。";
  if (match.op !== "ip-cidr")
    return /[ ,\t\r\n/:()[\]]/.test(value) ? "请输入单个域名，不含空白、端口或网址前缀。" : undefined;
  const parts = value.split("/");
  const ipv4 = (address: string) => {
    const octets = address.split(".");
    return octets.length === 4 && octets.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
  };
  const ipv6 = (address: string) => {
    if (!/^[0-9a-fA-F:.]+$/.test(address)) return false;
    let groups = address;
    if (address.includes(".")) {
      const split = address.lastIndexOf(":");
      if (split < 0 || !ipv4(address.slice(split + 1))) return false;
      groups = address.slice(0, split + 1) + "0:0";
    }
    const halves = groups.split("::");
    if (halves.length > 2) return false;
    const words = halves.flatMap((half) => half ? half.split(":") : []);
    if (!words.every((word) => /^[0-9a-fA-F]{1,4}$/.test(word))) return false;
    return halves.length === 2 ? words.length < 8 : words.length === 8;
  };
  const valid = parts.length === 2 && /^(0|[1-9][0-9]*)$/.test(parts[1]) &&
    (ipv4(parts[0]) ? Number(parts[1]) <= 32 : ipv6(parts[0]) && Number(parts[1]) <= 128);
  return valid ? undefined : "请输入有效的 IP 网段，例如 192.0.2.0/24 或 2001:db8::/32。";
}

export function conditionInputError(program: ServerProgram, schemaVersion: string, match: MatchExpression): string | undefined {
  if (!conditionTargetSupported(program, schemaVersion)) return undefined;
  const resources = selectableConditionResources(program);
  function visit(node: MatchExpression, depth: number): string | undefined {
    if (depth > conditionDepthLimit) return "条件嵌套超过 128 层，请减少分组。";
    // Uninterpreted saved content is preserved; the server remains authoritative.
    if (!knownConditionShape(node)) return undefined;
    if (!hasStructuredConditions(program) && !leafOps.includes(node.op)) return undefined;
    if (["and", "or", "not"].includes(node.op)) {
      if (!node.children?.length) return "请为分组添加条件。";
      if (node.op === "not" && node.children.length !== 1) return "取反必须包含一个条件，请在完整 JSON 中修复。";
      for (const child of node.children) {
        const error = visit(child, depth + 1);
        if (error) return error;
      }
      return undefined;
    }
    if (node.op === "resource" && resources.length === 0) return undefined;
    if (node.op === "resource") return resources.some((resource) => resource.id === node.value) ? undefined : "请选择此监听已有且受支持的规则资源。";
    return leafConditionError(node);
  }
  return visit(match, 0);
}

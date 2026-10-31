import type { Source } from "./types";

const knownStatuses = new Set([
  "failed",
  "accepted",
  "unchanged",
  "paused",
  "review-required",
  "rejected",
]);
export function sourceStatusUnknown(source?: Source | null): boolean {
  return !!source?.refreshStatus && !knownStatuses.has(source.refreshStatus);
}
// A known status outranks stale error fields. Legacy records without a status
// only count as failures when they carry an error; code alone is not evidence.
export function sourceHasFailure(source?: Source | null): boolean {
  if (!source) return false;
  if (source.refreshStatus) return source.refreshStatus === "failed";
  return !!source.lastError;
}
const messages = new Map<string, string>([
  [
    "source_url_not_allowed",
    "无法使用此订阅地址。请使用公网可访问的 HTTPS 订阅链接。",
  ],
  [
    "source_address_not_public",
    "订阅地址指向内网或保留地址，无法获取。请改用公开可访问的 HTTPS 订阅地址。",
  ],
  ["source_fetch_failed", "未能获取订阅内容。请检查链接是否有效，然后重试。"],
  ["source_fetch_timeout", "获取订阅内容超时。请稍后重试。"],
  [
    "source_content_too_large",
    "订阅内容过大，无法导入。请减少内容后重新导入。",
  ],
  ["source_parse_failed", "订阅内容未能导入。请检查格式和连接设置后重试。"],
  ["source_import_incomplete", "订阅未能完整导入。请检查内容后重试。"],
]);
export function sourceFailureText(source?: Source | null): string | null {
  if (!sourceHasFailure(source)) return null;
  // Do not interpolate lastError or unknown codes, and never use prototype keys.
  return (
    (source?.refreshStatus === "failed"
      ? messages.get(source.lastErrorCode || "")
      : undefined) || "导入未完成。请检查来源设置和内容后重试。"
  );
}

export function sourceIssueText(source?: Source | null): string | null {
  return sourceStatusUnknown(source)
    ? "暂时无法确认来源状态。请重新打开来源后再试。"
    : sourceFailureText(source);
}

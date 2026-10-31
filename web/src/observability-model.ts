export const byteUnits = {
  bytes: 1n,
  GB: 1000000000n,
  TB: 1000000000000n,
  GiB: 1073741824n,
  TiB: 1099511627776n,
};
export function measuredBytes(amount: string, unit: string): number {
  const normalized = amount.trim();
  if (
    normalized.length > 128 ||
    !/^\d+(?:\.\d+)?$/.test(normalized) ||
    !(unit in byteUnits)
  )
    throw new Error("请输入非负用量，并选择明确单位。");
  const [whole, fractional = ""] = normalized.split(".");
  const denominator = 10n ** BigInt(fractional.length);
  const numerator =
    BigInt(whole + fractional) * byteUnits[unit as keyof typeof byteUnits];
  if (numerator % denominator)
    throw new Error("用量必须可以换算为整数个字节。");
  const bytes = numerator / denominator;
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("用量超出网页可精确提交的整数范围，请缩小数值。");
  return Number(bytes);
}
export function observationStatus(
  observedAt: string | null | undefined,
  now = Date.now(),
) {
  if (!observedAt) return "尚未收到观测";
  const age = now - Date.parse(observedAt);
  return Number.isFinite(age) && age >= -60000 && age <= 15 * 60000
    ? "最近观测"
    : "较早的观测";
}
export interface ProviderConfig {
  name: string;
  mode: "limited" | "unlimited";
  allowance: number;
  unit: string;
  cycleId?: string;
  cycleStart?: string;
  cycleEnd?: string;
  expiresAt?: string;
  notificationSource: "none" | "provider_statement" | "nic_estimate";
  exhaustionAction: "advisory";
}
export interface ObservationConfig {
  revision: number;
  observerInstanceId: string;
  billedInterfaces: string[];
  provider: ProviderConfig | null;
}
export interface NodeSnapshot {
  digest: string;
  observedAt: string;
  receivedAt: string;
  source: string;
  continuity: string;
  cpuPercent: number | null;
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
  metrics: {
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    load1: number;
    load5: number;
    load15: number;
    interfaces: { name: string; receiveBytes: number; transmitBytes: number }[];
  };
}
export interface NodeObservationView {
  nodeId: string;
  config: ObservationConfig;
  latest: NodeSnapshot | null;
  provider: {
    source: string;
    coverage: string;
    statusReason: string;
    fresh: boolean;
    observedAt: string | null;
    observedSince: string | null;
    observedNicBytes: number;
    totalBytes: number | null;
    usedBytes: number | null;
    remainingBytes: number | null;
    exhaustionAction: string;
    notificationEligible: boolean;
  };
  statement?: {
    cycleId: string;
    usedBytes: number;
    observedAt: string;
    reference: string;
  } | null;
  baseline?: {
    cycleId: string;
    usedBytes: number;
    observedAt: string;
    reason: string;
  } | null;
}
export const observationPath = (nodeId: string) =>
  `/admin/nodes/${nodeId}/observability`;
export const sourceLabel = (source: string) =>
  ({
    provider_statement: "供应商账单 · 手工录入",
    nic_estimate: "网卡 IN + OUT 估算",
    none: "未选择",
  })[source] || source;
export const reasonLabel = (reason: string) =>
  ({
    provider_not_configured: "尚未登记供应商周期与额度。",
    initial_observation_requires_baseline:
      "已经收到首个样本。核对本周期已用后，才能估算剩余额度。",
    configuration_changed_requires_baseline:
      "采集范围或周期已更换，请重新核对本周期已用。",
    observer_stream_changed: "采集来源已重新接入，请核对中断期间的用量。",
    node_restarted: "服务器计数已重启，请核对中断期间的用量。",
    observation_sequence_gap: "采样记录有间断，请重新核对用量。",
    observation_interval_gap: "采样间隔较长，请重新核对用量。",
    selected_interface_missing:
      "选中的计费网卡没有出现在最新采样中，请检查采集范围。",
    selected_interface_counter_reset: "选中的网卡计数已重置，请重新核对用量。",
    billed_interfaces_not_selected: "请明确选择供应商计费网卡。",
    cycle_boundary_requires_reconciliation:
      "已跨越配置周期，请登记当前周期并重新核对。",
    configured_cycle_not_current: "显示的是非当前周期，请检查周期起止时间。",
    provider_statement_required: "请录入当前周期的供应商账单用量。",
    operator_entered_provider_statement: "用量来自管理员录入的供应商账单。",
    operator_reconciled_nic_estimate:
      "已核对基线，随后累加所选网卡的连续 IN + OUT。",
    operator_configured_unlimited: "管理员已将供应商额度设为不限量。",
  })[reason] || reason;
export const localDateInput = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (d.getUTCFullYear() <= 1) return "";
  return Number.isFinite(d.getTime())
    ? new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
};

/** Minute-resolution controls must not rewrite untouched provider timestamps. */
export function providerTimestamp(
  value: string | undefined,
  original?: string,
) {
  if (!value) return undefined;
  if (original && value === localDateInput(original)) return original;
  return new Date(value).toISOString();
}

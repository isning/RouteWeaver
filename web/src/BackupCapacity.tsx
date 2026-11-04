import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ActionButton } from "@/ui-patterns/actions";
import { Notice } from "@/ui-patterns/notice";
import { ErrorNotice } from "./components";
import { request } from "./api";
import { bytesLabel, dateLabel } from "./model";

type Count = { count: number; limit: number; atLeast: boolean; warning: boolean; exceeded: boolean };
export type HistoryCapacity = {
  checkedAt: string;
  notificationRebuildChunkRows?: number;
  backupRows: Count;
  backupRecordPlaintextBytes: Count;
  backupLargestRecordBytes: Count;
  notificationLedgerRows: Count;
  notificationLargestLedgerCiphertextBytes: Count;
  notificationLedgerCiphertextBytes: Count;
  archiveByteLimit: number;
  archiveBytes: number | null;
  databaseFileBytes: number | null;
  filesystemAvailableBytes: number | null;
  warningPercent: number;
};

export function BackupCapacity({ primaryAction }: { primaryAction?: ReactNode }) {
  const check = useMutation({ mutationFn: () => request<HistoryCapacity>("/admin/backups/capacity") });
  const value = check.isSuccess ? check.data : undefined;
  const warning = value && [value.backupRows, value.backupRecordPlaintextBytes, value.backupLargestRecordBytes, value.notificationLedgerRows, value.notificationLargestLedgerCiphertextBytes, value.notificationLedgerCiphertextBytes].some(v => v.warning);
  const count = (v: Count) => `${v.atLeast ? "至少 " : ""}${v.count.toLocaleString()} / ${v.limit.toLocaleString()}`;
  return <div className="space-y-3">
    <div role="group" aria-label="备份操作" className="flex flex-wrap items-center gap-2">
      {primaryAction}
      <ActionButton variant="outline" onClick={() => check.mutate()} pending={check.isPending}>检查历史容量</ActionButton>
    </div>
    {check.isError && <ErrorNotice error={check.error} />}
    {value && <div className="space-y-3 text-sm" aria-live="polite">
      <p className="text-muted-foreground">检查时间：{dateLabel(value.checkedAt)}</p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div><dt>完整备份记录数</dt><dd>{count(value.backupRows)}</dd></div>
        <div><dt>通知重建账本总行数</dt><dd>{count(value.notificationLedgerRows)}</dd></div>
        <div><dt>通知重建密文总量</dt><dd>{value.notificationLedgerCiphertextBytes.atLeast ? "至少 " : ""}{bytesLabel(value.notificationLedgerCiphertextBytes.count)} / {bytesLabel(value.notificationLedgerCiphertextBytes.limit)}</dd></div>
        <div><dt>已存记录正文（参考值）</dt><dd>{value.backupRecordPlaintextBytes.atLeast ? "至少 " : ""}{bytesLabel(value.backupRecordPlaintextBytes.count)} / {bytesLabel(value.backupRecordPlaintextBytes.limit)}</dd></div>
        <div><dt>最大记录正文</dt><dd>{value.backupLargestRecordBytes.atLeast ? "至少 " : ""}{bytesLabel(value.backupLargestRecordBytes.count)} / {bytesLabel(value.backupLargestRecordBytes.limit)}</dd></div>
        <div><dt>通知冷重建最大密文记录</dt><dd>{value.notificationLargestLedgerCiphertextBytes.atLeast ? "至少 " : ""}{bytesLabel(value.notificationLargestLedgerCiphertextBytes.count)} / {bytesLabel(value.notificationLargestLedgerCiphertextBytes.limit)}</dd></div>
        <div><dt>完整归档大小</dt><dd>尚未生成；上限 {bytesLabel(value.archiveByteLimit)}</dd></div>
        <div><dt>数据库与日志文件</dt><dd>{value.databaseFileBytes == null ? "未知" : bytesLabel(value.databaseFileBytes)}</dd></div>
        <div><dt>数据库所在文件系统可用空间</dt><dd>{value.filesystemAvailableBytes == null ? "未知" : bytesLabel(value.filesystemAvailableBytes)}</dd></div>
      </dl>
      {value.notificationRebuildChunkRows != null && <p className="text-muted-foreground">通知用量按每步最多 {value.notificationRebuildChunkRows.toLocaleString()} 条重建。账本总量超出单步预算会增加所需步骤，完成前用量仍未知。</p>}
      {warning && <Notice tone="warning" title={`历史容量已达到 ${value.warningPercent}% 提醒线`}>
        暂停扩容，尽快创建并验证完整备份，核对磁盘余量与历史保存方案。超过归档或单条记录上限会阻止备份或重建；通知账本总量则分步处理。备份仅创建副本，当前数据库保持原样。
      </Notice>}
      <p className="text-muted-foreground">记录数与正文大小不保证归档可创建。请另查备份临时目录与恢复目标的空间；本检查仅查看容量，保留现有服务状态与历史数据。</p>
    </div>}
  </div>;
}

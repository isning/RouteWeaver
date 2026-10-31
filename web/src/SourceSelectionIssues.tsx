import { ActionButton } from "@/ui-patterns/actions";
import type { ReactNode } from "react";
import type { Source } from "./types";

// Availability of an existing reference is not new-import readiness. An enabled
// accepted snapshot remains usable while a newer import fails or awaits review.
export function sourceSelectionIssue(source: Source) {
  if (source.enabled === false) return "已暂停";
  if (source.enabled !== true || source.snapshot) return null;
  if (source.candidate) return "导入内容待应用";
  if (source.lastError || source.refreshStatus === "failed")
    return "导入未完成，尚无可用节点";
  return "尚无可用节点";
}
export function sourceSelectionLabel(source: Source, checked: boolean) {
  const state =
    !checked || typeof source.enabled !== "boolean"
      ? "状态待核对"
      : sourceSelectionIssue(source);
  return state ? `${source.name} · ${state}` : source.name;
}
export function SourceSelectionIssues({
  sources,
  onRepair,
  onRepairButtonRef,
  onRemove,
  removeCollection,
}: {
  sources: Source[];
  onRepair: (source: Source, trigger: HTMLElement) => void;
  /** Allows an owning task to restore this source's action after remount. */
  onRepairButtonRef?: (
    sourceID: string,
    button: HTMLButtonElement | null,
  ) => void;
  onRemove?: (source: Source) => void;
  removeCollection?: ReactNode;
}) {
  if (!sources.length) return null;
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-label="需要处理的来源"
    >
      <ul className="space-y-3">
        {sources.map((source) => (
          <li
            key={source.id}
            className="flex min-w-0 flex-col items-start justify-between gap-3 text-sm sm:flex-row sm:items-center"
          >
            <span className="min-w-0 wrap-anywhere">
              {source.name} · {sourceSelectionIssue(source)}
            </span>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <ActionButton
                ref={(button) => {
                  onRepairButtonRef?.(source.id, button);
                }}
                size="sm"
                variant="outline"
                aria-label={`${source.enabled && source.candidate ? "检查导入" : "编辑来源"} ${source.name}`}
                onKeyDown={(event) => {
                  if (
                    event.repeat &&
                    (event.key === "Enter" || event.key === " ")
                  )
                    event.preventDefault();
                }}
                onClick={(event) => onRepair(source, event.currentTarget)}
              >
                {source.enabled && source.candidate ? "检查导入" : "编辑来源"}
              </ActionButton>
              {onRemove && (
                <ActionButton
                  size="sm"
                  variant="outline"
                  aria-label={`移除来源 ${source.name}`}
                  onClick={() => onRemove(source)}
                >
                  移除
                </ActionButton>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>
          {removeCollection
            ? "保存或预览前，请先处理来源或移除所选集合。"
            : "保存或预览前，请先处理或移除以上来源。"}
        </span>
        {removeCollection}
      </div>
    </section>
  );
}

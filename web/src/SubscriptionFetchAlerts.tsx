import { TaskDialog } from "@/ui-patterns/task-overlays";
import { useEffect, useRef, useState } from "react";
import { QueryState } from "./components";
import { useConfirm } from "@/ui-patterns/confirmations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "./api";
import { ActionButton } from "@/ui-patterns/actions";

export interface FetchHistory {
  items: {
    outputId: string;
    at: string;
    delivery: "feed" | "bundle";
    sourceIp?: string;
    newSource?: boolean;
  }[];
  trackSourceIps?: boolean;
  collectionStartedAt?: string;
  limit: number;
  windowDays: number;
}
export function SubscriptionFetchPrivacySettings({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <ActionButton variant="outline" disabled={disabled} onClick={() => setOpen(true)}>管理新 IP 提醒</ActionButton>
    {open && <TaskDialog open title="订阅隐私" onOpenChange={setOpen}>
      <SubscriptionFetchPrivacyTask disabled={disabled} />
    </TaskDialog>}
  </>;
}
function SubscriptionFetchPrivacyTask({ disabled }: { disabled: boolean }) {
  const history = useQuery({
    queryKey: ["subscription-fetches"],
    queryFn: () => request<FetchHistory>("/me/subscription-fetches"),
  });
  return <QueryState loading={history.isPending} paused={history.isPaused} error={history.error}
    retry={() => history.refetch()} loadingLayout="form">
    {history.data && typeof history.data.trackSourceIps === "boolean" && (
      <SubscriptionFetchAlerts history={history.data} disabled={disabled || history.isFetching || history.isError || history.isPaused}
        refresh={async () => !(await history.refetch()).isError} />
    )}
  </QueryState>;
}
export function SubscriptionFetchAlerts({ history, refresh, disabled = false }: {
  history: FetchHistory;
  refresh: () => Promise<boolean>;
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const active = useRef(true);
  const submitting = useRef(false);
  const unavailable = useRef(disabled);
  unavailable.current = disabled;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => request<FetchHistory>("/me/subscription-fetches/tracking", {
      method: "PUT", body: JSON.stringify({ enabled }),
    }),
    retry: false,
    onSuccess: (data) => { client.setQueryData(["subscription-fetches"], data); },
    onSettled: () => { submitting.current = false; },
  });
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium">新 IP 提醒</h3>
        <p className="text-sm text-muted-foreground">{history.trackSourceIps ? "已开启" : "已关闭"}</p>
      </div>
      <ActionButton variant="outline" disabled={disabled || toggle.isPending || toggle.isError}
        onClick={() => {
          if (submitting.current || disabled || toggle.isError) return;
          const enabled = !history.trackSourceIps;
          confirm({
            title: enabled ? "恢复新 IP 提醒？" : "关闭并清除来源 IP？",
            description: enabled
              ? `记录后续订阅拉取的来源 IP，用于站内新 IP 提醒。保留近 ${history.windowDays} 天内最近 ${history.limit} 次记录。`
              : "停止记录来源 IP，并清除当前拉取记录中的地址。已有备份不受影响。",
            confirmLabel: enabled ? "恢复提醒" : "关闭并清除",
            cancelLabel: "取消", destructive: !enabled,
            onConfirm: async () => {
              if (!active.current || unavailable.current || submitting.current) return;
              submitting.current = true;
              await toggle.mutateAsync(enabled).catch(() => {});
            },
          });
        }}>
        {history.trackSourceIps ? "关闭并清除地址" : "恢复新 IP 提醒"}
      </ActionButton>
    </div>
    {toggle.isError && <div>
      <p role="alert" className="text-sm text-destructive">保存结果未确认，请刷新核对。</p>
      <ActionButton size="sm" variant="link" onClick={async () => { if (await refresh()) toggle.reset(); }}>刷新设置</ActionButton>
    </div>}
  </div>;
}

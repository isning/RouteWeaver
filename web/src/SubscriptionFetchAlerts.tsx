import { useMutation, useQueryClient } from "@tanstack/react-query";
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
export function SubscriptionFetchAlerts({
  history,
  refresh,
}: {
  history: FetchHistory;
  names: Record<string, string>;
  refresh: () => void;
}) {
  const client = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      request<FetchHistory>("/me/subscription-fetches/tracking", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (data) => {
      client.setQueryData(["subscription-fetches"], data);
      refresh();
    },
  });
  return (
    <details className="mx-6 mt-3 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer">拉取记录设置</summary>
      <p className="mt-2">
        来源 IP 仅用于站内新 IP 提醒，保留近 {history.windowDays} 天内最近 {history.limit} 次记录。
        首个地址不提醒，IP 变化不代表异常登录。
      </p>
      <ActionButton
        className="mt-2"
        size="sm"
        variant="outline"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!history.trackSourceIps)}
      >
        {history.trackSourceIps ? "关闭并清除地址" : "恢复新 IP 提醒"}
      </ActionButton>
      <p className="mt-2">关闭后清除当前记录中的地址，已有备份不受影响；重新开启后重新记录。</p>
      {toggle.isError && (
        <div className="mt-2">
          <p role="alert" className="text-destructive">尚未确认保存结果，请刷新核对。</p>
          <ActionButton size="sm" variant="link" onClick={refresh}>刷新设置</ActionButton>
        </div>
      )}
    </details>
  );
}

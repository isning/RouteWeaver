import { Metadata, MetadataItem } from "@/ui-patterns/metadata";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, ShieldCheck } from "lucide-react";
import { request } from "./api";
import { dateLabel } from "./model";
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
  names,
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
  const alerts = history.items
    .filter((item) => item.newSource && item.sourceIp)
    .slice(0, 10);
  return (
    <div className="mx-6 mt-4 border-t pt-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" aria-hidden="true" />新 IP 拉取提醒
        </span>
        {history.trackSourceIps && (
          <ActionButton
            size="sm"
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(false)}
          >
            关闭并清除地址
          </ActionButton>
        )}
      </div>
      {!history.trackSourceIps ? (
        <details className="mt-2 text-muted-foreground">
          <summary className="cursor-pointer">未开启，查看设置</summary>
          <p className="mt-2">
            开启后，记录订阅拉取的来源 IP，仅在此处提醒。显示近 30 天内最近 100
            次记录，过期记录在读写时清理；同一订阅的首个地址作为基线，不提醒。关闭会清除当前记录中的地址并重置基线，已有备份不会同步清除。
          </p>
          <p className="mt-2">
            IP 变化不代表账号被盗或新增设备；代理设置可能影响地址识别。
          </p>
          <ActionButton
            className="mt-2"
            size="sm"
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(true)}
          >
            开启并记录来源 IP
          </ActionButton>
        </details>
      ) : (
        <>
          <p className="mt-2 text-muted-foreground">
            仅对保留记录中同一订阅未出现过的地址提醒；记录过期或关闭后重新开启会重置基线。IP
            变化不代表新增设备或账号被盗。
          </p>
          {alerts.length === 0 ? (
            <p className="mt-2 text-muted-foreground">暂无新地址提醒</p>
          ) : (
            <ul className="mt-3 space-y-2" aria-label="新拉取地址提醒">
              {alerts.map((item, index) => (
                <li
                  key={`${item.outputId}-${item.at}-${index}`}
                  className="flex items-start gap-2"
                >
                  <CircleAlert
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Metadata>
                    <MetadataItem>{names[item.outputId] || "订阅名称暂不可用"}</MetadataItem>
                    <MetadataItem>新拉取地址 <span className="font-mono">{item.sourceIp}</span></MetadataItem>
                    <MetadataItem className="text-muted-foreground">{dateLabel(item.at)}</MetadataItem>
                  </Metadata>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-muted-foreground">
            最多显示最近 10
            条提醒。记录仅表示服务端写出配置成功，不代表客户端收到或使用。
          </p>
        </>
      )}
      {toggle.isError && (
        <div className="mt-2">
          <p role="alert" className="text-destructive">
            尚未确认保存结果，请刷新核对。
          </p>
          <ActionButton size="sm" variant="link" onClick={refresh}>
            刷新设置
          </ActionButton>
        </div>
      )}
    </div>
  );
}

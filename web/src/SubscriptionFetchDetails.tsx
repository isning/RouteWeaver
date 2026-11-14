import type { FetchHistory } from "./SubscriptionFetchAlerts";
import { Badge } from "./components/ui/badge";

/** Counts only retained successful deliveries, never extrapolates a total. */
export function SubscriptionFetchDetails({ history, outputId, now }: {
  history: FetchHistory;
  outputId: string;
  now: number;
}) {
  const records = history.items.filter((item) => item.outputId === outputId);
  const latest = records[0];
  const count = records.filter((item) => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && at <= now && at > now - 24 * 60 * 60 * 1000;
  }).length;
  return <div className="mt-1 space-y-1 text-xs text-muted-foreground">
    {history.trackSourceIps === true && latest && (
      latest.sourceIp ? <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono wrap-anywhere">{latest.sourceIp}</span>
        {latest.newSource === true && <Badge variant="outline" className="text-xs">新地址</Badge>}
      </div> : <p>本次未记录来源 IP</p>
    )}
    <p>近 24 小时已保留 {count} 条拉取记录</p>
  </div>;
}

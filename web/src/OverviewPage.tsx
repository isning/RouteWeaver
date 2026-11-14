import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, RefreshCw } from "lucide-react";
import { request, list } from "./api";
import type { Overview, Output, Profile } from "./types";
import { bytesLabel, dateLabel } from "./model";
import { PageHeader, QueryState, Status } from "./components";
import { WorkspaceHistoryContext } from "./SubscriptionContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import { ActionButton } from "@/ui-patterns/actions";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
export interface PersonalInsights {
  asOf: string;
  timezone: string;
  daily: { date: string; rawBytes: number; weightedBytes: number }[];
  routes: { routeId: string; rawBytes: number; weightedBytes: number }[];
  admission: {
    available: boolean;
    asOf: string;
    maxLeaseSeconds: number;
    onlineIps: string[];
    activeStreams: number;
  };
  ipMetadata?: {
    available: boolean;
    sources: { kind: string; databaseType: string; builtAt: string }[];
    items: {
      ip: string;
      status: "available" | "not-found" | "non-public" | "unavailable";
      countryCode?: string;
      asn?: number;
      organization?: string;
    }[];
    truncated: boolean;
  };
  limits: {
    onlineIpLimit: number;
    connectionLimit: number;
    entryRateBps: number;
  };
}
interface SubscriptionFetches {
  items: { outputId: string; at: string; delivery: "feed" | "bundle" }[];
  collectionStartedAt?: string;
  limit: number;
  windowDays: number;
}
export function OverviewPage() {
  const history = useContext(WorkspaceHistoryContext);
  const go = (hash: string) =>
    history?.current ? history.current.navigate(hash) : (location.hash = hash);
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => request<Overview>("/me/overview"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => list<Profile>("/me/profiles"),
  });
  const outputs = useQuery({
    queryKey: ["outputs"],
    queryFn: () => list<Output>("/me/outputs"),
  });
  const insights = useQuery({
    queryKey: ["personal-insights"],
    queryFn: () => request<PersonalInsights>("/me/insights"),
    staleTime: 30_000,
  });
  const fetches = useQuery({
    queryKey: ["subscription-fetches"],
    queryFn: () => request<SubscriptionFetches>("/me/subscription-fetches"),
    staleTime: 30_000,
  });
  const data = overview.data,
    detail = insights.data;
  const pending =
    profiles.data?.filter(
      (p) =>
        !outputs.data?.some(
          (o) => o.profileId === p.id && o.status === "published",
        ),
    ) ?? [];
  const used = data?.accountingPending ? undefined : data?.usage.weightedBytes;
  const remaining =
    data && used !== undefined
      ? Math.max(0, data.quotaBytes - used)
      : undefined;
  const max = Math.max(1, ...(detail?.daily.map((d) => d.weightedBytes) ?? []));
  const total = detail?.routes.reduce((sum, r) => sum + r.rawBytes, 0) ?? 0;
  const names = new Map(data?.routes.map((r) => [r.id, r.name]));
  const average =
    detail?.daily.length === 14
      ? detail.daily
          .slice(-7)
          .reduce((sum, day) => sum + day.weightedBytes, 0) / 7
      : undefined;
  const online = detail?.admission.available === true;
  const count = online ? (detail?.admission.onlineIps.length ?? 0) : 0;
  const limit = detail?.limits.onlineIpLimit ?? 0;
  const palette = [
    "bg-neutral-300 dark:bg-neutral-300",
    "bg-neutral-500",
    "bg-neutral-600",
    "bg-neutral-700",
    "bg-neutral-800 dark:bg-neutral-400",
  ];
  const outputRows = outputs.data?.slice(0, 6) ?? [];
  return (
    <div className="max-w-6xl space-y-6" data-testid="personal-overview">
      <PageHeader
        title="概览"
        action={
          <ActionButton variant="outline" onClick={() => go("#subscriptions")}>
            管理全部订阅
          </ActionButton>
        }
      />
      <QueryState
        loading={profiles.isPending || outputs.isPending}
        paused={profiles.isPaused || outputs.isPaused}
        error={profiles.error || outputs.error}
        retry={() => {
          void profiles.refetch();
          void outputs.refetch();
        }}
        loadingLayout="summary"
      >
        {!!pending.length && (
          <section
            aria-labelledby="home-attention"
            className="overflow-hidden rounded-[14px] border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20"
          >
            <h2 id="home-attention" className="px-5 pt-4 text-sm font-semibold">
              需要你处理{" "}
              <span className="ml-1 font-normal tabular-nums text-muted-foreground">
                {pending.length} 项
              </span>
            </h2>
            <ul className="divide-y divide-amber-200/70 dark:divide-amber-900/70">
              {pending.slice(0, 3).map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-3 px-5 py-3"
                >
                  <CircleAlert
                    aria-hidden="true"
                    className="size-4 shrink-0 text-amber-700 dark:text-amber-400"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium wrap-anywhere">
                      {p.name} 尚未发布
                    </p>
                    <p className="text-xs text-muted-foreground">
                      客户端还拿不到这份订阅。
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      go(`#subscriptions?profile=${encodeURIComponent(p.id)}`)
                    }
                  >
                    去发布
                  </ActionButton>
                </li>
              ))}
            </ul>
            {pending.length > 3 && (
              <ActionButton
                className="m-3"
                variant="ghost"
                onClick={() => go("#subscriptions")}
              >
                查看其余 {pending.length - 3} 项
              </ActionButton>
            )}
          </section>
        )}
      </QueryState>
      <div
        className="grid gap-6 xl:grid-cols-3"
        data-testid="overview-primary-grid"
      >
        <Card className="min-w-0 rounded-[14px] shadow-none xl:col-span-2">
          <QueryState
            loading={overview.isPending}
            paused={overview.isPaused}
            error={overview.error}
            retry={() => overview.refetch()}
            loadingLayout="summary"
          >
            {data && (
              <>
                <CardHeader>
                  <CardTitle
                    role="heading"
                    aria-level={2}
                    className="text-sm font-medium text-muted-foreground"
                  >
                    本周期剩余额度
                  </CardTitle>
                  <CardDescription>
                    {data.entitlement?.serviceName ||
                      data.service?.name ||
                      "当前服务"}
                  </CardDescription>
                  <CardAction>
                    <Status value={data.status} />
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <div className="mb-6">
                    <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
                      <p className="text-5xl leading-none font-semibold tracking-tight tabular-nums">
                        {data.quotaBytes === 0
                          ? "不限额"
                          : bytesLabel(remaining)}
                      </p>
                      {used !== undefined && data.quotaBytes > 0 && (
                        <Badge variant="secondary">
                          本周期已用{" "}
                          {Math.min(
                            100,
                            Math.round((used / data.quotaBytes) * 100),
                          )}
                          %
                        </Badge>
                      )}
                    </div>
                    {data.quotaBytes > 0 && used !== undefined && (
                      <Progress
                        className="mb-3 h-2.5"
                        value={Math.min(100, (used / data.quotaBytes) * 100)}
                        aria-label="本周期已用额度比例"
                      />
                    )}
                    <dl className="grid grid-cols-2 gap-4 pt-2 sm:grid-cols-4">
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          已用（按倍率）
                        </dt>
                        <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                          {bytesLabel(used)}
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                          {data.quotaBytes
                            ? `共 ${bytesLabel(data.quotaBytes)}`
                            : "总额度不限"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          实际流量
                        </dt>
                        <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                          {bytesLabel(data.usage.rawBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          下次重置
                        </dt>
                        <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                          {data.cycle?.nextReset
                            ? resetCountdown(data.cycle.nextReset)
                            : data.cycle
                              ? "不自动重置"
                              : "尚未设置"}
                        </dd>
                        {data.cycle?.nextReset && (
                          <dd className="text-xs text-muted-foreground">
                            {dateLabel(
                              data.cycle.nextReset,
                              data.cycle.timezone,
                            )}
                          </dd>
                        )}
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          服务到期
                        </dt>
                        <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                          {dateLabel(
                            data.entitlement?.expiresAt || data.user.expiresAt,
                          )}
                        </dd>
                      </div>
                    </dl>
                    {data.accountingPending && (
                      <p
                        role="status"
                        className="mt-3 text-sm text-muted-foreground"
                      >
                        额度正在核对，稍后更新。
                      </p>
                    )}
                  </div>
                  <section
                    aria-labelledby="home-daily"
                    className="border-t pt-5"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <h3 id="home-daily" className="text-sm font-medium">
                        近 14 天每日用量
                      </h3>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {average !== undefined
                          ? `近 7 天日均 ${bytesLabel(average)}`
                          : "日均用量暂不可用"}
                      </p>
                    </div>
                    <QueryState
                      loading={insights.isPending}
                      paused={insights.isPaused}
                      error={insights.error}
                      retry={() => insights.refetch()}
                      loadingLayout="summary"
                    >
                      {detail && (
                        <>
                          <ol
                            aria-label="每日额度消耗"
                            className="mt-4 flex h-32 items-end gap-1.5"
                          >
                            {detail.daily.map((day, index) => (
                              <li
                                key={day.date}
                                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                                title={`${day.date}：额度消耗 ${bytesLabel(day.weightedBytes)}，实际流量 ${bytesLabel(day.rawBytes)} (${detail.timezone})`}
                              >
                                <span className="sr-only">
                                  {day.date}：额度消耗{" "}
                                  {bytesLabel(day.weightedBytes)}，实际流量{" "}
                                  {bytesLabel(day.rawBytes)}
                                </span>
                                <div
                                  aria-hidden="true"
                                  className={`rounded-t-md ${index >= detail.daily.length - 7 ? "bg-primary" : "bg-primary/20"}`}
                                  style={{
                                    height: `${(day.weightedBytes / max) * 100}%`,
                                    minHeight: day.weightedBytes > 0 ? 2 : 0,
                                  }}
                                />
                              </li>
                            ))}
                          </ol>
                          <div className="mt-2 flex justify-between text-xs tabular-nums text-muted-foreground">
                            <span>{shortDay(detail.daily[0]?.date)}</span>
                            <span>今天</span>
                          </div>
                        </>
                      )}
                    </QueryState>
                  </section>
                </CardContent>
              </>
            )}
          </QueryState>
        </Card>
        <Card className="min-w-0 rounded-[14px] shadow-none">
          <CardHeader>
            <CardTitle
              role="heading"
              aria-level={2}
              className="text-sm font-medium text-muted-foreground"
            >
              在线设备
            </CardTitle>
            <CardDescription>
              按在线 IP 计
              {online && `，截至 ${relativeTime(detail!.admission.asOf)}`}
            </CardDescription>
            <CardAction className="row-span-1 self-center">
              <ActionButton
                size="icon"
                variant="ghost"
                aria-label="刷新在线情况"
                disabled={insights.isFetching}
                onClick={() => insights.refetch()}
              >
                <RefreshCw className="size-4" aria-hidden="true" />
              </ActionButton>
            </CardAction>
          </CardHeader>
          <CardContent>
            {online && detail ? (
              <>
                <div className="mb-5">
                  <p className="mb-2 flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tabular-nums">
                      {count}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      / {limit || "不限"} 个 IP
                    </span>
                  </p>
                  {limit > 0 && limit <= 20 && (
                    <div aria-hidden="true" className="mb-2 flex gap-1">
                      {Array.from({ length: limit }, (_, i) => (
                        <span
                          key={i}
                          className={`h-2 flex-1 rounded-full ${i < count ? "bg-primary" : "bg-muted"}`}
                        />
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {limit
                      ? count >= limit
                        ? "已达到在线 IP 上限，新的 IP 暂时无法接入。"
                        : `再有 ${limit - count} 个新 IP 接入后，后来的设备将无法连接。`
                      : "当前服务不限制在线 IP 数量。"}
                  </p>
                </div>
                <ul className="mb-5 max-h-52 divide-y overflow-y-auto rounded-[10px] border">
                  {detail.admission.onlineIps.map((ip) => (
                    <li
                      key={ip}
                      className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full bg-emerald-500"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-mono wrap-anywhere">{ip}</p>
                        {detail.ipMetadata?.available === true && (
                          <IPDetails
                            item={detail.ipMetadata.items.find(
                              (item) => item.ip === ip,
                            )}
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {!count && (
                  <p className="mb-4 text-sm text-muted-foreground">
                    暂无活跃 IP
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-4 border-t pt-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">并发连接</dt>
                    <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                      {detail.admission.activeStreams} /{" "}
                      {detail.limits.connectionLimit || "不限"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">速率上限</dt>
                    <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">
                      {detail.limits.entryRateBps
                        ? `${(detail.limits.entryRateBps / 1_000_000).toLocaleString()} Mbps`
                        : "不限"}
                    </dd>
                  </div>
                </dl>
                <details className="mt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">统计说明</summary>
                  <div className="mt-2 space-y-1">
                    <p>
                      按未到期的托管连接记录统计，不代表设备数量；断开后最多延迟{" "}
                      {detail.admission.maxLeaseSeconds} 秒更新。
                    </p>
                    {detail.ipMetadata?.available === true ? (
                      <>
                        <p>
                          国家和网络组织来自本地数据库，不代表设备的实际位置或运营商。
                        </p>
                        {detail.ipMetadata.sources.map((source, index) => (
                          <p key={`${source.kind}:${index}`}>
                            {source.databaseType} · 更新于{" "}
                            {dateLabel(source.builtAt)}
                          </p>
                        ))}
                        {detail.ipMetadata.truncated && (
                          <p>部分 IP 尚未查询归属资料。</p>
                        )}
                      </>
                    ) : (
                      <p>IP 归属资料暂不可用</p>
                    )}
                  </div>
                </details>
              </>
            ) : (
              <>
                <p role="status" className="text-sm text-muted-foreground">
                  {insights.isPending
                    ? "正在获取在线情况…"
                    : "在线情况暂不可用，请稍后刷新。"}
                </p>
                {insights.error && (
                  <ActionButton
                    className="mt-3"
                    variant="outline"
                    onClick={() => insights.refetch()}
                  >
                    重试
                  </ActionButton>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
      <div
        className="grid gap-6 xl:grid-cols-3"
        data-testid="overview-secondary-grid"
      >
        <Card className="min-w-0 rounded-[14px] shadow-none xl:col-span-2">
          <CardHeader className="grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto]">
            <CardTitle
              role="heading"
              aria-level={2}
              className="col-start-1 row-start-1 self-center text-base font-semibold"
            >
              用量最多的订阅
            </CardTitle>
            <CardDescription className="col-span-2 col-start-1 row-start-2 sm:col-span-1">
              按订阅计量尚不可用，以下不按用量排序。
            </CardDescription>
            <CardAction className="row-span-1 self-center sm:row-span-2 sm:self-start">
              <ActionButton
                variant="link"
                className="px-0"
                onClick={() => go("#subscriptions")}
              >
                {outputs.isSuccess
                  ? `全部 ${outputs.data.length} 个订阅`
                  : "全部订阅"}{" "}
                <ArrowRight aria-hidden="true" className="size-4" />
              </ActionButton>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <QueryState
              loading={outputs.isPending}
              paused={outputs.isPaused}
              error={outputs.error}
              retry={() => outputs.refetch()}
              loadingLayout="table"
            >
              <Table
                aria-label="订阅用量与最近拉取"
                className="min-w-[40rem] table-fixed"
              >
                <TableHeader className="border-y bg-muted/30">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-auto w-[34%] py-2 pl-6 text-xs text-muted-foreground">
                      订阅
                    </TableHead>
                    <TableHead className="h-auto w-[26%] py-2 text-xs text-muted-foreground">
                      本周期用量
                    </TableHead>
                    <TableHead className="h-auto py-2 text-xs text-muted-foreground">
                      最近拉取
                    </TableHead>
                    <TableHead className="h-auto w-16 py-2 pr-6">
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outputRows.map((output) => {
                    const last = fetches.data?.items.find(
                      (item) => item.outputId === output.id,
                    );
                    return (
                      <TableRow key={output.id}>
                        <TableCell className="py-3 pl-6 whitespace-normal">
                          <p className="text-sm font-medium wrap-anywhere">
                            {output.name}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {output.status === "published"
                              ? output.target.adapterId
                              : output.status === "draft"
                                ? "草稿"
                                : "未发布"}
                          </p>
                        </TableCell>
                        <TableCell className="py-3 whitespace-normal">
                          <p className="text-xs text-muted-foreground">
                            尚未单独计量
                          </p>
                        </TableCell>
                        <TableCell className="py-3 whitespace-normal">
                          {fetches.isError ? (
                            <ActionButton
                              size="sm"
                              variant="link"
                              onClick={() => fetches.refetch()}
                            >
                              重试拉取记录
                            </ActionButton>
                          ) : last ? (
                            <>
                              <p className="text-xs" title={dateLabel(last.at)}>
                                {relativeTime(last.at)}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {last.delivery === "bundle"
                                  ? "配置包"
                                  : "订阅链接"}
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {fetches.isPending ? "正在读取…" : "暂无拉取记录"}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="py-3 pr-6 text-right">
                          <ActionButton
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              go(
                                `#subscriptions?output=${encodeURIComponent(output.id)}`,
                              )
                            }
                          >
                            查看
                          </ActionButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {!outputRows.length && (
                <p className="px-6 py-6 text-sm text-muted-foreground">
                  尚无客户端订阅
                </p>
              )}
              {fetches.data && (
                <p className="px-6 pt-3 text-xs text-muted-foreground">
                  保留近 {fetches.data.windowDays} 天内最近 {fetches.data.limit}{" "}
                  次成功交付记录，不代表客户端已应用配置。
                </p>
              )}
            </QueryState>
          </CardContent>
        </Card>
        <Card className="min-w-0 rounded-[14px] shadow-none">
          <CardHeader>
            <CardTitle
              role="heading"
              aria-level={2}
              className="text-base font-semibold"
            >
              线路用量
            </CardTitle>
            <CardDescription>本周期实际流量，按倍率扣除额度</CardDescription>
          </CardHeader>
          <CardContent>
            <QueryState
              loading={insights.isPending}
              paused={insights.isPaused}
              error={insights.error}
              retry={() => insights.refetch()}
              loadingLayout="summary"
            >
              {detail && (
                <>
                  {detail.routes.length ? (
                    <>
                      <div
                        role="img"
                        aria-label="各线路用量占比"
                        className="mb-4 flex h-3 overflow-hidden rounded-full"
                      >
                        {detail.routes.map((r, i) => (
                          <div
                            key={r.routeId}
                            className={palette[i % palette.length]}
                            style={{
                              width: `${total ? (r.rawBytes / total) * 100 : 0}%`,
                            }}
                            title={`${names.get(r.routeId) || (overview.isSuccess ? "历史线路" : "线路名称暂不可用")}：${bytesLabel(r.rawBytes)}`}
                          />
                        ))}
                      </div>
                      <Table aria-label="线路用量" className="table-fixed">
                        <colgroup>
                          <col />
                          <col className="w-14" />
                          <col className="w-20" />
                        </colgroup>
                        <TableHeader className="sr-only">
                          <TableRow>
                            <TableHead>线路</TableHead>
                            <TableHead>倍率</TableHead>
                            <TableHead>实际流量</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {detail.routes.map((r, i) => {
                            const route = data?.routes.find(
                              (route) => route.id === r.routeId,
                            );
                            return (
                              <TableRow
                                key={r.routeId}
                                className="border-0 hover:bg-transparent"
                              >
                                <TableCell className="py-1.5 pl-0 whitespace-normal">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <span
                                      aria-hidden="true"
                                      className={`size-2.5 shrink-0 rounded-md ${palette[i % palette.length]}`}
                                    />
                                    <span
                                      className="truncate"
                                      title={route?.name}
                                    >
                                      {route?.name ||
                                        (overview.isSuccess
                                          ? "历史线路"
                                          : "线路名称暂不可用")}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="w-14 py-1.5 text-right text-xs text-muted-foreground">
                                  {route?.rateMicros !== undefined
                                    ? `${route.rateMicros / 1_000_000}×`
                                    : "—"}
                                </TableCell>
                                <TableCell
                                  className="w-20 py-1.5 pr-0 text-right text-sm tabular-nums"
                                  title={`扣除额度 ${bytesLabel(r.weightedBytes)}`}
                                >
                                  {bytesLabel(r.rawBytes)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                        高倍率线路扣额度更快；日常使用可优先 1× 线路。
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      本周期暂无线路用量记录
                    </p>
                  )}
                </>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function shortDay(day?: string) {
  return day
    ? day.slice(5).replace(/^0/, "").replace("-0", "/").replace("-", "/")
    : "";
}
function resetCountdown(at: string) {
  const hours = Math.ceil((Date.parse(at) - Date.now()) / 3_600_000);
  if (!Number.isFinite(hours)) return "暂不可用";
  if (hours <= 0) return "等待重置";
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
function relativeTime(at: string) {
  const minutes = Math.floor((Date.now() - Date.parse(at)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return dateLabel(at);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return dateLabel(at);
}

function IPDetails({
  item,
}: {
  item?: NonNullable<PersonalInsights["ipMetadata"]>["items"][number];
}) {
  if (!item || item.status === "unavailable")
    return (
      <p className="truncate text-xs text-muted-foreground">归属资料暂不可用</p>
    );
  if (item.status === "non-public")
    return (
      <p className="truncate text-xs text-muted-foreground">
        非公网地址，无公网归属资料
      </p>
    );
  if (item.status !== "available")
    return <p className="truncate text-xs text-muted-foreground">归属未知</p>;
  const label = [
    item.countryCode ? countryName(item.countryCode) : "国家/地区未知",
    item.organization || "网络组织未知",
    item.asn ? `AS${item.asn}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <p className="truncate text-xs text-muted-foreground" title={label}>
      {label}
    </p>
  );
}

function countryName(code: string) {
  try {
    const name = new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

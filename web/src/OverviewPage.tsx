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
import { ArrowRight, CircleAlert, Network, RefreshCw } from "lucide-react";
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
  return (
    <div className="space-y-6" data-testid="personal-overview">
      <PageHeader
        title="概览"
        action={
          <ActionButton
            variant="outline"
            leadingIcon={<ArrowRight aria-hidden="true" />}
            onClick={() => go("#subscriptions")}
          >
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
          <Card className="gap-0 py-0 shadow-none">
            <CardHeader className="border-b py-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleAlert
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                需要你处理{" "}
                <Badge variant="secondary">{pending.length} 项</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="divide-y px-4 sm:px-6">
              {pending.slice(0, 3).map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium wrap-anywhere">
                      {p.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      尚无可用的订阅链接
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      go(`#subscriptions?profile=${encodeURIComponent(p.id)}`)
                    }
                  >
                    查看配置
                  </ActionButton>
                </div>
              ))}
              {pending.length > 3 && (
                <ActionButton
                  className="my-2"
                  variant="ghost"
                  onClick={() => go("#subscriptions")}
                >
                  查看其余 {pending.length - 3} 项
                </ActionButton>
              )}
            </CardContent>
          </Card>
        )}
      </QueryState>
      <QueryState
        loading={overview.isPending}
        paused={overview.isPaused}
        error={overview.error}
        retry={() => overview.refetch()}
        loadingLayout="summary"
      >
        {data && (
          <Card className="gap-4 shadow-none">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground">
                本周期剩余额度 <Status value={data.status} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <p className="text-3xl font-semibold tracking-tight tabular-nums">
                  {data.quotaBytes === 0 ? "不限额" : bytesLabel(remaining)}
                </p>
                <dl className="grid grid-cols-3 gap-4 text-xs">
                  {[
                    ["已用额度", bytesLabel(used)],
                    [
                      "总额度",
                      data.quotaBytes === 0
                        ? "不限额"
                        : bytesLabel(data.quotaBytes),
                    ],
                    ["实际流量", bytesLabel(data.usage.rawBytes)],
                  ].map(([label, value]) => (
                    <div key={label} className="space-y-1">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {data.quotaBytes > 0 && used !== undefined && (
                <Progress
                  value={Math.min(100, (used / data.quotaBytes) * 100)}
                  className="h-1.5"
                  aria-label="本周期已用额度比例"
                />
              )}
              <dl className="grid gap-x-8 gap-y-2 border-t pt-3 text-xs sm:grid-cols-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">下次重置</dt>
                  <dd className="tabular-nums">
                    {data.cycle?.nextReset
                      ? dateLabel(data.cycle.nextReset, data.cycle.timezone)
                      : data.cycle
                        ? "不自动重置"
                        : "尚未设置"}
                  </dd>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">服务到期</dt>
                  <dd className="tabular-nums">
                    {dateLabel(
                      data.entitlement?.expiresAt || data.user.expiresAt,
                    )}
                  </dd>
                </div>
              </dl>
              {data.accountingPending && (
                <p role="status" className="text-sm text-muted-foreground">
                  额度正在核对，稍后更新。
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </QueryState>
      <QueryState
        loading={insights.isPending}
        paused={insights.isPaused}
        error={insights.error}
        retry={() => insights.refetch()}
        loadingLayout="summary"
      >
        {detail && (
          <>
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
              <Card className="shadow-none">
                <CardHeader className="items-center gap-4">
                  <CardTitle className="text-base">近 14 天每日用量</CardTitle>
                  <CardAction className="row-span-1 self-center">
                    <span className="text-xs text-muted-foreground">
                      {detail.timezone}
                    </span>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <ol
                    className="grid h-40 grid-cols-14 items-end gap-1"
                    aria-label="每日额度消耗"
                  >
                    {detail.daily.map((d) => (
                      <li
                        key={d.date}
                        className="flex h-full min-w-0 flex-col justify-end gap-2"
                        title={`${d.date}：额度消耗 ${bytesLabel(d.weightedBytes)}，实际流量 ${bytesLabel(d.rawBytes)}`}
                      >
                        <span className="sr-only">
                          {d.date}：额度消耗 {bytesLabel(d.weightedBytes)}
                          ，实际流量 {bytesLabel(d.rawBytes)}
                        </span>
                        <div
                          className="min-h-0 rounded-t-sm bg-primary/75"
                          style={{
                            height: `${(d.weightedBytes / max) * 100}%`,
                            minHeight: d.weightedBytes > 0 ? 2 : 0,
                          }}
                          aria-hidden="true"
                        />
                      </li>
                    ))}
                  </ol>
                  <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                    <span>{detail.daily[0]?.date}</span>
                    <span>{detail.daily.at(-1)?.date}</span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    按计量记录时间统计的额度消耗。
                  </p>
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardHeader className="items-center gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Network className="size-4" aria-hidden="true" />
                    在线 IP
                  </CardTitle>
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
                <CardContent className="space-y-4">
                  {detail.admission.available === true ? (
                    <>
                      <p className="text-2xl font-semibold tabular-nums">
                        {detail.admission.onlineIps.length}
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                          / {detail.limits.onlineIpLimit || "不限"}
                        </span>
                      </p>
                      {detail.admission.onlineIps.length ? (
                        <ul className="max-h-32 divide-y overflow-auto">
                          {detail.admission.onlineIps.map((ip) => (
                            <li
                              key={ip}
                              className="space-y-1 py-2 text-xs wrap-anywhere"
                            >
                              <p className="font-mono">{ip}</p>
                              {detail.ipMetadata?.available === true && (
                                <IPDetails
                                  item={detail.ipMetadata.items.find(
                                    (item) => item.ip === ip,
                                  )}
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          暂无活跃 IP
                        </p>
                      )}
                      {detail.ipMetadata?.available !== true ? (
                        <p className="text-xs text-muted-foreground">
                          IP 归属资料暂不可用
                        </p>
                      ) : (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">
                            IP 资料来源
                          </summary>
                          <div className="mt-2 space-y-1">
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
                          </div>
                        </details>
                      )}
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        按未到期的托管连接记录统计，不代表设备数量；断开后最多延迟{" "}
                        {detail.admission.maxLeaseSeconds} 秒更新。
                      </p>
                      <dl className="grid gap-2 border-t pt-3 text-xs">
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">并发连接</dt>
                          <dd className="tabular-nums">
                            {detail.admission.activeStreams} /{" "}
                            {detail.limits.connectionLimit || "不限"}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">速率上限</dt>
                          <dd className="tabular-nums">
                            {detail.limits.entryRateBps
                              ? `${(detail.limits.entryRateBps / 1_000_000).toLocaleString()} Mbps`
                              : "不限"}
                          </dd>
                        </div>
                      </dl>
                      <p className="text-xs text-muted-foreground">
                        更新于 {dateLabel(detail.admission.asOf)}
                      </p>
                    </>
                  ) : (
                    <p role="status" className="text-sm text-muted-foreground">
                      在线情况暂不可用，请稍后刷新。
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-base">线路用量</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.routes.length ? (
                  <Table aria-label="线路用量" className="min-w-96 table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-0">线路</TableHead>
                        <TableHead className="w-28 text-right sm:w-40">
                          实际流量
                        </TableHead>
                        <TableHead className="w-28 pr-0 text-right sm:w-40">
                          扣除额度
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.routes.map((r) => (
                        <TableRow key={r.routeId}>
                          <TableCell className="space-y-2 py-3 pl-0 whitespace-normal">
                            <p className="wrap-anywhere">
                              {names.get(r.routeId) ||
                                (overview.isSuccess
                                  ? "历史线路"
                                  : "线路名称暂不可用")}
                            </p>
                            <Progress
                              className="h-1.5 max-w-48"
                              value={total ? (r.rawBytes / total) * 100 : 0}
                              aria-label={`${names.get(r.routeId) || (overview.isSuccess ? "历史线路" : "线路名称暂不可用")}用量占比`}
                            />
                          </TableCell>
                          <TableCell className="py-3 text-right tabular-nums">
                            {bytesLabel(r.rawBytes)}
                          </TableCell>
                          <TableCell className="py-3 pr-0 text-right tabular-nums">
                            {bytesLabel(r.weightedBytes)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    本周期暂无线路用量记录
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
      <Card className="shadow-none">
        <CardHeader className="items-center gap-4">
          <CardTitle className="text-base">最近订阅拉取</CardTitle>
          <CardAction className="row-span-1 self-center">
            <ActionButton
              variant="ghost"
              size="sm"
              onClick={() => go("#subscriptions")}
            >
              全部订阅
            </ActionButton>
          </CardAction>
        </CardHeader>
        <CardContent>
          <QueryState
            loading={fetches.isPending}
            paused={fetches.isPaused}
            error={fetches.error}
            retry={() => fetches.refetch()}
            loadingLayout="table"
          >
            {fetches.data && (
              <>
                {fetches.data.items.length ? (
                  <Table aria-label="最近订阅拉取" className="min-w-96 table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-0">订阅</TableHead>
                        <TableHead className="w-32 sm:w-48">拉取时间</TableHead>
                        <TableHead className="w-14 pr-0 text-right">
                          操作
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fetches.data.items.slice(0, 8).map((item, index) => {
                        const output = outputs.data?.find(
                          (o) => o.id === item.outputId,
                        );
                        return (
                          <TableRow
                            key={`${item.outputId}:${item.at}:${index}`}
                          >
                            <TableCell className="py-3 pl-0 whitespace-normal">
                              <p className="text-sm font-medium wrap-anywhere">
                                {output?.name ||
                                  (outputs.isSuccess
                                    ? "已删除的订阅"
                                    : "订阅名称暂不可用")}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.delivery === "bundle"
                                  ? "配置包"
                                  : "订阅链接"}
                              </p>
                            </TableCell>
                            <TableCell className="py-3 whitespace-normal">
                              <time
                                dateTime={item.at}
                                className="text-xs tabular-nums text-muted-foreground"
                              >
                                {dateLabel(item.at)}
                              </time>
                            </TableCell>
                            <TableCell className="py-3 pr-0 text-right">
                              {output && (
                                <ActionButton
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    go(
                                      `#subscriptions?output=${encodeURIComponent(item.outputId)}`,
                                    )
                                  }
                                >
                                  查看
                                </ActionButton>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">暂无拉取记录</p>
                )}
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  保留近 {fetches.data.windowDays} 天内最近 {fetches.data.limit}{" "}
                  次成功交付记录，不代表客户端已应用配置。
                </p>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </div>
  );
}

function IPDetails({
  item,
}: {
  item?: NonNullable<PersonalInsights["ipMetadata"]>["items"][number];
}) {
  if (!item || item.status === "unavailable")
    return <p className="text-muted-foreground">归属资料暂不可用</p>;
  if (item.status === "non-public")
    return <p className="text-muted-foreground">非公网地址，无公网归属资料</p>;
  if (item.status !== "available")
    return <p className="text-muted-foreground">归属未知</p>;
  return (
    <div className="space-y-1 text-muted-foreground">
      <p>
        国家/地区：{item.countryCode ? countryName(item.countryCode) : "未知"}
      </p>
      <p>
        网络组织：{item.organization || "未知"}
        {item.asn ? ` · AS${item.asn}` : ""}
      </p>
    </div>
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

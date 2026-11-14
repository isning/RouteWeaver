import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { ActionButton } from "./ui-patterns/actions";
import { ChoiceSelect } from "./ui-patterns/choice-select";
import { Notice } from "./ui-patterns/notice";
import { useConfirm } from "./ui-patterns/confirmations";
import {
  coreLogPath,
  APIError,
  request,
  requestCoreLogExport,
  type CoreLogFilters,
} from "./api";
import { coreName } from "./infrastructure-data";
import { dateLabel } from "./model";
import type { CoreInstance, HostRecord } from "./types";

interface RawLogView {
  instanceId: string;
  collectionState: "not_reported" | "recent" | "stale";
  lastReceivedAt: string | null;
  events: {
    adapterId: string;
    version: string;
    stream: "stdout" | "stderr";
    text: string;
    observedAt: string;
    receivedAt: string;
  }[];
  dropped: number;
  retentionSeconds: number;
  historyLimit: number;
  lineBytesLimit: number;
}
function validView(value: RawLogView, id: string) {
  return (
    value?.instanceId === id &&
    ["not_reported", "recent", "stale"].includes(value.collectionState) &&
    (value.lastReceivedAt === null ||
      Number.isFinite(Date.parse(value.lastReceivedAt))) &&
    Array.isArray(value.events) &&
    value.events.length <= 128 &&
    value.events.every(
      (event) =>
        event &&
        ["stdout", "stderr"].includes(event.stream) &&
        typeof event.text === "string" &&
        new TextEncoder().encode(event.text).length <= 4096 &&
        typeof event.adapterId === "string" &&
        typeof event.version === "string" &&
        Number.isFinite(Date.parse(event.observedAt)) &&
        Number.isFinite(Date.parse(event.receivedAt)),
    ) &&
    [
      value.dropped,
      value.retentionSeconds,
      value.historyLimit,
      value.lineBytesLimit,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  );
}
export function RawCoreLogsPanel({
  host,
  instances,
}: {
  host: HostRecord;
  instances: CoreInstance[];
}) {
  const cores = instances.filter((core) => core.hostId === host.id);
  const [selected, setSelected] = useState("");
  const core = cores.find((item) => item.id === selected) || cores[0];
  return (
    <section aria-label="核心日志原文" className="min-w-0 space-y-4">
      {cores.length > 1 && (
        <div className="max-w-sm">
          <ChoiceSelect
            aria-label="日志核心"
            value={core?.id}
            onValueChange={(value) => setSelected(value || "")}
            options={cores.map((item) => ({
              value: item.id,
              label: coreName(item),
            }))}
          />
        </div>
      )}
      {core ? (
        <RawLogDetails
          key={`${core.id}:${core.adapterId}:${core.version}`}
          core={core}
        />
      ) : (
        <p className="text-sm text-muted-foreground">添加核心后可查看日志。</p>
      )}
    </section>
  );
}
function RawLogDetails({ core }: { core: CoreInstance }) {
  const [revealed, setRevealed] = useState(false);
  const [stream, setStream] = useState("all");
  const [period, setPeriod] = useState("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CoreLogFilters>({});
  const searchTooLong = new TextEncoder().encode(search).length > 128;
  const [appliedPeriod, setAppliedPeriod] = useState("all");
  const filtersDirty =
    search !== (filters.q || "") ||
    stream !== (filters.stream || "all") ||
    period !== appliedPeriod;
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState(false);
  const confirm = useConfirm();
  const scope = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const decision = useRef<{ close: () => void } | null>(null);
  useEffect(
    () => () => {
      scope.current++;
      abort.current?.abort();
      decision.current?.close();
    },
    [],
  );
  const query = useQuery({
    queryKey: ["raw-core-logs", core.id, filters],
    enabled: revealed,
    queryFn: async ({ signal }) => {
      const value = await request<RawLogView>(coreLogPath(core.id, filters), {
        signal,
        redirect: "error",
      });
      if (!validView(value, core.id)) throw new Error("日志响应格式不正确");
      return value;
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const accessDenied =
    query.error instanceof APIError && [401, 403].includes(query.error.status);
  const data = accessDenied ? undefined : query.data;
  const apply = () => {
    if (searchTooLong) return;
    scope.current++;
    abort.current?.abort();
    setDownloading(false);
    setExportError(false);
    setAppliedPeriod(period);
    setFilters({
      ...(stream === "all" ? {} : { stream: stream as "stdout" | "stderr" }),
      ...(search ? { q: search } : {}),
      ...(period === "all"
        ? {}
        : {
            since: new Date(Date.now() - Number(period) * 60_000).toISOString(),
          }),
    });
  };
  const refresh = () => {
    scope.current++;
    abort.current?.abort();
    setDownloading(false);
    setExportError(false);
    if (appliedPeriod === "all") void query.refetch();
    else
      setFilters((current) => ({
        ...current,
        since: new Date(
          Date.now() - Number(appliedPeriod) * 60_000,
        ).toISOString(),
      }));
  };
  const exportLogs = () => {
    if (decision.current) return;
    const ticket = scope.current;
    const selection = { ...filters };
    decision.current = confirm({
      onClosed: () => {
        decision.current = null;
      },
      title: "导出日志原文？",
      description:
        "导出文件不加密，可能包含访问目标、IP、账号或密钥。只导出当前筛选条件下仍保留的记录，请妥善保管。",
      confirmLabel: "导出 NDJSON",
      onConfirm: async () => {
        if (ticket !== scope.current)
          throw new Error("筛选条件已变化，请重新确认导出。");
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        setDownloading(true);
        setExportError(false);
        try {
          const result = await requestCoreLogExport(
            core.id,
            selection,
            controller.signal,
          );
          if (ticket !== scope.current || controller.signal.aborted) return;
          result.assertCurrent();
          const url = URL.createObjectURL(result.blob);
          try {
            const link = document.createElement("a");
            link.href = url;
            link.download = "routeweaver-core-logs.ndjson";
            document.body.appendChild(link);
            result.assertCurrent();
            link.click();
            link.remove();
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        } catch (error) {
          if (ticket !== scope.current || controller.signal.aborted) return;
          setExportError(true);
          throw error;
        } finally {
          if (ticket === scope.current) setDownloading(false);
        }
      },
    });
  };
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>核心日志原文</CardTitle>
        <CardDescription>{coreName(core)}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <Notice tone="warning">
          日志可能包含访问目标、IP、账号或密钥，仅管理员可查看。请勿公开分享原文或导出文件。
        </Notice>
        {!revealed ? (
          <ActionButton onClick={() => setRevealed(true)}>
            查看日志原文
          </ActionButton>
        ) : (
          <>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                apply();
              }}
            >
              <div className="w-36 space-y-1">
                <Label>输出通道</Label>
                <ChoiceSelect
                  aria-label="输出通道"
                  value={stream}
                  onValueChange={(value) => setStream(value || "all")}
                  options={[
                    { value: "all", label: "全部通道" },
                    { value: "stdout", label: "stdout" },
                    { value: "stderr", label: "stderr" },
                  ]}
                />
              </div>
              <div className="w-36 space-y-1">
                <Label>采集时间</Label>
                <ChoiceSelect
                  aria-label="采集时间"
                  value={period}
                  onValueChange={(value) => setPeriod(value || "all")}
                  options={[
                    { value: "all", label: "全部保留记录" },
                    { value: "15", label: "最近15分钟" },
                    { value: "60", label: "最近1小时" },
                  ]}
                />
              </div>
              <div className="min-w-40 flex-1 space-y-1">
                <Label htmlFor={`raw-search-${core.id}`}>原文关键词</Label>
                <Input
                  id={`raw-search-${core.id}`}
                  maxLength={128}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <ActionButton
                type="submit"
                variant="outline"
                disabled={searchTooLong}
              >
                筛选
              </ActionButton>
              <ActionButton
                type="button"
                variant="outline"
                leadingIcon={<RefreshCw aria-hidden="true" />}
                pending={query.isFetching}
                onClick={refresh}
              >
                刷新
              </ActionButton>
              <ActionButton
                type="button"
                variant="outline"
                leadingIcon={<Download aria-hidden="true" />}
                disabled={
                  !data ||
                  query.isError ||
                  !data.events.length ||
                  downloading ||
                  filtersDirty
                }
                pending={downloading}
                onClick={exportLogs}
              >
                导出当前筛选
              </ActionButton>
            </form>
            {searchTooLong && (
              <p role="alert" className="text-sm text-destructive">
                关键词过长，请缩短后再筛选。
              </p>
            )}
            {filtersDirty && (
              <p className="text-xs text-muted-foreground">
                筛选条件已更改，请先点击筛选。
              </p>
            )}
            {query.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                {query.isPaused ? "等待网络连接" : "正在读取日志…"}
              </p>
            )}
            {query.isError && (
              <Notice tone="warning">
                {accessDenied
                  ? "无权读取原文日志，请确认当前管理员登录。"
                  : "日志读取失败，请重试。"}
                {data && "以下保留上次读取的记录。"}
              </Notice>
            )}
            {exportError && (
              <Notice tone="warning">
                日志导出失败，请重试。未生成可下载的文件。
              </Notice>
            )}
            {data?.collectionState === "not_reported" && (
              <Notice tone="info">
                尚未收到原文日志。采集默认不启用，需要管理员在节点上启动 Agent
                时明确添加 <code>--raw-core-logs-accept-sensitive</code>
                。此页面不会修改核心配置或开启采集。
              </Notice>
            )}
            {data?.collectionState === "stale" && (
              <Notice tone="warning">
                近期未收到日志，以下记录不代表当前运行状态。
              </Notice>
            )}
            {data?.lastReceivedAt && (
              <p className="text-xs text-muted-foreground">
                最近收到 {dateLabel(data.lastReceivedAt)}
              </p>
            )}
            {data?.events.length ? (
              <div className="overflow-hidden rounded-lg border">
                <Table
                  aria-label="原始核心日志"
                  className="min-w-[720px] table-fixed text-xs"
                >
                  <colgroup>
                    <col className="w-40" />
                    <col className="w-32" />
                    <col className="w-20" />
                    <col />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead>采集时间</TableHead>
                      <TableHead>核心版本</TableHead>
                      <TableHead>输出通道</TableHead>
                      <TableHead>日志原文</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.map((event, index) => (
                      <TableRow
                        key={`${event.receivedAt}:${index}`}
                        className="align-top"
                      >
                        <TableCell className="whitespace-normal">
                          <time dateTime={event.observedAt}>
                            {dateLabel(event.observedAt)}
                          </time>
                        </TableCell>
                        <TableCell className="whitespace-normal break-words">
                          {event.adapterId} {event.version}
                        </TableCell>
                        <TableCell>{event.stream}</TableCell>
                        <TableCell>
                          <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                            {event.text}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              data &&
              data.collectionState !== "not_reported" && (
                <p className="py-4 text-sm text-muted-foreground">
                  当前筛选下没有日志记录。
                </p>
              )
            )}
            {data && (
              <p className="text-xs text-muted-foreground">
                最多保留 {data.retentionSeconds / 60} 分钟、{data.historyLimit}{" "}
                条；超过 {data.lineBytesLimit} 字节的整行不保留。
                {data.dropped > 0 &&
                  `最近批次的丢弃计数为 ${data.dropped}，不代表日志总行数。`}
                重启、断网或日志量过大可能导致记录缺失，这不是完整日志归档。
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

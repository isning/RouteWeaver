import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, RotateCw } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { ChoiceSelect } from "@/ui-patterns/choice-select";
import { Notice } from "@/ui-patterns/notice";
import { request } from "./api";
import { coreName } from "./infrastructure-data";
import { dateLabel } from "./model";
import type { CoreInstance, HostRecord } from "./types";

const categories: Record<string, { title: string; action: string }> = {
  listener_address_in_use: { title: "监听地址已被占用", action: "检查监听端口及占用它的进程。" },
  tls_certificate_file_missing: { title: "找不到 TLS 证书文件", action: "检查核心配置中的证书路径及文件是否存在。" },
  unsupported_protocol_configuration: { title: "协议配置不受支持", action: "核对所选核心版本支持的协议与配置。" },
  network_initialization_permission_denied: { title: "网络初始化权限不足", action: "检查核心进程所需的网络权限。" },
};
interface CoreDiagnosticView {
  instanceId: string;
  supported: boolean;
  collectionState: "not_reported" | "unsupported" | "recent" | "stale";
  lastReceivedAt: string | null;
  events: { adapterId: string; version: string; code: string; observedAt: string; receivedAt: string }[];
  omitted: number;
  dropped: number;
  retentionHours: number;
  historyLimit: number;
}
function usableView(value: CoreDiagnosticView, instanceId: string) {
  return value?.instanceId === instanceId && typeof value.supported === "boolean" &&
    ["not_reported", "unsupported", "recent", "stale"].includes(value.collectionState) &&
    (value.lastReceivedAt === null || Number.isFinite(Date.parse(value.lastReceivedAt))) &&
    Array.isArray(value.events) && value.events.length <= 128 && value.events.every(event => event &&
      typeof event.adapterId === "string" && typeof event.code === "string" && typeof event.version === "string" &&
      Number.isFinite(Date.parse(event.observedAt)) && Number.isFinite(Date.parse(event.receivedAt))) &&
    [value.omitted, value.dropped, value.retentionHours, value.historyLimit].every(n => Number.isSafeInteger(n) && n >= 0);
}

export function CoreDiagnosticsPanel({ host, instances }: { host: HostRecord; instances: CoreInstance[] }) {
  const cores = instances.filter(core => core.hostId === host.id);
  const [selected, setSelected] = useState("");
  const instance = cores.find(core => core.id === selected) || cores[0];
  return <section aria-label="核心诊断" className="min-w-0 space-y-4">
    {cores.length > 1 && <div className="max-w-sm"><ChoiceSelect aria-label="诊断核心" value={instance?.id} onValueChange={value => setSelected(value || "")} options={cores.map(core => ({ value: core.id, label: coreName(core) }))} /></div>}
    {instance ? <CoreDiagnosticDetails key={instance.id} instance={instance} /> : <p className="text-sm text-muted-foreground">添加核心后可查看诊断记录。</p>}
  </section>;
}
function CoreDiagnosticDetails({ instance }: { instance: CoreInstance }) {
  const query = useQuery({
    queryKey: ["core-diagnostics", instance.id, instance.adapterId, instance.version],
    queryFn: async () => {
      const value = await request<CoreDiagnosticView>(`/admin/instances/${encodeURIComponent(instance.id)}/core-diagnostics`);
      if (!usableView(value, instance.id)) throw new Error("诊断记录格式不正确");
      return value;
    },
    refetchInterval: 15000,
  });
  const data = query.data;
  const records = [...(data?.events || [])].reverse();
  return <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>核心诊断记录</CardTitle>
        <CardDescription className="text-xs">{data?.lastReceivedAt ? `最近收到 ${dateLabel(data.lastReceivedAt)}` : coreName(instance)}</CardDescription>
        <CardAction><ActionButton variant="outline" size="sm" leadingIcon={<RotateCw aria-hidden="true" />} pending={query.isFetching} keepFocusableWhilePending onClick={() => query.refetch()}>刷新</ActionButton></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isError && <Notice tone="warning">{data ? "诊断记录刷新失败，以下保留上次读取的记录。" : "无法读取诊断记录，请重试。"}</Notice>}
        {query.isPaused && <p role="status" className="text-sm text-muted-foreground">等待网络连接</p>}
        {query.isPending && !query.isPaused && <p role="status" className="text-sm text-muted-foreground">正在读取诊断记录…</p>}
        {data?.collectionState === "unsupported" && <Notice tone="info">当前核心版本不支持这项诊断采集。{records.length > 0 && "以下为此前版本的记录。"}</Notice>}
        {data?.collectionState === "not_reported" && <p role="status" className="text-sm text-muted-foreground">尚未收到诊断上报。请核对 Agent 的采集选项及连接。</p>}
        {data?.collectionState === "stale" && <Notice tone="warning">近期未收到诊断上报，以下记录不代表当前运行状态。</Notice>}
        {data && records.length === 0 && data.collectionState === "recent" && <p className="py-4 text-sm text-muted-foreground">查询范围内没有已识别的故障记录。</p>}
        {records.length > 0 && <div className="overflow-hidden rounded-lg border">
          <Table aria-label="故障记录" className="min-w-[700px] table-fixed text-xs">
            <colgroup><col className="w-[152px]" /><col className="w-[60px]" /><col className="w-[176px]" /><col /></colgroup>
            <TableHeader className="sr-only"><TableRow><TableHead>时间</TableHead><TableHead>级别</TableHead><TableHead>核心版本</TableHead><TableHead>诊断详情</TableHead></TableRow></TableHeader>
            <TableBody>{records.map((event, index) => {
              const category = Object.hasOwn(categories, event.code) ? categories[event.code] : undefined;
              return <TableRow key={`${event.receivedAt}:${index}`} className="align-top">
                <TableCell className="w-[152px] px-3 py-1.5 font-mono text-muted-foreground"><time dateTime={event.observedAt}>{dateLabel(event.observedAt)}</time></TableCell>
                <TableCell className="w-[60px] px-1.5 py-1.5"><Badge variant="outline" className="gap-1 text-[10px]"><CircleAlert aria-hidden="true" className="size-3" />故障</Badge></TableCell>
                <TableCell className="w-[176px] whitespace-normal break-words px-3 py-1.5 text-muted-foreground">{event.adapterId.replace("routeweaver/", "")} {event.version}</TableCell>
                <TableCell className="whitespace-normal break-words px-3 py-1.5"><p>{category?.title || "未识别的故障类别"}</p>{category && <p className="mt-1 text-muted-foreground">{category.action}</p>}</TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>}

      </CardContent>
    </Card>
    <Card className="min-w-0">
      <CardHeader><CardTitle>诊断采集</CardTitle><CardDescription className="text-xs">由节点 Agent 上传到平台</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>只显示已识别的故障类别，不包含原始日志、访问目标或客户端 IP。</p>
        <p>需在节点上启动 Agent 时添加 <code className="whitespace-nowrap text-foreground">--core-diagnostics</code>。</p>
        {data && <div className="flex items-center justify-between gap-3 border-t pt-3"><span>保留范围</span><span className="text-right font-medium text-foreground">{data.retentionHours} 小时 / {data.historyLimit} 条</span></div>}
        {data && (data.omitted > 0 || data.dropped > 0) && <p>最近一次上报：{data.omitted} 行未识别，{data.dropped} 行因采集限制丢弃。列表不代表全部故障。</p>}
      </CardContent>
    </Card>
  </div>;
}

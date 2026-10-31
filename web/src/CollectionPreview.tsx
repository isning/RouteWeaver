import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { DataTable } from "./DataTable";
import type { Collection, Preview, Source } from "./types";
import { processingStepLabel } from "./Pipeline";
function stageLabel(
  stage: NonNullable<Preview["stages"]>[number],
  collection: Collection,
  sources: Source[],
) {
  const sourceName = sources.find(
    (source) => source.id === stage.sourceId,
  )?.name;
  const steps =
    stage.scope === "source"
      ? collection.sources.find((source) => source.sourceId === stage.sourceId)
          ?.steps
      : stage.scope === "aggregate"
        ? collection.steps
        : undefined;
  const stepIndex = steps?.findIndex((step) => step.id === stage.stepId) ?? -1;
  if (steps && stepIndex >= 0) {
    const context = stage.scope === "source" ? sourceName || "来源" : "合并后";
    return `${context} · ${stepIndex + 1}. ${processingStepLabel(steps[stepIndex].kind)}`;
  }
  const scope =
    {
      raw: "原始输入",
      "source-result": "来源结果",
      source: "来源处理",
      merged: "有序合并",
      aggregate: "聚合处理",
    }[stage.scope || ""] || "处理阶段";
  return scope + (sourceName ? ` · ${sourceName}` : "");
}
export function CollectionPreview({
  value,
  sources,
  collection,
}: {
  value: Preview;
  sources: Source[];
  collection: Collection;
}) {
  const table = (nodes: Preview["endpoints"]) => (
    <DataTable
      rowKey="id"
      rows={nodes || []}
      columns={[
        { title: "名称", accessor: "name" },
        {
          title: "连接地址",
          render: (_, n) => {
            const host = n.connection?.host;
            if (!host) return "—";
            const address =
              host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
            return `${address}:${n.connection.port}`;
          },
        },
        { title: "地区", accessor: "region" },
        { title: "协议", render: (_, n) => n.connection?.protocol },
      ]}
      pageSize={8}
      compact
    />
  );
  return (
    <div className="preview-result space-y-4 border-t pt-6">
      <h3 className="text-sm font-semibold">逐阶段预览</h3>
      <Tabs defaultValue="final" className="min-w-0">
        <ScrollArea className="w-full min-w-0 overflow-hidden pb-3">
          <TabsList
            aria-label="处理阶段"
            className="w-max max-w-none flex-nowrap justify-start"
          >
            {[
              { key: "final", label: "最终结果" },
              ...(value.stages || []).map((stage, index) => ({
                key: String(index),
                label: stageLabel(stage, collection, sources),
              })),
            ].map((section) => (
              <TabsTrigger
                className="max-w-64 flex-none whitespace-nowrap"
                key={section.key}
                value={section.key}
                title={section.label}
              >
                <span className="min-w-0 truncate">{section.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        {[
          { key: "final", label: "最终结果", children: table(value.endpoints) },
          ...(value.stages || []).map((stage, index) => ({
            key: String(index),
            label: stageLabel(stage, collection, sources),
            children: (
              <>
                <p className="muted text-sm text-muted-foreground">
                  {stage.endpoints?.length || 0} 个节点 · 移除{" "}
                  {stage.removedIds?.length || 0} 个 · 修改{" "}
                  {stage.changedIds?.length || 0} 个
                </p>
                {table(stage.endpoints)}
              </>
            ),
          })),
        ].map((section) => (
          <TabsContent
            className="space-y-3"
            key={section.key}
            value={String(section.key)}
          >
            <h4 className="text-sm font-medium wrap-anywhere">
              {section.label}
            </h4>
            {section.children}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from "react";
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
    return `${context} 第 ${stepIndex + 1} 步：${processingStepLabel(steps[stepIndex].kind)}`;
  }
  const scope =
    {
      raw: "原始输入",
      "source-result": "来源结果",
      source: "来源处理",
      merged: "有序合并",
      aggregate: "聚合处理",
    }[stage.scope || ""] || "处理阶段";
  return scope + (sourceName ? ` ${sourceName}` : "");
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
  const stages = (value.stages || []).map((stage) => ({
    stage,
    // A display label and a position are not stage identity.
    key: JSON.stringify([
      collection.id,
      stage.scope || stage.stage || stage.name || "",
      stage.sourceId || "",
      stage.stepId || "",
    ]),
  }));
  const [selection, setSelection] = useState("final");
  const selected = stages.some(({ key }) => key === selection)
    ? selection
    : "final";
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const detachedFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (selection !== selected) setSelection(selected);
    const removed = detachedFocus.current;
    detachedFocus.current = null;
    if (
      removed === null ||
      removed === "final" ||
      stages.some(({ key }) => key === removed)
    ) return;
    const fallback = tabs.current.get("final");
    // A ref detaches before its DOM node is removed. Restore focus only when
    // that removed tab owned it, never when the user is editing elsewhere.
    if (
      fallback &&
      (document.activeElement === document.body || document.activeElement === null)
    ) {
      fallback.focus({ preventScroll: true });
    }
  });
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
      <Tabs value={selected} onValueChange={setSelection} className="min-w-0">
        <ScrollArea className="w-full min-w-0 overflow-hidden pb-3">
          <TabsList
            aria-label="处理阶段"
            className="w-max max-w-none flex-nowrap justify-start"
          >
            {[
              { key: "final", label: "最终结果" },
              ...stages.map(({ stage, key }) => ({
                key,
                label: stageLabel(stage, collection, sources),
              })),
            ].map((section) => (
              <TabsTrigger
                className="max-w-64 flex-none scroll-mx-1 whitespace-nowrap"
                key={section.key}
                value={section.key}
                title={section.label}
                onFocus={(event) => {
                  // Native focus can leave a partly visible tab clipped. Reveal
                  // the complete target on focus, not on every preview render,
                  // so manual rail scrolling and editor focus remain untouched.
                  event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
                }}
                ref={(node) => {
                  const previous = tabs.current.get(section.key);
                  if (!node && previous === document.activeElement) {
                    detachedFocus.current = section.key;
                  }
                  if (node) tabs.current.set(section.key, node);
                  else tabs.current.delete(section.key);
                }}
              >
                <span className="min-w-0 truncate">{section.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
        {[
          { key: "final", label: "最终结果", children: table(value.endpoints) },
          ...stages.map(({ stage, key }) => ({
            key,
            label: stageLabel(stage, collection, sources),
            children: (
              <>
                <div className="muted grid gap-1 text-sm text-muted-foreground">
                  <p>{stage.endpoints?.length || 0} 个节点</p>
                  {(stage.comparison === "step-input" ||
                    (!stage.comparison &&
                      !!stage.stepId &&
                      (stage.scope === "source" ||
                        stage.scope === "aggregate"))) && (
                    <div className="space-y-1">
                      <p>相对此步骤输入</p>
                      <p className="flex flex-wrap gap-x-3 gap-y-1">
                        <span>新增 {stage.addedIds?.length || 0} 个</span>
                        <span>移除 {stage.removedIds?.length || 0} 个</span>
                        <span>修改 {stage.changedIds?.length || 0} 个</span>
                      </p>
                    </div>
                  )}
                </div>
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

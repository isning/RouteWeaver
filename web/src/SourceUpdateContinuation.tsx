import { TaskSheet } from "@/ui-patterns/task-overlays";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { Notice } from "@/ui-patterns/notice";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/ui-patterns/actions";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { list } from "./api";
import type {
  Output,
  Source,
  SourceApplicationResult,
  SourceCandidate,
  SourceChange,
} from "./types";
export const sourceChangeFields: Record<string, string> = {
  host: "服务器地址",
  port: "端口",
  protocol: "协议",
  username: "登录名",
  password: "登录密码",
  uuid: "身份凭据",
  method: "加密方式",
  flow: "流控",
  packetEncoding: "数据包编码",
  tls: "TLS 设置",
  "tls.enabled": "TLS 开关",
  "tls.serverName": "服务器名称",
  "tls.fingerprint": "TLS 指纹",
  "tls.alpn": "TLS 协商",
  "tls.reality": "REALITY 设置",
  "tls.reality.publicKey": "REALITY 公钥",
  "tls.reality.shortId": "REALITY 标识",
  transport: "传输设置",
  "transport.type": "传输方式",
  "transport.path": "传输路径",
  "transport.host": "传输主机",
  "transport.serviceName": "服务名称",
};
// Session-only evidence, deliberately not a Source or a candidate snapshot.
// Never retain connection descriptions, credentials, private source URLs or input.
type AcceptedChange = Pick<SourceChange, "id" | "name" | "fields">;
export interface SourceAcceptanceReceipt {
  sourceId: string;
  sourceName: string;
  acceptedAt: string;
  diff: {
    beforeCount: number;
    afterCount: number;
    added: AcceptedChange[];
    removed: AcceptedChange[];
    connectionChanged: AcceptedChange[];
    renamed: AcceptedChange[];
    reordered: boolean;
  };
  affected: SourceCandidate["affected"];
  affectedVerified: boolean;
}

function appliedImpacts(source: Source, result: SourceApplicationResult) {
  const application = result.application;
  if (
    result.id !== source.id ||
    typeof result.revision !== "string" ||
    !result.revision ||
    result.revision === source.revision ||
    !application ||
    typeof application.candidateId !== "string" ||
    !application.candidateId ||
    application.candidateId !== source.candidate?.id ||
    application.sourceRevision !== result.revision ||
    !Array.isArray(application.affected) ||
    !application.affected.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        [
          "collection",
          "profile",
          "group",
          "default",
          "rule",
          "subscription",
        ].includes(item.kind) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.name === "string" &&
        typeof item.reason === "string" &&
        (item.profileName === undefined ||
          typeof item.profileName === "string"),
    )
  )
    return null;
  return application.affected;
}
export function sourceAcceptanceReceipt(
  source: Source,
  result: SourceApplicationResult,
): SourceAcceptanceReceipt {
  const candidate = source.candidate!;
  const affected = appliedImpacts(source, result);
  const changes = (items: SourceChange[]): AcceptedChange[] =>
    items.map((item) => ({
      id: item.id,
      name: item.name,
      ...(item.fields ? { fields: [...item.fields] } : {}),
    }));
  return {
    sourceId: source.id,
    sourceName: source.name,
    acceptedAt: result.applyHistory?.[0]?.appliedAt || result.updatedAt || "",
    diff: {
      beforeCount: candidate.diff.beforeCount,
      afterCount: candidate.diff.afterCount,
      added: changes(candidate.diff.added),
      removed: changes(candidate.diff.removed),
      connectionChanged: changes(candidate.diff.connectionChanged),
      renamed: changes(candidate.diff.renamed),
      reordered: !!candidate.diff.reordered,
    },
    // The candidate's impact list can predate new, renamed or removed dependents.
    // A legacy/incomplete response still confirms the source write, not its links.
    affectedVerified: affected !== null,
    affected: (affected || []).map((item) => ({
      kind: item.kind,
      id: item.id,
      name: item.name,
      reason: item.reason,
      ...(item.profileName ? { profileName: item.profileName } : {}),
    })),
  };
}
const kinds: Record<string, string> = {
  collection: "集合",
  group: "分组",
  default: "默认流量",
  rule: "分流规则",
};
const visibleName = (value: string) => value.trim().replace(/\s+/g, " ");
const sameNames = (items: SourceAcceptanceReceipt["affected"], name: string) =>
  items.filter((item) => visibleName(item.name) === visibleName(name));
function relatedDescriptions(
  items: SourceAcceptanceReceipt["affected"],
  target: "profile" | "output",
  profiles: SourceAcceptanceReceipt["affected"],
  outputs?: Output[],
): Map<string, string> {
  const clientLabel = (output?: Output) => {
    if (
      !output?.target?.adapterId ||
      !["full", "nodes-only"].includes(output.mode)
    )
      return undefined;
    return `${output.target.adapterId} ${output.mode === "nodes-only" ? "纯节点" : "完整配置"}`;
  };
  const basic = new Map<string, string | undefined>(
    items.map((item) => {
      if (target === "output")
        return [
          item.id,
          clientLabel(outputs?.find((output) => output.id === item.id)),
        ];
      const related = outputs
        ?.filter((output) => output.profileId === item.id)
        .sort(
          (a, b) =>
            `${visibleName(a.name)} ${clientLabel(a) || ""}`.localeCompare(
              `${visibleName(b.name)} ${clientLabel(b) || ""}`,
            ) || a.id.localeCompare(b.id),
        );
      if (
        !related?.length ||
        related.slice(0, 2).some((output) => !clientLabel(output))
      )
        return [item.id, undefined];
      return [
        item.id,
        `关联订阅：${related
          .slice(0, 2)
          .map(
            (output) => `${visibleName(output.name)}（${clientLabel(output)}）`,
          )
          .join(
            "、",
          )}${related.length > 2 ? ` 等 ${related.length} 个订阅` : ""}`,
      ];
    }),
  );
  const summaries = new Map<string, string | undefined>(
    items.map((item) => {
      const base = basic.get(item.id);
      if (
        target !== "output" ||
        !base ||
        sameNames(items, item.name).filter(
          (other) =>
            visibleName(basic.get(other.id) || "") === visibleName(base),
        ).length < 2
      )
        return [item.id, base];
      const output = outputs?.find((output) => output.id === item.id);
      const profile = profiles.find(
        (profile) => profile.id === output?.profileId,
      );
      return [
        item.id,
        profile ? `${base} 所属配置：${visibleName(profile.name)}` : base,
      ];
    }),
  );
  return new Map(
    items
      .filter((item) => sameNames(items, item.name).length > 1)
      .map((item) => {
        const summary = summaries.get(item.id);
        const ambiguous =
          !summary ||
          sameNames(items, item.name).some(
            (other) =>
              other.id !== item.id &&
              visibleName(summaries.get(other.id) || "") ===
                visibleName(summary),
          );
        const identity = `${target === "profile" ? "配置" : "订阅"}标识：${item.id}`;
        return [
          item.id,
          ambiguous ? [summary, identity].filter(Boolean).join(" ") : summary!,
        ];
      }),
  );
}
function RelatedObjects({
  title,
  items,
  target,
  descriptions,
}: {
  title: string;
  items: SourceAcceptanceReceipt["affected"];
  target: "profile" | "output";
  descriptions: Map<string, string>;
}) {
  const [page, setPage] = useState(1);
  const current = Math.min(page, Math.max(1, Math.ceil(items.length / 8)));
  if (!items.length) return null;
  return (
    <section className="source-change-section my-6 space-y-3 [&>h3]:text-sm [&>h3]:font-medium">
      <h3 className="flex flex-wrap items-baseline gap-2">
        <span>{title}</span>{" "}
        <span className="text-muted-foreground">{items.length}</span>
      </h3>
      <ul className="source-change-list divide-y overflow-hidden rounded-lg border [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere">
        {items.slice((current - 1) * 8, current * 8).map((item) => (
          <li key={item.id}>
            <span className="source-change-identity flex min-w-0 flex-col gap-1">
              <span>{item.name}</span>
              {descriptions.get(item.id) && (
                <small className="muted text-sm text-muted-foreground whitespace-normal wrap-anywhere">
                  {descriptions.get(item.id)}
                </small>
              )}
            </span>
            <ActionButton
              aria-label={`${target === "profile" ? "查看配置" : "查看订阅"} ${item.name}${descriptions.get(item.id) ? ` ${descriptions.get(item.id)}` : ""}`}
              variant="link"
              asChild={true}
            >
              <a
                href={`#subscriptions?${target}=${encodeURIComponent(item.id)}`}
                aria-label={`${target === "profile" ? "查看配置" : "查看订阅"} ${item.name}${descriptions.get(item.id) ? ` ${descriptions.get(item.id)}` : ""}`}
              >
                {target === "profile" ? "查看配置" : "查看订阅"}
              </a>
            </ActionButton>
          </li>
        ))}
      </ul>
      {items.length > 8 && (
        <PageNavigation
          page={current}
          pageSize={8}
          total={items.length}
          onPageChange={setPage}
        />
      )}
    </section>
  );
}
function AcceptedChanges({
  title,
  items,
}: {
  title: string;
  items: AcceptedChange[];
}) {
  const [page, setPage] = useState(1);
  const current = Math.min(page, Math.max(1, Math.ceil(items.length / 12)));
  if (!items.length) return null;
  return (
    <section className="source-change-section my-6 space-y-3 [&>h3]:text-sm [&>h3]:font-medium">
      <h3 className="flex flex-wrap items-baseline gap-2">
        <span>{title}</span>{" "}
        <span className="text-muted-foreground">{items.length}</span>
      </h3>
      <ul className="source-change-list divide-y overflow-hidden rounded-lg border [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere">
        {items.slice((current - 1) * 12, current * 12).map((item) => (
          <li key={item.id}>
            <span>{item.name}</span>
            {item.fields?.length ? (
              <span className="source-change-fields flex flex-wrap gap-1">
                {item.fields.map((field) => (
                  <Badge key={field} variant="secondary">
                    {sourceChangeFields[field] || "连接设置"}
                  </Badge>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {items.length > 12 && (
        <PageNavigation
          page={current}
          pageSize={12}
          total={items.length}
          onPageChange={setPage}
        />
      )}
    </section>
  );
}
export function SourceUpdateContinuation({
  receipt,
  onClose,
}: {
  receipt: SourceAcceptanceReceipt | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const unique = (kinds: string[]) => [
    ...new Map(
      (receipt?.affected || [])
        .filter((item) => kinds.includes(item.kind))
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const profiles = unique(["default", "profile"]);
  const outputs = unique(["subscription"]);
  const needsMetadata = [profiles, outputs].some((items) =>
    items.some((item) => sameNames(items, item.name).length > 1),
  );
  const metadata = useQuery({
    // Instance scope prevents reuse across authenticated page remounts. No private
    // input is retained in receipts; this reads metadata, never access or preview.
    queryKey: [
      "outputs",
      "source-acceptance",
      titleId,
      receipt?.sourceId,
      receipt?.acceptedAt,
    ],
    queryFn: () => list<Output>("/me/outputs"),
    enabled: !!receipt && needsMetadata,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const currentMetadata =
    metadata.isSuccess && !metadata.isFetching ? metadata.data : undefined;
  return (
    <TaskSheet
      title={<span id={titleId}>上次应用详情</span>}
      aria-labelledby={titleId}
      open={!!receipt}
      footer={
        <div className="form-footer mt-6 flex flex-wrap items-center justify-end gap-2">
          <ActionButton aria-label="完成" onClick={onClose} variant="default">
            完成
          </ActionButton>
        </div>
      }
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      size="lg"
    >
      {receipt && (
        <>
          <p className="source-update-intro mb-6 flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/30 p-4 wrap-anywhere [&>span]:text-sm [&>span]:text-muted-foreground">
            <strong>{receipt.sourceName}</strong>
            <span>
              {receipt.diff.beforeCount} 个选项 → {receipt.diff.afterCount}{" "}
              个选项
            </span>
          </p>
          <p>来源已更新，已发布订阅未改变。</p>
          {!receipt.affectedVerified && (
            <Notice
              tone="warning"
              title="相关配置暂无法核对"
              action={
                <ActionButton variant="outline" asChild>
                  <a href="#subscriptions">查看我的订阅</a>
                </ActionButton>
              }
            />
          )}
          {needsMetadata && metadata.isError && (
            <Notice
              tone="warning"
              title="暂无法读取订阅信息"
              action={
                <ActionButton
                  onClick={() => metadata.refetch()}
                  variant="outline"
                >
                  重试读取
                </ActionButton>
              }
            />
          )}
          <RelatedObjects
            key={`${receipt.sourceId}:${receipt.acceptedAt}:profiles`}
            title="相关分流配置"
            items={profiles}
            target="profile"
            descriptions={relatedDescriptions(
              profiles,
              "profile",
              profiles,
              currentMetadata,
            )}
          />
          <RelatedObjects
            key={`${receipt.sourceId}:${receipt.acceptedAt}:outputs`}
            title="相关客户端订阅"
            items={outputs}
            target="output"
            descriptions={relatedDescriptions(
              outputs,
              "output",
              profiles,
              currentMetadata,
            )}
          />
          <Accordion type="multiple">
            {[
              {
                key: "evidence",
                label: "查看本次更新",
                children: (
                  <>
                    {(
                      [
                        ["移除", receipt.diff.removed],
                        ["连接变更", receipt.diff.connectionChanged],
                        ["新增", receipt.diff.added],
                        ["名称变更", receipt.diff.renamed],
                      ] as const
                    ).map(([title, items]) => (
                      <AcceptedChanges
                        key={`${receipt.sourceId}:${receipt.acceptedAt}:${title}`}
                        title={title}
                        items={items}
                      />
                    ))}
                    {receipt.diff.reordered && (
                      <p>来源中的选项顺序发生了变化。</p>
                    )}
                    <ul className="source-change-list divide-y overflow-hidden rounded-lg border [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:justify-between [&>li]:gap-2 [&>li]:px-4 [&>li]:py-3 [&>li]:wrap-anywhere">
                      {receipt.affected
                        .filter(
                          (item) =>
                            !["profile", "subscription"].includes(item.kind),
                        )
                        .map((item, index) => (
                          <li key={`${item.kind}:${item.id}:${index}`}>
                            <span>
                              {item.name}
                              {item.profileName && (
                                <small className="block text-muted-foreground">
                                  {item.profileName}
                                </small>
                              )}
                            </span>
                            <Badge variant="secondary">
                              {kinds[item.kind] || "相关配置"}
                            </Badge>
                          </li>
                        ))}
                    </ul>
                  </>
                ),
              },
            ].map((section) => (
              <AccordionItem
                key={section.key}
                value={String(section.key)}
                disabled={
                  "collapsible" in section && section.collapsible === "disabled"
                }
              >
                <AccordionTrigger>{section.label}</AccordionTrigger>
                <AccordionContent
                  forceMount
                  className="data-[state=closed]:hidden"
                >
                  {section.children}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </>
      )}
    </TaskSheet>
  );
}

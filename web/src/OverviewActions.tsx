import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, FilePenLine } from "lucide-react";
import { list, request } from "./api";
import type { Output, Overview, Profile, RuleResource, Source } from "./types";
import {
  sourceHasFailure,
  sourceIssueText,
  sourceStatusUnknown,
} from "./source-failure";
import { ActionButton } from "@/ui-patterns/actions";

interface ActionItem {
  id: string;
  kind: string;
  title: string;
  description: string;
  href: string;
  priority: "high" | "normal";
}
interface ActionSummary {
  asOf: string;
  items: ActionItem[];
  partial: boolean;
  platformRouteIds?: string[];
  platformRoutesComplete?: boolean;
}

/** Read-only overview. Every action opens the existing review/edit workflow. */
export function OverviewActions({
  go,
  overview,
  now = Date.now(),
}: {
  go(hash: string): void;
  overview?: Overview;
  now?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => list<Source>("/me/sources"),
  });
  const resources = useQuery({
    queryKey: ["resources"],
    queryFn: () => list<RuleResource>("/me/resources"),
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => list<Profile>("/me/profiles"),
  });
  const outputs = useQuery({
    queryKey: ["outputs"],
    queryFn: () => list<Output>("/me/outputs"),
  });
  const summary = useQuery({
    queryKey: ["overview-actions"],
    queryFn: () => request<ActionSummary>("/me/actions"),
    staleTime: 0,
  });
  const items: (ActionItem & { label: string })[] = [];
  for (const source of sources.data ?? []) {
    if (!source.enabled || sourceStatusUnknown(source)) continue;
    const failed = sourceHasFailure(source);
    if (!failed && !source.candidate) continue;
    items.push({
      id: `source:${source.id}`,
      kind: "source",
      title: `${source.name} ${failed ? "更新失败" : "有待确认的更新"}`,
      description: failed
        ? (sourceIssueText(source) ?? "检查来源设置后重试。")
        : "查看变化后再应用。",
      href: `#sources?source=${encodeURIComponent(source.id)}${failed ? "" : "&review=1"}`,
      priority: failed ? "high" : "normal",
      label: failed ? "检查来源" : "查看变化",
    });
  }
  for (const resource of resources.data ?? []) {
    if (resource.refreshStatus !== "failed" || !resource.canRefresh) continue;
    items.push({
      id: `resource:${resource.id}`,
      kind: "resource",
      title: `${resource.name} 更新失败`,
      description: resource.acceptedVersion
        ? "仍使用上次接纳的规则。"
        : "检查规则文件后重新导入。",
      href: `#resources?resource=${encodeURIComponent(resource.id)}`,
      priority: "high",
      label: "检查规则",
    });
  }
  for (const item of summary.data?.items ?? []) {
    // The API returns app-local navigation only; never render a server URL as an external action.
    if (
      !/^#(?:subscriptions|overview|account-security)(?:\?|$)/.test(item.href)
    )
      continue;
    const outputId = new URLSearchParams(item.href.split("?")[1] ?? "").get(
      "output",
    );
    const output = outputs.data?.find((output) => output.id === outputId);
    items.push({
      ...item,
      title: output?.name ? `${output.name}：${item.title}` : item.title,
      label: item.kind.startsWith("output-") ? "检查订阅" : "查看详情",
    });
  }
  const platformApplies =
    overview &&
    summary.isSuccess &&
    !summary.isFetching &&
    !summary.isPaused &&
    summary.data.platformRoutesComplete === true &&
    overview.user.enabled &&
    !overview.accountingPending &&
    ["active", "exhausted"].includes(overview.status) &&
    overview.routes.some((route) =>
      summary.data.platformRouteIds?.includes(route.id),
    );
  if (platformApplies) {
    const remaining = overview.remainingBytes;
    if (
      Number.isSafeInteger(overview.quotaBytes) &&
      overview.quotaBytes > 0 &&
      remaining !== undefined &&
      Number.isSafeInteger(remaining) &&
      remaining >= 0 &&
      remaining <= overview.quotaBytes / 10
    ) {
      items.push({
        id: "account:quota",
        kind: "quota-low",
        title: remaining === 0 ? "平台流量已用尽" : "平台流量剩余不足 10%",
        description: "查看本周期用量和重置时间。",
        href: "#overview",
        priority: "high",
        label: "查看用量",
      });
    }
    const expires = Date.parse(
      overview.entitlement?.expiresAt || overview.user.expiresAt || "",
    );
    if (
      Number.isFinite(expires) &&
      expires > now &&
      expires - now <= 72 * 60 * 60 * 1000
    ) {
      items.push({
        id: "account:expiry",
        kind: "entitlement-expiring",
        title: "平台服务即将到期",
        description: "查看到期时间。",
        href: "#overview",
        priority: "normal",
        label: "查看服务",
      });
    }
  }
  const navigate = (href: string) => {
    if (href === "#overview") {
      const details = document.getElementById("overview-account-details");
      details?.scrollIntoView({ block: "start" });
      details?.focus({ preventScroll: true });
    } else go(href);
  };
  items.sort(
    (a, b) =>
      Number(b.priority === "high") - Number(a.priority === "high") ||
      a.id.localeCompare(b.id),
  );
  const queries = [sources, resources, profiles, outputs, summary];
  const unavailable = queries.some((q) => q.isError || q.isPaused);
  const loading = queries.some((q) => q.isPending && !q.isPaused);
  // No-output profiles are drafts, not incidents. Revoked subscriptions remain deliberate decisions.
  const drafts =
    profiles.isSuccess && outputs.isSuccess
      ? profiles.data.filter(
          (p) => !outputs.data.some((o) => o.profileId === p.id),
        )
      : [];
  const retry = () => {
    for (const query of queries)
      if (query.isError || query.isPaused) void query.refetch();
  };
  return (
    <div className="space-y-3">
      {(items.length > 0 ||
        unavailable ||
        loading ||
        summary.data?.partial) && (
        <section
          aria-labelledby="home-attention"
          className="rounded-xl border bg-card text-card-foreground"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <h2 id="home-attention" className="text-sm font-semibold">
              需要你处理{" "}
              <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                {items.length > 0 ? `${items.length} 项` : ""}
              </span>
            </h2>
          </div>
          {loading && (
            <p
              role="status"
              className="px-4 pb-3 text-sm text-muted-foreground"
            >
              正在读取待办…
            </p>
          )}
          {(unavailable || summary.data?.partial) && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 px-4 pb-3 text-sm text-muted-foreground"
            >
              <span>
                {unavailable
                  ? "部分待办未能更新，已有结果可能过时。"
                  : "部分订阅尚未检查。"}
              </span>
              {unavailable ? (
                <ActionButton size="sm" variant="ghost" onClick={retry}>
                  重试
                </ActionButton>
              ) : (
                <ActionButton
                  size="sm"
                  variant="ghost"
                  onClick={() => go("#subscriptions")}
                >
                  查看订阅
                </ActionButton>
              )}
            </div>
          )}
          <ul className="divide-y">
            {(expanded ? items : items.slice(0, 4)).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <CircleAlert
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm font-medium wrap-anywhere">
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
                <ActionButton
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(item.href)}
                >
                  {item.label}
                </ActionButton>
              </li>
            ))}
          </ul>
          {items.length > 4 && (
            <ActionButton
              size="sm"
              variant="ghost"
              className="m-2"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "收起" : `展开其余 ${items.length - 4} 项`}
            </ActionButton>
          )}
        </section>
      )}
      {drafts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <FilePenLine aria-hidden="true" className="size-4" />
          <span>{drafts.length} 份草稿</span>
          <ActionButton
            size="sm"
            variant="ghost"
            onClick={() =>
              go(
                drafts.length === 1
                  ? `#subscriptions?profile=${encodeURIComponent(drafts[0].id)}`
                  : "#subscriptions",
              )
            }
          >
            继续配置
          </ActionButton>
        </div>
      )}
    </div>
  );
}

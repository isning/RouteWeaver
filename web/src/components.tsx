import { ArrowLeft, ArrowRight, RotateCw, Inbox } from "lucide-react";
import {
  useId,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/ui-patterns/actions";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
} from "@/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Notice } from "@/ui-patterns/notice";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  action,
  back,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  back?: () => void;
}) {
  return (
    <header className="page-heading flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1.5">
        {back && (
          <ActionButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={back}
            className="-ml-2 mb-2"
          >
            <ArrowLeft aria-hidden="true" />
            返回
          </ActionButton>
        )}
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
        {description && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && (
        <div className="heading-action flex flex-wrap items-center gap-2">
          {action}
        </div>
      )}
    </header>
  );
}
export function Section({
  title,
  description,
  extra,
  children,
  className,
  variant = "card",
}: {
  title?: string;
  description?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  variant?: "card" | "plain";
}) {
  if (variant === "plain")
    return (
      <section className={cn("surface min-w-0 space-y-4", className)}>
        {(title || description || extra) && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
              {title && <h2 className="text-base font-medium">{title}</h2>}
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
            </div>
            {extra}
          </div>
        )}
        {children}
      </section>
    );
  return (
    <Card className={cn("surface min-w-0", className)}>
      {(title || description || extra) && (
        <CardHeader className="min-w-0 [overflow-wrap:anywhere]">
          {title && (
            <CardTitle role="heading" aria-level={2}>
              {title}
            </CardTitle>
          )}
          {description && <CardDescription>{description}</CardDescription>}
          {extra && <CardAction>{extra}</CardAction>}
        </CardHeader>
      )}
      <CardContent className="min-w-0 space-y-4">{children}</CardContent>
    </Card>
  );
}
export function QueryState({
  loading,
  error,
  retry,
  children,
}: {
  loading?: boolean;
  error?: Error | null;
  retry?: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div
        className="space-y-3 rounded-xl border p-6"
        aria-label="正在加载"
        aria-busy="true"
      >
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  if (error)
    return (
      <Notice
        tone="error"
        title="暂时无法加载"
        action={retry && (
          <Button type="button" variant="outline" onClick={retry}>
            <RotateCw aria-hidden="true" />
            重试
          </Button>
        )}
      >
        {error.message}
      </Notice>
    );
  return <>{children}</>;
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
export type ErrorNoticeFocusHandle = { focus: () => boolean };
export function ErrorNotice({
  error,
  focusRef,
}: {
  error: Error | null | undefined;
  focusRef?: Ref<ErrorNoticeFocusHandle>;
}) {
  const summary = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  useImperativeHandle(
    focusRef,
    () => ({
      focus: () => {
        const element = summary.current;
        if (
          !element?.isConnected ||
          !document.hasFocus() ||
          element.closest(
            '[hidden],[inert],[aria-hidden="true"],[data-session-workspace][aria-busy="true"]',
          )
        )
          return false;
        for (
          let node: HTMLElement | null = element;
          node;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden")
            return false;
        }
        const activeDialog = document.activeElement?.closest('[role="dialog"]');
        if (activeDialog && activeDialog !== element.closest('[role="dialog"]'))
          return false;
        // Only an explicit caller-owned handoff focuses the named summary.
        // Its nested alert remains passive, as do ordinary notices.
        element.tabIndex = -1;
        element.focus({ preventScroll: true });
        if (!element.isConnected || document.activeElement !== element)
          return false;
        element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        return true;
      },
    }),
    [],
  );
  if (!error) return null;
  if (focusRef)
    return (
      <div
        ref={summary}
        className="form-error"
        role="group"
        aria-labelledby={`${summaryId}-title`}
        aria-describedby={`${summaryId}-message`}
      >
        <Notice
          tone="error"
          title={<span id={`${summaryId}-title`}>操作未完成</span>}
        >
          <span id={`${summaryId}-message`}>{error.message}</span>
        </Notice>
      </div>
    );
  return (
    <Notice className="form-error" tone="error" title="操作未完成">
      {error.message}
    </Notice>
  );
}
export function Status({ value }: { value?: string }) {
  const labels: Record<string, [string, string]> = {
    active: ["生效中", "success"],
    "not-started": ["尚未开始", "default"],
    exhausted: ["额度已用尽", "warning"],
    published: ["已发布", "success"],
    enabled: ["已启用", "success"],
    disabled: ["已暂停", "default"],
    revoked: ["已撤销", "default"],
    draft: ["草稿", "processing"],
    expired: ["已到期", "warning"],
    rendered: ["已生成", "blue"],
    unregistered: ["未接入", "default"],
    healthy: ["在线", "success"],
    offline: ["离线", "error"],
    "accounting-pending": ["等待统计同步", "processing"],
    pending: ["处理中", "processing"],
    failed: ["未完成", "error"],
  };
  const [text, color] = labels[value || ""] || [value || "未设置", "default"];
  return (
    <Badge variant={color === "error" ? "destructive" : "secondary"}>
      {text}
    </Badge>
  );
}
export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="metric min-w-0 space-y-1">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}
export function TextLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      onClick={onClick}
      className="h-auto p-0"
    >
      {children}
      <ArrowRight aria-hidden="true" />
    </Button>
  );
}
export function CodePreview({
  content,
  tabIndex = 0,
}: {
  content: string;
  tabIndex?: 0 | -1;
}) {
  return (
    <pre
      className="code-preview max-h-40 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-h-96"
      tabIndex={tabIndex}
      aria-label="配置预览"
    >
      {content}
    </pre>
  );
}
export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="key-value flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-medium">{children}</span>
    </div>
  );
}

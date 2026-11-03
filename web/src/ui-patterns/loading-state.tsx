import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
export type LoadingLayout =
  "table" | "cards" | "form" | "field" | "subscriptions" | "summary";
/** Placeholders describe layout, never counts, health, or successful reads. */
function ContentSkeleton({ layout }: { layout: LoadingLayout }) {
  if (layout === "field")
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  if (layout === "form")
    return (
      <div className="max-w-3xl space-y-6 rounded-xl border bg-card p-4 sm:p-6">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-3/4" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
    );
  if (layout === "summary")
    return (
      <div className="space-y-4 rounded-xl border bg-card p-4">
        <Skeleton className="h-5 w-32" />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-5 w-56 max-w-full" />
        </div>
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-8 w-40" />
      </div>
    );
  if (layout === "subscriptions")
    return (
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-4 border-b p-4 sm:px-5">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-40 max-w-full" />
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
          <Skeleton className="h-9 w-24 shrink-0" />
        </div>
        {[0, 1].map((row) => (
          <div
            key={row}
            className="flex flex-wrap items-center justify-between gap-4 border-b p-4 sm:px-5"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-5 w-48 max-w-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-9 w-24" />
          </div>
        ))}
        <div className="flex justify-end px-4 py-2">
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
    );
  if (layout === "cards")
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <div key={card} className="space-y-5 rounded-xl border bg-card p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0" />
              <Skeleton className="h-5 w-40" />
            </div>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <div className="flex gap-2 border-t pt-4">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex h-10 items-center gap-6 border-b bg-muted/40 px-4">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="ml-auto h-3 w-24" />
      </div>
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
        >
          <div className="space-y-2">
            <Skeleton className={row % 2 ? "h-4 w-2/3" : "h-4 w-1/2"} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="hidden h-4 w-3/4 sm:block" />
          <Skeleton className="h-7 w-16" />
        </div>
      ))}
    </div>
  );
}
export function LoadingState({
  layout = "table",
  label = "正在加载",
  className,
}: {
  layout?: LoadingLayout;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("min-w-0", className)}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <ContentSkeleton layout={layout} />
      </div>
    </div>
  );
}
export function PageSkeleton({ page }: { page: string }) {
  const layout: LoadingLayout = [
    "subscriptions",
    "profiles",
    "outputs",
  ].includes(page)
    ? "subscriptions"
    : ["settings", "account-security"].includes(page)
      ? "form"
      : page === "servers"
        ? "cards"
        : "table";
  return (
    <div
      role="status"
      aria-label="正在打开页面"
      aria-busy="true"
      className="space-y-6"
    >
      <span className="sr-only">正在打开页面</span>
      <div aria-hidden="true" className="space-y-6">
        <div className="flex min-h-9 items-center justify-between gap-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-28" />
        </div>
        {layout !== "form" && <Skeleton className="h-9 w-full sm:w-80" />}
        <ContentSkeleton layout={layout} />
        {layout === "subscriptions" && <ContentSkeleton layout="summary" />}
      </div>
    </div>
  );
}

/** Counts describe a confirmed collection or loaded subset, never an inferred quota. */
export function ItemCount({
  total,
  matched,
  unit = "项",
  scope = "total",
}: {
  total: number;
  matched?: number;
  unit?: string;
  scope?: "total" | "loaded";
}) {
  return (
    <span
      className="inline-flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted-foreground"
      aria-live="polite"
      aria-atomic="true"
    >
      {matched !== undefined && (
        <span>
          找到{" "}
          <strong className="font-medium tabular-nums text-foreground">
            {matched}
          </strong>{" "}
          {unit}
        </span>
      )}
      <span>
        {scope === "loaded" ? "已加载" : "共"}{" "}
        <strong className="font-medium tabular-nums text-foreground">
          {total}
        </strong>{" "}
        {unit}
      </span>
    </span>
  );
}

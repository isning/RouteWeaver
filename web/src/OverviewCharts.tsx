import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChartTooltip } from "./ChartTooltip";
import { bytesLabel } from "./model";

function useChartSelection(identity: string) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [observedSelection, setSelection] = useState<{
    identity: string;
    index: number;
    x: number;
    y: number;
  }>();
  // A refreshed array must never reuse another date or route at the same index.
  const selection = observedSelection?.identity === identity ? observedSelection : undefined;
  const pinned = useRef(false);
  const source = useRef<"keyboard" | "pointer">("pointer");
  useEffect(() => {
    pinned.current = false;
    setSelection(undefined);
  }, [identity]);
  useEffect(() => {
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        pinned.current = false;
        setSelection(undefined);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  const focus = (index: number, event: FocusEvent<HTMLButtonElement>) => {
    source.current = "keyboard";
    const parent = ref.current!.getBoundingClientRect();
    const target = event.currentTarget.getBoundingClientRect();
    setSelection({
      identity,
      index,
      x: target.left - parent.left + target.width / 2,
      y: target.top - parent.top + target.height / 2,
    });
  };
  const pointer = (index: number, event: PointerEvent<HTMLButtonElement>) => {
    source.current = "pointer";
    const parent = ref.current!.getBoundingClientRect();
    setSelection({
      identity,
      index,
      x: event.clientX - parent.left,
      y: event.clientY - parent.top,
    });
  };
  return {
    ref,
    id,
    selection,
    container: {
      onPointerLeave: () => {
        if (!pinned.current && source.current !== "keyboard")
          setSelection(undefined);
      },
      onBlur: (event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          pinned.current = false;
          setSelection(undefined);
        }
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          pinned.current = false;
          setSelection(undefined);
        }
      },
    },
    button: (index: number) => ({
      "aria-describedby": selection?.index === index ? id : undefined,
      onFocus: (event: FocusEvent<HTMLButtonElement>) => focus(index, event),
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "touch") {
          pinned.current = false;
          pointer(index, event);
        }
      },
      onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.pointerType !== "touch") pointer(index, event);
      },
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        pinned.current = event.pointerType === "touch";
        pointer(index, event);
      },
      onClick: (event: MouseEvent<HTMLButtonElement>) => {
        if (event.detail !== 0) {
          source.current = "pointer";
          return;
        }
        const parent = ref.current!.getBoundingClientRect(),
          target = event.currentTarget.getBoundingClientRect();
        setSelection({
          identity,
          index,
          x: target.left - parent.left + target.width / 2,
          y: target.top - parent.top + target.height / 2,
        });
      },
    }),
  };
}
function ValueRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between gap-5 py-0.5">
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${color}`}
        />
        {label}
      </span>
      <span className="text-right font-medium tabular-nums">
        {bytesLabel(value)}
        <span className="block text-[10px] font-normal text-muted-foreground">
          {value.toLocaleString()} B
        </span>
      </span>
    </div>
  );
}
export function DailyUsageChart({
  daily,
  timezone,
}: {
  daily: { date: string; rawBytes: number; weightedBytes: number }[];
  timezone: string;
}) {
  const chart = useChartSelection(JSON.stringify(daily.map(day => day.date)));
  const max = Math.max(1, ...daily.map((day) => day.weightedBytes));
  const active = chart.selection && daily[chart.selection.index];
  return (
    <div ref={chart.ref} {...chart.container} className="relative mt-4">
      <ol aria-label="每日额度消耗" className="flex h-32 items-end gap-1.5">
        {daily.map((day, index) => (
          <li
            key={day.date}
            className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
          >
            <button
              type="button"
              {...chart.button(index)}
              aria-label={`${day.date}用量`}
              className="relative flex h-full w-full flex-col justify-end rounded-t-md focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="sr-only">
                {day.date}：额度消耗 {bytesLabel(day.weightedBytes)}，实际流量{" "}
                {bytesLabel(day.rawBytes)}
              </span>
              {chart.selection?.index === index && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-dashed border-foreground/40"
                />
              )}
              <span
                aria-hidden="true"
                className={`relative w-full rounded-t-md ${index >= daily.length - 7 ? "bg-primary" : "bg-primary/20"}`}
                style={{
                  height: `${(day.weightedBytes / max) * 100}%`,
                  minHeight: day.weightedBytes > 0 ? 2 : 0,
                }}
              >
                {chart.selection?.index === index && (
                  <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full border-2 border-background bg-primary" />
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{shortDay(daily[0]?.date)}</span>
        <span>{shortDay(daily.at(-1)?.date)}</span>
      </div>
      {active && chart.selection && (
        <ChartTooltip id={chart.id} anchor={chart.selection}>
          <div className="mb-2 font-medium">
            {active.date}
            <span className="ml-2 font-normal text-muted-foreground">
              {timezone}
            </span>
          </div>
          <ValueRow
            label="额度消耗"
            value={active.weightedBytes}
            color="bg-primary"
          />
          <ValueRow
            label="实际流量"
            value={active.rawBytes}
            color="bg-muted-foreground"
          />
        </ChartTooltip>
      )}
    </div>
  );
}
export function RouteUsageChart({
  routes,
  names,
  palette,
  fallbackName,
}: {
  routes: { routeId: string; rawBytes: number; weightedBytes: number }[];
  names: Map<string, string>;
  palette: string[];
  fallbackName: string;
}) {
  const chart = useChartSelection(JSON.stringify(routes.map(route => route.routeId)));
  const total = routes.reduce((sum, route) => sum + route.rawBytes, 0);
  const active = chart.selection && routes[chart.selection.index];
  return (
    <div ref={chart.ref} {...chart.container} className="relative mb-2">
      <div
        role="group"
        aria-label="各线路用量占比"
        className="flex min-h-8 items-center rounded-full"
      >
        {routes.map((route, index) => (
          <button
            key={route.routeId}
            type="button"
            {...chart.button(index)}
            aria-label={`${names.get(route.routeId) || fallbackName}用量占比`}
            className="flex h-8 min-w-0 items-center focus-visible:outline-2 focus-visible:outline-ring"
            style={{
              width: `${total ? (route.rawBytes / total) * 100 : 100 / routes.length}%`,
            }}
          >
            <span
              aria-hidden="true"
              className={`h-3 w-full ${total ? palette[index % palette.length] : "bg-muted"} ${chart.selection?.index === index && route.rawBytes > 0 ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-background" : ""}`}
            />
          </button>
        ))}
      </div>
      {active && chart.selection && (
        <ChartTooltip id={chart.id} anchor={chart.selection}>
          <div className="mb-2 max-w-64 break-words font-medium">
            {names.get(active.routeId) || fallbackName}
          </div>
          <ValueRow
            label="实际流量"
            value={active.rawBytes}
            color={palette[chart.selection.index % palette.length]}
          />
          <ValueRow
            label="额度消耗"
            value={active.weightedBytes}
            color="bg-primary"
          />
          <div className="mt-1 flex justify-between gap-5 text-muted-foreground">
            <span>占总流量</span>
            <span className="font-medium tabular-nums text-popover-foreground">
              {total ? ((active.rawBytes / total) * 100).toFixed(2) : "0.00"}%
            </span>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}

function shortDay(day?: string) {
  return day
    ? day.slice(5).replace(/^0/, "").replace("-0", "/").replace("-", "/")
    : "";
}

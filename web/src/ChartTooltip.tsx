import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A chart-local, non-interactive readout. Callers own selection and dismissal. */
export function ChartTooltip({
  id,
  anchor,
  children,
}: {
  id: string;
  anchor: { x: number; y: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const tip = ref.current;
    const parent = tip?.parentElement;
    if (!tip || !parent) return;
    const place = () => {
      const box = parent.getBoundingClientRect(),
        size = tip.getBoundingClientRect();
      const preferredLeft =
        anchor.x + 12 + size.width <= box.width - 8
          ? anchor.x + 12
          : anchor.x - size.width - 12;
      const preferredTop =
        anchor.y + 12 + size.height <= box.height - 8
          ? anchor.y + 12
          : anchor.y - size.height - 12;
      setPosition({
        left: Math.max(8, Math.min(preferredLeft, box.width - size.width - 8)),
        top: Math.max(8, Math.min(preferredTop, box.height - size.height - 8)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    observer.observe(tip);
    return () => observer.disconnect();
  }, [anchor.x, anchor.y, children]);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="pointer-events-none absolute z-20 w-max max-w-[calc(100%-1rem)] rounded-xl border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md"
      style={position}
    >
      {children}
    </div>
  );
}

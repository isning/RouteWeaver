import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalHost } from "./ui-patterns/portal-host";

/** A viewport readout anchored to its chart. Callers own selection and dismissal. */
export function ChartTooltip({
  id,
  anchor,
  children,
}: {
  id: string;
  anchor: { x: number; y: number };
  children: ReactNode;
}) {
  // Keep the coordinate origin in the chart even though the readout is portaled.
  const portalHost = usePortalHost();
  const measuredAnchor = useRef<{ x: number; y: number; width: number } | null>(
    null,
  );
  const origin = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const tip = ref.current;
    const parent = origin.current?.parentElement;
    if (!tip || !parent) return;
    if (
      !measuredAnchor.current ||
      measuredAnchor.current.x !== anchor.x ||
      measuredAnchor.current.y !== anchor.y
    ) {
      measuredAnchor.current = {
        ...anchor,
        width: parent.getBoundingClientRect().width,
      };
    }
    const initialWidth = measuredAnchor.current.width;
    const place = () => {
      const box = parent.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      // Constrain only to the screen, never to the chart's height or overflow.
      tip.style.maxWidth = `${Math.max(0, width - 16)}px`;
      const size = tip.getBoundingClientRect();
      const x =
        box.left +
        (initialWidth ? (anchor.x * box.width) / initialWidth : anchor.x);
      const y = box.top + anchor.y;
      const preferredLeft =
        x + 12 + size.width <= left + width - 8 ? x + 12 : x - size.width - 12;
      const preferredTop =
        y + 12 + size.height <= top + height - 8
          ? y + 12
          : y - size.height - 12;
      setPosition({
        left: Math.max(
          left + 8,
          Math.min(preferredLeft, left + width - size.width - 8),
        ),
        top: Math.max(
          top + 8,
          Math.min(preferredTop, top + height - size.height - 8),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    observer.observe(tip);
    window.addEventListener("resize", place);
    // Capture also sees scroll events from nested cards, sheets and panels.
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor.x, anchor.y, children, portalHost]);
  return (
    <>
      <span ref={origin} hidden aria-hidden="true" />
      {typeof document !== "undefined" &&
        createPortal(
          <div
            ref={ref}
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-50 w-max max-w-[calc(100vw-1rem)] break-words rounded-xl border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md"
            style={position}
          >
            {children}
          </div>,
          portalHost ?? document.body,
        )}
    </>
  );
}

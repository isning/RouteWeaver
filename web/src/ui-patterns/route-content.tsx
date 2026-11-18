import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { contentWidth, routeContentKind } from "./content-width";

/** A stable host: alias navigation must not replace the task owner. */
export function RouteContent({ page, children }: { page: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  // Workspace aliases share an editor; animating must never remount its draft.
  const motionKey = ["subscriptions", "profiles", "outputs"].includes(page)
    ? "subscriptions"
    : page;
  useLayoutEffect(() => {
    const element = host.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!element?.animate || preference.matches) return;
    const animation = element.animate(
      [{ translate: "0 4px" }, { translate: "0 0" }],
      { duration: 140, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    const stop = () => { if (preference.matches) animation.cancel(); };
    preference.addEventListener("change", stop);
    return () => {
      animation.cancel();
      preference.removeEventListener("change", stop);
    };
  }, [motionKey]);
  const kind = routeContentKind(page);
  return <div ref={host} className={cn("route-content min-w-0 space-y-6", kind !== "frame" && ["mx-auto w-full", contentWidth[kind]])} data-content-kind={kind}>{children}</div>;
}

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { contentWidth, routeContentKind } from "./content-width";

/** A stable host: alias navigation must not replace the task owner. */
export function RouteContent({ page, children }: { page: string; children: ReactNode }) {
  const kind = routeContentKind(page);
  return <div className={cn("route-content min-w-0 space-y-6", kind !== "frame" && ["mx-auto w-full", contentWidth[kind]])} data-content-kind={kind}>{children}</div>;
}

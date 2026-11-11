import type { ComponentProps } from "react";
import { TabsList } from "@/components/ui/tabs";
import { adaptiveTabsHeight } from "./adaptive-tabs-height";
import { cn } from "@/lib/utils";

// Keep the registry's compact tab sizing. Only the surrounding rail scrolls
// when labels cannot fit, including when keyboard navigation moves focus.
export function ScrollableTabsList({
  className,
  onFocus,
  ...props
}: ComponentProps<typeof TabsList>) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto p-1">
      <TabsList
        {...props}
        className={cn("w-max max-w-none", adaptiveTabsHeight, className)}
        onFocus={(event) => {
          onFocus?.(event);
          if (!event.defaultPrevented && event.target instanceof HTMLElement && event.target.getAttribute("role") === "tab") {
            event.target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          }
        }}
      />
    </div>
  );
}

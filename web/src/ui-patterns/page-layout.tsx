import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { contentWidth, type ContentKind } from "./content-width";
import { cn } from "@/lib/utils";

// The primary task has its own centered width cap; context keeps its edge.
// Container breakpoints respond to actual available space, not viewport size.
const contextColumns = {
  navigation: "@min-[56rem]/context:grid-cols-[minmax(0,1fr)_14rem]",
  data: "@min-[62rem]/context:grid-cols-[minmax(0,1fr)_20rem]",
};

/** Task titles/actions share the primary edge, while the rail has its own context. */
export function ContextHeader({
  navigation = false,
  contentKind = "workspace",
  children,
  className,
  ...props
}: ComponentProps<"div"> & { navigation?: boolean; contentKind?: ContentKind }) {
  return (
    <div className={cn("@container/context min-w-0", className)} {...props}>
      <div
        className={cn(
          "grid min-w-0 gap-6",
          contextColumns[navigation ? "navigation" : "data"],
        )}
      >
        <div className={cn("context-heading mx-auto w-full min-w-0", contentWidth[contentKind])}>{children}</div>
      </div>
    </div>
  );
}

export function ContextLayout({
  children,
  rail,
  navigation = false,
  contentKind = "workspace",
}: {
  children: ReactNode;
  rail: ReactNode;
  navigation?: boolean;
  contentKind?: ContentKind;
}) {
  const aside = (
    <aside
      className={cn(
        "page-context @container/rail min-w-0",
        navigation
          ? "self-start @min-[56rem]/context:col-start-2 @min-[56rem]/context:row-start-1 @min-[56rem]/context:[@media(min-height:40rem)]:sticky @min-[56rem]/context:top-24"
          : "@min-[62rem]/context:col-start-2 @min-[62rem]/context:row-start-1",
      )}
    >
      {rail}
    </aside>
  );
  return (
    <div className="@container/context min-w-0">
      <div
        className={cn(
          "context-layout grid min-w-0 items-start gap-6",
          contextColumns[navigation ? "navigation" : "data"],
        )}
      >
        {navigation && aside}
        <div
          className={cn(
            "page-primary mx-auto w-full min-w-0 space-y-6",
            contentWidth[contentKind],
            navigation
              ? "@min-[56rem]/context:col-start-1 @min-[56rem]/context:row-start-1"
              : "@min-[62rem]/context:col-start-1 @min-[62rem]/context:row-start-1",
          )}
        >
          {children}
        </div>
        {!navigation && aside}
      </div>
    </div>
  );
}

export function PageSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      tabIndex={-1}
      className="min-w-0 scroll-mt-32 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
    >
      {children}
    </section>
  );
}

type SectionLink = {
  id: string;
  label: string;
  startId?: string;
  onSelect?: () => void;
};

/** Same-document navigation deliberately leaves the workspace hash/history alone. */
export function SectionIndex({
  label,
  sections,
  disabled = false,
  presentation = "context",
}: {
  label: string;
  presentation?: "context" | "workspace";
  sections: SectionLink[];
  disabled?: boolean;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    const update = () => {
      const visible = sections.flatMap((section) => {
        const target = document.getElementById(section.id);
        if (!target || target.getClientRects().length === 0) return [];
        // A tab's panel proves which section exists; its adjacent tab strip is
        // the section start so scroll landing and the current marker agree.
        const start = section.startId
          ? document.getElementById(section.startId)
          : target;
        return start
          ? [{ id: section.id, top: start.getBoundingClientRect().top }]
          : [];
      });
      const reached = visible.filter((section) => section.top <= 160);
      const pageHeight = document.documentElement.scrollHeight;
      const atEnd =
        pageHeight > window.innerHeight &&
        window.scrollY + window.innerHeight >= pageHeight - 2;
      setCurrent(
        (atEnd ? visible.at(-1) : reached.at(-1) || visible[0])?.id || null,
      );
      frame.current = null;
    };
    const schedule = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [sections]);
  return (
    <nav aria-label={label} className="section-index space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div
        className={cn(
          "flex flex-wrap gap-1",
          presentation === "workspace"
            ? "@min-[56rem]/workspace:flex-col"
            : "@min-[56rem]/context:flex-col",
        )}
      >
        {sections.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="ghost"
            disabled={disabled}
            className={cn(
              "h-auto min-h-11 justify-start whitespace-normal text-left font-normal leading-relaxed text-muted-foreground aria-[current=location]:bg-accent aria-[current=location]:font-medium aria-[current=location]:text-foreground",
              presentation === "workspace"
                ? "@min-[56rem]/workspace:rounded-none @min-[56rem]/workspace:border-l-2 @min-[56rem]/workspace:border-transparent @min-[56rem]/workspace:aria-[current=location]:border-l-foreground @min-[56rem]/workspace:aria-[current=location]:bg-transparent"
                : "@min-[56rem]/context:rounded-none @min-[56rem]/context:border-l-2 @min-[56rem]/context:border-transparent @min-[56rem]/context:aria-[current=location]:border-l-foreground @min-[56rem]/context:aria-[current=location]:bg-transparent",
            )}
            aria-label={`前往${section.label}`}
            aria-current={current === section.id ? "location" : undefined}
            onClick={() => {
              if (section.onSelect) section.onSelect();
              else {
                const target = document.getElementById(section.id);
                if (!target || target.closest("[hidden], [inert]")) return;
                target.focus({ preventScroll: true });
                target.scrollIntoView?.({
                  block: "start",
                  behavior: "instant",
                });
              }
              setCurrent(section.id);
            }}
          >
            {section.label}
          </Button>
        ))}
      </div>
    </nav>
  );
}

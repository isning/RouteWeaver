import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Budget for the content, not a fixed three-column silhouette: a light 11rem
// index opens at 61rem; an 18rem data rail needs 68rem. With a 1.5rem gutter,
// either leaves at least 48.5rem for the primary task. Keep one mounted subtree
// across sizes so drafts, focus and read states survive.
const contextColumns = {
  navigation: "@min-[61rem]/context:grid-cols-[minmax(0,1fr)_11rem]",
  data: "@min-[68rem]/context:grid-cols-[minmax(0,1fr)_18rem]",
};

/** Task titles/actions share the primary edge, while the rail has its own context. */
export function ContextHeader({
  navigation = false,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { navigation?: boolean }) {
  return (
    <div className={cn("@container/context min-w-0", className)} {...props}>
      <div
        className={cn(
          "grid min-w-0 gap-6",
          contextColumns[navigation ? "navigation" : "data"],
        )}
      >
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

export function ContextLayout({
  children,
  rail,
  navigation = false,
}: {
  children: ReactNode;
  rail: ReactNode;
  navigation?: boolean;
}) {
  const aside = (
    <aside
      className={cn(
        "page-context @container/rail min-w-0",
        navigation
          ? "self-start @min-[61rem]/context:col-start-2 @min-[61rem]/context:row-start-1 @min-[61rem]/context:[@media(min-height:40rem)]:sticky @min-[61rem]/context:top-24"
          : "@min-[68rem]/context:col-start-2 @min-[68rem]/context:row-start-1",
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
            "page-primary min-w-0 space-y-6",
            navigation
              ? "@min-[61rem]/context:col-start-1 @min-[61rem]/context:row-start-1"
              : "@min-[68rem]/context:col-start-1 @min-[68rem]/context:row-start-1",
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
}: {
  label: string;
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
      <div className="flex flex-wrap gap-1 @min-[61rem]/context:flex-col">
        {sections.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="ghost"
            disabled={disabled}
            className="h-auto min-h-11 justify-start whitespace-normal text-left font-normal leading-relaxed text-muted-foreground aria-[current=location]:bg-accent aria-[current=location]:font-medium aria-[current=location]:text-foreground @min-[61rem]/context:rounded-none @min-[61rem]/context:border-l-2 @min-[61rem]/context:border-transparent @min-[61rem]/context:aria-[current=location]:border-foreground @min-[61rem]/context:aria-[current=location]:bg-transparent"
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

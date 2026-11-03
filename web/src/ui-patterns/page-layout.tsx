import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Primary work retains at least 40rem before a secondary 14rem rail is added.
// Navigation precedes the task on small screens; supporting context follows it.
// Keep one mounted subtree across sizes so drafts, focus and read states survive.
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
        "page-context min-w-0 @min-[58rem]/context:col-start-2 @min-[58rem]/context:row-start-1 @min-[58rem]/context:border-l @min-[58rem]/context:pl-6",
        navigation &&
          "self-start @min-[58rem]/context:[@media(min-height:40rem)]:sticky @min-[58rem]/context:top-24",
      )}
    >
      {rail}
    </aside>
  );
  return (
    <div className="@container/context min-w-0">
      <div className="context-layout grid min-w-0 items-start gap-6 @min-[58rem]/context:grid-cols-[minmax(0,1fr)_14rem] @min-[58rem]/context:gap-8">
        {navigation && aside}
        <div className="page-primary min-w-0 space-y-6 @min-[58rem]/context:col-start-1 @min-[58rem]/context:row-start-1">
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
      <div className="flex flex-wrap gap-1 @min-[58rem]/context:flex-col">
        {sections.map((section) => (
          <Button
            key={section.id}
            type="button"
            variant="ghost"
            disabled={disabled}
            className="h-auto min-h-11 justify-start whitespace-normal text-left leading-relaxed aria-[current=location]:bg-accent aria-[current=location]:font-semibold"
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

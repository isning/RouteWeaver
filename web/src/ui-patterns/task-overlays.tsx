import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";

type FocusEvent = Event;
type ContentProps = Omit<
  ComponentProps<typeof DialogContent>,
  | "children"
  | "title"
  | "onOpenAutoFocus"
  | "onCloseAutoFocus"
  | "onEscapeKeyDown"
  | "onInteractOutside"
  | "ref"
>;
export interface TaskOverlayProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  pending?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  scrollMode?: "body" | "task" | "auto";
  className?: string;
  initialFocus?: () => HTMLElement | null;
  /** Stable owner for a task whose loading/editing surfaces may be replaced. */
  returnFocus?: HTMLElement | null;
  /** Scope-owned destination when the original opener is no longer available. */
  returnFocusFallback?: () => HTMLElement | null;
  onReady?(): void;
  onClosed?(): void;
  onCloseAutoFocus?(event: FocusEvent): void;
  contentProps?: ContentProps;
  contentRef?: Ref<HTMLDivElement>;
  bodyProps?: ComponentProps<"div">;
}

/** Capture once at the editing-session boundary, not each loading surface. */
export function useTaskReturnFocus(owner?: HTMLElement | null) {
  const [target] = useState(() =>
    owner === undefined ? captureTaskReturnFocus() : owner,
  );
  return target;
}

function captureTaskReturnFocus() {
  const active =
    typeof document !== "undefined" &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // A selected menu item disappears as this task opens. Retain the menu's
  // persistent trigger instead, using its explicit accessible relationship.
  const menu = active?.closest<HTMLElement>('[role="menu"]');
  const trigger = menu
    ?.getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id))
    .find(
      (element) =>
        element?.getAttribute("aria-haspopup") === "menu" &&
        element.getAttribute("aria-controls") === menu.id,
    );
  return trigger ?? active;
}

function eligibleTaskReturnFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  if (!target?.isConnected ||
    target.closest("[hidden],[inert],[aria-hidden='true']") ||
    target.matches(":disabled,[aria-disabled='true']")) return false;
  const style = getComputedStyle(target);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Triggerless task dialogs capture an eligible opener; Radix owns the focus scope. */
export function useTaskOverlayFocus(
  props: Pick<
    TaskOverlayProps,
    | "open"
    | "initialFocus"
    | "returnFocus"
    | "returnFocusFallback"
    | "onReady"
    | "onClosed"
    | "onCloseAutoFocus"
  > & {
    /** Completed action's destination. Null declines restoration, not a fallback. */
    returnFocusDestination?: () => HTMLElement | null;
  },
) {
  const opener = useRef<HTMLElement | null>(null);
  const previouslyOpen = useRef(false);
  const latest = useRef(props);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  latest.current = props;
  if (props.open && !previouslyOpen.current) {
    opener.current =
      props.returnFocus === undefined
        ? captureTaskReturnFocus()
        : props.returnFocus;
  }
  previouslyOpen.current = props.open;
  const onOpenAutoFocus = useCallback((event: FocusEvent) => {
    const initial = latest.current.initialFocus?.();
    if (
      initial?.isConnected &&
      !initial.matches(":disabled,[aria-disabled='true']")
    ) {
      event.preventDefault();
      initial.focus({ preventScroll: true });
    }
    queueMicrotask(() => {
      if (latest.current.open) latest.current.onReady?.();
    });
  }, []);
  const onCloseAutoFocus = useCallback((event: FocusEvent) => {
    latest.current.onCloseAutoFocus?.(event);
    const claimed = event.defaultPrevented;
    // No DialogTrigger is rendered by this task composition. Do not let the
    // primitive attempt to focus an absent trigger; honor an explicit owner.
    event.preventDefault();
    const captured = opener.current;
    const closingScope =
      event.target instanceof HTMLElement ? event.target : null;
    // hideOthers and the closing FocusScope release in this commit. Evaluate
    // eligibility afterwards, without stealing focus from a newer task.
    queueMicrotask(() => {
      if (opener.current !== captured) return;
      // A reconciled inventory can remove the original row. Only an explicit
      // owner may supply an alternative, and never for a reopened task.
      const destination = latest.current.returnFocusDestination;
      const released = !mounted.current || !latest.current.open;
      // An explicit completed-action destination supersedes the old opener,
      // even when it declines or is unavailable. Never revive a deleted row.
      const target = destination
        ? !claimed && released
          ? destination()
          : null
        : eligibleTaskReturnFocus(captured)
          ? captured
          : !claimed && released
            ? latest.current.returnFocusFallback?.()
            : null;
      if (
        !claimed &&
        target?.isConnected &&
        !target.closest("[hidden],[inert],[aria-hidden='true']") &&
        !target.matches(":disabled,[aria-disabled='true']")
      ) {
        const current = document.activeElement;
        const activeDialog =
          current instanceof HTMLElement
            ? current.closest("[role='dialog'],[role='alertdialog']")
            : null;
        const targetDialog = target.closest(
          "[role='dialog'],[role='alertdialog']",
        );
        // Preserve deliberate focus moved since dismissal, including a newer
        // non-modal control. Only release this task's own focus or body fallback.
        const releasedFocus =
          !current ||
          current === document.body ||
          current === target ||
          !current.isConnected ||
          !!closingScope?.contains(current);
        if (
          releasedFocus &&
          (!activeDialog ||
            activeDialog === targetDialog ||
            !activeDialog.isConnected)
        ) {
          const style = getComputedStyle(target);
          if (style.display !== "none" && style.visibility !== "hidden") {
            target.focus({ preventScroll: true });
            // Focus handlers can open another task or deliberately move focus.
            // Recover visibility only while this remains our returned opener.
            if (
              // Conditional task owners unmount with their last open prop true.
              // A still-mounted task that reopened must not recover old focus.
              (!mounted.current || !latest.current.open) &&
              opener.current === captured &&
              target.isConnected &&
              document.activeElement === target
            ) {
              const rect = target.getBoundingClientRect();
              // The standard focus ring extends 3px beyond the control. Leave
              // an extra pixel for fractional layout/browser scroll rounding.
              const clearance = 4;
              if (
                rect.width > 0 &&
                rect.height > 0 &&
                (rect.left < clearance ||
                  rect.top < clearance ||
                  rect.right > window.innerWidth - clearance ||
                  rect.bottom > window.innerHeight - clearance)
              ) {
                // Nearest alignment can retain a fractional edge clip. Center
                // only an unsafe opener, without motion or an independent timer.
                target.scrollIntoView?.({
                  block: "center",
                  inline: "center",
                  behavior: "instant",
                });
              }
            }
          }
        }
      }
      if (!latest.current.open) latest.current.onClosed?.();
    });
  }, []);
  return { onOpenAutoFocus, onCloseAutoFocus };
}

/** Keep fixed completion when usable; tall chrome gets one sequential task flow. */
function useMeasuredTaskScroll(
  requested: NonNullable<TaskOverlayProps["scrollMode"]>,
  hasFooter: boolean,
  dialogInsetRem: number,
) {
  const [header, headerRef] = useState<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<"body" | "task">("body");
  useLayoutEffect(() => {
    if (requested !== "auto" || !header) return;
    const container = header.closest<HTMLElement>("[data-task-overlay]");
    if (!container) return;
    const footer = container.querySelector<HTMLElement>(
      "[data-task-overlay-footer]",
    );
    const measure = () => {
      const style = getComputedStyle(container);
      const rootFont =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const viewport = Math.min(
        window.innerHeight,
        window.visualViewport?.height || window.innerHeight,
      );
      // The dialog's shared max-height leaves 2 rem outside; Sheets use the full
      // viewport. Never derive capacity from the mode-dependent body height.
      const viewportCapacity = Math.max(
        0,
        viewport - rootFont * dialogInsetRem,
      );
      const declaredMax = style.maxHeight.endsWith("px")
        ? parseFloat(style.maxHeight)
        : Infinity;
      const capacity = Math.min(viewportCapacity, declaredMax);
      // offsetHeight excludes the opening zoom transform, so animation cannot
      // change this capacity decision without a real layout change.
      const chrome =
        header.offsetHeight +
        (footer?.offsetHeight || 0) +
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0);
      // Match the source task's usable reading/field reserve, scaling with
      // enlarged text rather than shrinking copy or the consent controls.
      const bodyReserve = Math.max(
        200,
        (parseFloat(style.fontSize) || 16) * 14,
      );
      const next = chrome + bodyReserve > capacity ? "task" : "body";
      setMeasured((previous) => (previous === next ? previous : next));
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(header);
    if (footer) observer?.observe(footer);
    observer?.observe(container);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [requested, header, hasFooter, dialogInsetRem]);
  return { headerRef, mode: requested === "auto" ? measured : requested };
}

const dialogSizes = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-3xl",
  xl: "sm:max-w-5xl",
};
const sheetSizes = {
  sm: "data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
  md: "data-[side=left]:sm:max-w-lg data-[side=right]:sm:max-w-lg",
  lg: "data-[side=left]:sm:max-w-2xl data-[side=right]:sm:max-w-2xl",
  xl: "data-[side=left]:sm:max-w-4xl data-[side=right]:sm:max-w-4xl",
};

export function TaskDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  pending = false,
  size = "md",
  scrollMode = "body",
  className,
  contentProps,
  contentRef,
  bodyProps,
  ...focus
}: TaskOverlayProps) {
  const focusEvents = useTaskOverlayFocus({ open, ...focus });
  const descriptionId = useId();
  const { headerRef, mode } = useMeasuredTaskScroll(
    scrollMode,
    footer != null,
    2,
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) onOpenChange(next);
      }}
    >
      <DialogContent
        {...contentProps}
        ref={contentRef}
        {...focusEvents}
        showCloseButton={false}
        data-task-overlay="dialog"
        data-task-scroll={mode}
        aria-busy={pending || undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-clip p-0 motion-reduce:animate-none",
          mode === "task" && "overflow-y-auto scroll-py-1",
          dialogSizes[size],
          className,
          contentProps?.className,
        )}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader
          ref={scrollMode === "auto" ? headerRef : undefined}
          data-task-overlay-header
          className="min-w-0 shrink-0 border-b px-4 py-4 pr-16 text-left sm:px-6 sm:pr-16"
        >
          <DialogTitle className="min-w-0 text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription
              id={descriptionId}
              className="max-w-prose leading-relaxed [overflow-wrap:anywhere]"
            >
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {!pending && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-3 top-3 min-h-11 min-w-11"
            aria-label="关闭"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </Button>
        )}
        <div
          {...bodyProps}
          data-task-overlay-body
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6",
            mode === "task" && "flex-none overflow-visible",
            bodyProps?.className,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <DialogFooter
            data-task-overlay-footer
            className="mx-0 mb-0 shrink-0 border-t px-4 py-3 sm:px-6 [&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-11"
          >
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TaskSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  pending = false,
  size = "md",
  scrollMode = "body",
  side = "right",
  className,
  contentProps,
  contentRef,
  bodyProps,
  ...focus
}: TaskOverlayProps & { side?: "left" | "right" }) {
  const focusEvents = useTaskOverlayFocus({ open, ...focus });
  const descriptionId = useId();
  const { headerRef, mode } = useMeasuredTaskScroll(
    scrollMode,
    footer != null,
    0,
  );
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next || !pending) onOpenChange(next);
      }}
    >
      <SheetContent
        side={side}
        {...contentProps}
        ref={contentRef}
        {...focusEvents}
        showCloseButton={false}
        data-task-overlay="sheet"
        data-task-scroll={mode}
        aria-busy={pending || undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "flex data-[side=left]:w-full data-[side=right]:w-full flex-col gap-0 overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none",
          mode === "task" && "overflow-y-auto",
          scrollMode === "auto" && "max-h-dvh",
          sheetSizes[size],
          className,
          contentProps?.className,
        )}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <SheetHeader
          ref={scrollMode === "auto" ? headerRef : undefined}
          data-task-overlay-header
          className="min-w-0 shrink-0 border-b px-4 py-4 pr-16 text-left sm:px-6 sm:pr-16"
        >
          <SheetTitle className="min-w-0 text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </SheetTitle>
          {description && (
            <SheetDescription
              id={descriptionId}
              className="max-w-prose leading-relaxed [overflow-wrap:anywhere]"
            >
              {description}
            </SheetDescription>
          )}
        </SheetHeader>
        {!pending && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-3 top-3 min-h-11 min-w-11"
            aria-label="关闭"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </Button>
        )}
        <div
          {...bodyProps}
          data-task-overlay-body
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6",
            mode === "task" && "flex-none overflow-visible",
            bodyProps?.className,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <SheetFooter
            data-task-overlay-footer
            className="shrink-0 border-t px-4 py-3 sm:px-6 [&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-11"
          >
            {footer}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

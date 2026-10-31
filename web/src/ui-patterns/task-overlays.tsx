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
  useRef,
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
  scrollMode?: "body" | "task";
  className?: string;
  initialFocus?: () => HTMLElement | null;
  onReady?(): void;
  onClosed?(): void;
  onCloseAutoFocus?(event: FocusEvent): void;
  contentProps?: ContentProps;
  contentRef?: Ref<HTMLDivElement>;
  bodyProps?: ComponentProps<"div">;
}

/** Triggerless task dialogs capture an eligible opener; Radix owns the focus scope. */
export function useTaskOverlayFocus(
  props: Pick<
    TaskOverlayProps,
    "open" | "initialFocus" | "onReady" | "onClosed" | "onCloseAutoFocus"
  >,
) {
  const opener = useRef<HTMLElement | null>(null);
  const previouslyOpen = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  if (props.open && !previouslyOpen.current) {
    opener.current =
      typeof document !== "undefined" &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
    const target = opener.current;
    const closingScope =
      event.target instanceof HTMLElement ? event.target : null;
    // hideOthers and the closing FocusScope release in this commit. Evaluate
    // eligibility afterwards, without stealing focus from a newer task.
    queueMicrotask(() => {
      if (opener.current !== target) return;
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
          if (style.display !== "none" && style.visibility !== "hidden")
            target.focus({ preventScroll: true });
        }
      }
      if (!latest.current.open) latest.current.onClosed?.();
    });
  }, []);
  return { onOpenAutoFocus, onCloseAutoFocus };
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
        data-task-scroll={scrollMode}
        aria-busy={pending || undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-clip p-0 motion-reduce:animate-none",
          scrollMode === "task" && "overflow-y-auto",
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
          data-task-overlay-header
          className="min-w-0 shrink-0 border-b px-5 py-4 pr-14 text-left sm:px-6 sm:pr-14"
        >
          <DialogTitle className="min-w-0 text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription
              id={descriptionId}
              className="[overflow-wrap:anywhere]"
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
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6",
            scrollMode === "task" && "flex-none overflow-visible",
            bodyProps?.className,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <DialogFooter
            data-task-overlay-footer
            className="mx-0 mb-0 shrink-0 border-t px-5 py-3 sm:px-6 [&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-11"
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
        data-task-scroll={scrollMode}
        aria-busy={pending || undefined}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          "flex data-[side=left]:w-full data-[side=right]:w-full flex-col gap-0 overflow-hidden p-0 motion-reduce:animate-none motion-reduce:transition-none",
          scrollMode === "task" && "overflow-y-auto",
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
          data-task-overlay-header
          className="min-w-0 shrink-0 border-b px-5 py-4 pr-14 text-left sm:px-6 sm:pr-14"
        >
          <SheetTitle className="min-w-0 text-lg leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">
            {title}
          </SheetTitle>
          {description && (
            <SheetDescription
              id={descriptionId}
              className="[overflow-wrap:anywhere]"
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
            "min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6",
            scrollMode === "task" && "flex-none overflow-visible",
            bodyProps?.className,
          )}
        >
          {children}
        </div>
        {footer != null && (
          <SheetFooter
            data-task-overlay-footer
            className="shrink-0 border-t px-5 py-3 sm:px-6 [&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-11"
          >
            {footer}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

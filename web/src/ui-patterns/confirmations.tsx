import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTaskOverlayFocus } from "./task-overlays";

export interface ConfirmationOptions {
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm?(): unknown | Promise<unknown>;
  onCancel?(): void;
  /** Runs after the scope has released and restored focus. */
  onClosed?(): void;
  restoreFocus?: boolean;
  /** Success-only owner destination; null declines restoring the old opener. */
  returnFocusOnSuccess?: () => HTMLElement | null;
  className?: string;
  contentProps?: Omit<
    ComponentProps<typeof AlertDialogContent>,
    | "children"
    | "title"
    | "onCloseAutoFocus"
    | "onOpenAutoFocus"
    | "onEscapeKeyDown"
  >;
}
export interface ConfirmationHandle {
  close(): void;
}
export type Confirm = (options: ConfirmationOptions) => ConfirmationHandle;
const ConfirmationContext = createContext<Confirm | null>(null);

/** An explicit decision task, not a general-purpose imperative modal API. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("useConfirm requires ConfirmationProvider");
  return confirm;
}

interface Decision {
  id: number;
  options: ConfirmationOptions;
  open: boolean;
}
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const close = useCallback((id: number) => {
    setDecisions((items) =>
      items.map((item) => (item.id === id ? { ...item, open: false } : item)),
    );
  }, []);
  const confirm = useCallback<Confirm>(
    (options) => {
      const id = ++nextId.current;
      setDecisions((items) => [...items, { id, options, open: true }]);
      return { close: () => close(id) };
    },
    [close],
  );
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {decisions.map((decision) => (
        <DecisionDialog
          key={decision.id}
          decision={decision}
          close={() => close(decision.id)}
          remove={() =>
            setDecisions((items) =>
              items.filter((item) => item.id !== decision.id),
            )
          }
        />
      ))}
    </ConfirmationContext.Provider>
  );
}

function DecisionDialog({
  decision,
  close,
  remove,
}: {
  decision: Decision;
  close(): void;
  remove(): void;
}) {
  const { options, open } = decision;
  const cancel = useRef<HTMLButtonElement>(null);
  const running = useRef(false);
  const completed = useRef(false);
  const succeeded = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const latest = useRef({ open, close });
  latest.current = { open, close };
  const focusEvents = useTaskOverlayFocus({
    open,
    initialFocus: () => cancel.current,
    returnFocusDestination: succeeded.current
      ? options.returnFocusOnSuccess
      : undefined,
    onCloseAutoFocus: (event) => {
      if (options.restoreFocus === false) event.preventDefault();
    },
    onClosed: () => {
      if (completed.current) return;
      completed.current = true;
      remove();
      options.onClosed?.();
    },
  });
  const reject = () => {
    if (running.current || !open) return;
    options.onCancel?.();
    close();
  };
  const accept = async () => {
    if (running.current || !open) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    try {
      await options.onConfirm?.();
      if (latest.current.open) {
        succeeded.current = true;
        latest.current.close();
      }
    } catch (cause) {
      if (latest.current.open)
        setError(
          cause instanceof Error ? cause.message : "操作未完成，请重试。",
        );
    } finally {
      running.current = false;
      if (latest.current.open) setPending(false);
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reject();
      }}
    >
      <AlertDialogContent
        {...options.contentProps}
        {...focusEvents}
        data-task-overlay="confirmation"
        aria-busy={pending || undefined}
        className={cn(
          "max-h-[calc(100dvh-2rem)] overflow-y-auto motion-reduce:animate-none",
          options.className,
          options.contentProps?.className,
        )}
        onEscapeKeyDown={(event) => {
          if (running.current) event.preventDefault();
        }}
      >
        <AlertDialogHeader className="min-w-0 place-items-start text-left">
          <AlertDialogTitle className="leading-snug [overflow-wrap:anywhere]">{options.title}</AlertDialogTitle>
          <AlertDialogDescription className="min-w-0 text-pretty [overflow-wrap:anywhere]" asChild>
            <div>{options.description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter className="[&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-11 sm:[&_button:not([role=checkbox]):not([role=switch]):not([role=radio])]:min-h-9">
          <AlertDialogCancel
            ref={cancel}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              reject();
            }}
          >
            {options.cancelLabel || "取消"}
          </AlertDialogCancel>
          <Button
            type="button"
            variant={options.destructive ? "destructive" : "default"}
            disabled={pending}
            aria-busy={pending || undefined}
            aria-label={options.confirmLabel}
            onClick={() => void accept()}
          >
            {pending && (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {options.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { useRef, useState } from "react";
import { Ellipsis, LoaderCircle, Pencil, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SourceActionMenuProps {
  sourceName: string;
  loading: boolean;
  disabled?: boolean;
  deleteDisabled: boolean;
  onDelete: () => void;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onEdit?: () => void;
  editDisabled?: boolean;
}

export function SourceActionMenu({
  sourceName,
  loading,
  disabled = false,
  deleteDisabled,
  onDelete,
  onRefresh,
  refreshDisabled = false,
  onEdit,
  editDisabled = false,
}: SourceActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [hideMenuForAction, setHideMenuForAction] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const releaseFocus = useRef(false);
  const select = (action: () => void) => {
    // A new dialog must not overlap an exiting menu's Escape/focus layer.
    // Unmount selected content in the same commit instead of waiting for its
    // exit animation; ordinary menu dismissal keeps the standard lifecycle.
    setHideMenuForAction(true);
    setOpen(false);
    // Dialogs and async review capture the durable row opener, never a menu item.
    releaseFocus.current = true;
    trigger.current?.focus();
    action();
  };
  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next || (!loading && !disabled)) {
          if (next) setHideMenuForAction(false);
          setOpen(next);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={`更多操作 ${sourceName}`}
          // Keep the durable opener focused while deletion references are read;
          // native disabled would blur it before the confirmation captures focus.
          aria-disabled={loading || disabled || undefined}
          aria-busy={loading || undefined}
          onPointerDown={(event) => {
            if (loading || disabled) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (
              (loading || disabled) &&
              ["Enter", " ", "ArrowDown"].includes(event.key)
            )
              event.preventDefault();
          }}
        >
          {loading ? (
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Ellipsis aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      {!hideMenuForAction && (
        <DropdownMenuContent
          align="end"
          className="min-w-44 [&_[role=menuitem]]:min-h-10"
          onKeyDownCapture={(event) => {
            if (event.key !== "Tab") return;
            // Continue the browser's native tab order from this row's opener.
            // Stop only the menu's Tab trap, not the key's default navigation.
            event.stopPropagation();
            releaseFocus.current = true;
            trigger.current?.focus();
            setOpen(false);
          }}
          onCloseAutoFocus={(event) => {
            if (!releaseFocus.current) return;
            releaseFocus.current = false;
            event.preventDefault();
          }}
        >
          {onRefresh && (
            <DropdownMenuItem
              aria-label={`刷新来源 ${sourceName}`}
              disabled={refreshDisabled}
              onSelect={() => select(onRefresh)}
            >
              <RotateCw aria-hidden="true" />
              刷新来源
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem
              aria-label={`编辑来源 ${sourceName}`}
              disabled={editDisabled}
              onSelect={() => select(onEdit)}
            >
              <Pencil aria-hidden="true" />
              编辑来源
            </DropdownMenuItem>
          )}
          {(onRefresh || onEdit) && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            disabled={deleteDisabled}
            onSelect={() => select(onDelete)}
          >
            <Trash2 aria-hidden="true" />
            删除来源
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

import { useRef, useState } from "react";
import { Ellipsis, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SourceActionMenuProps {
  sourceName: string;
  loading: boolean;
  deleteDisabled: boolean;
  onDelete: () => void;
}

export function SourceActionMenu({
  sourceName,
  loading,
  deleteDisabled,
  onDelete,
}: SourceActionMenuProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const releaseFocus = useRef(false);
  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next || !loading) setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={`更多操作 ${sourceName}`}
          // Keep the durable opener focused while deletion references are read;
          // native disabled would blur it before the confirmation captures focus.
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onPointerDown={(event) => {
            if (loading) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (loading && ["Enter", " ", "ArrowDown"].includes(event.key))
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
      <DropdownMenuContent
        align="end"
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
        <DropdownMenuItem
          variant="destructive"
          disabled={deleteDisabled}
          onSelect={() => {
            setOpen(false);
            // The review owns the durable opener rather than an unmounted item.
            releaseFocus.current = true;
            trigger.current?.focus();
            onDelete();
          }}
        >
          <Trash2 aria-hidden="true" />
          删除来源
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

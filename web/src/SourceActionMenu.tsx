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
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={`更多操作 ${sourceName}`}
          disabled={loading}
          aria-busy={loading || undefined}
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
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          disabled={deleteDisabled}
          onSelect={() => {
            setOpen(false);
            // The review owns the durable opener rather than an unmounted item.
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

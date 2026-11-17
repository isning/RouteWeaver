import { ActionButton } from "@/ui-patterns/actions";
import { useImperativeHandle, useRef, type ComponentProps, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/** List controls share a touch target, quiet icon and keyboard-reachable reset.
 * Search/filter choices are primary here; inventory counts are secondary.
 */
export function SearchField({ value, onValueChange, className, ref, disabled, ...props }: Omit<ComponentProps<typeof InputGroupInput>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  "aria-label": string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => input.current!);
  return (
    <InputGroup className={cn("resource-search h-auto min-h-11 bg-background", className)}>
      <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
      <InputGroupInput enterKeyHint="search" {...props} ref={input} value={value} disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        className="h-auto min-h-11 [&::-webkit-search-cancel-button]:appearance-none" />
      {value && <InputGroupAddon align="inline-end" className="py-0 pr-0">
        <InputGroupButton size="icon-sm" className="min-h-11 min-w-11" aria-label="清除搜索输入" disabled={disabled}
          onClick={() => { onValueChange(""); input.current?.focus(); }}>
          <X aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>}
    </InputGroup>
  );
}

/** A search landmark, not an ARIA toolbar: inputs retain native Tab behavior.
 * Keep search at a readable desktop measure, with its count nearby rather
 * than stranded at the far edge (§3.3/§3.6). Narrow layouts use the whole row;
 * search yields some width to filters before either needs another row. Selected
 * chips stay below their filter without moving peers. Filter groups size to
 * their content unless they contain labeled fields, which retain a 32rem
 * basis for usable multi-select widths. Short choices do not reserve that
 * empty track before the count. Touch sizing is preserved.
 */
export function ResourceToolbar({ label, search, filters, summary, className }: {
  label: string;
  search: ReactNode;
  filters?: ReactNode;
  summary?: ReactNode;
  className?: string;
}) {
  return <div role="search" aria-label={label} className={cn("list-toolbar flex min-w-0 flex-wrap items-start gap-3", className)}>
    <div className="w-full min-w-0 sm:max-w-80 sm:flex-[1_1_16rem]">{search}</div>
    {filters && <div className="flex min-w-0 max-w-[min(100%,32rem)] flex-[0_1_auto] has-[[data-slot=toolbar-filter]]:basis-[32rem] flex-wrap items-start gap-3">{filters}</div>}
    {summary && <div className="min-w-0 text-sm leading-relaxed text-muted-foreground sm:self-center">{summary}</div>}
  </div>;
}

export function ToolbarFilter({ label, controlId, children }: { label: string; controlId: string; children: ReactNode }) {
  return <div data-slot="toolbar-filter" className="grid min-w-0 flex-1 basis-40 gap-1.5 text-sm font-medium sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-2">
    <label htmlFor={controlId} className="sm:flex sm:min-h-11 sm:items-center sm:self-start">{label}</label>
    <div className="min-w-0">{children}</div>
  </div>;
}

/** Small, mutually exclusive list filters share state styling and hit targets.
 * Domain choices and counts remain the caller's responsibility. */
export function QuickFilters<V extends string>({ label, value, options, onValueChange }: {
  label: string;
  value: V;
  options: readonly { value: V; label: string; count?: number }[];
  onValueChange: (value: V) => void;
}) {
  return <div role="group" aria-label={label} className="flex max-w-full flex-wrap gap-2">
    {options.map(option => <ActionButton key={option.value}
      variant={value === option.value ? "secondary" : "ghost"}
      aria-pressed={value === option.value} onClick={() => onValueChange(option.value)}>
      {option.label}{option.count !== undefined && <> <span className="text-muted-foreground tabular-nums">{option.count}</span></>}
    </ActionButton>)}
  </div>;
}

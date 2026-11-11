import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  isValidElement,
  type ReactNode,
  type Ref,
} from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

type Value = string | number;
export type Choice<V extends Value = string> = {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  description?: string;
  searchText?: string;
  "aria-label"?: string;
};
export type ChoiceGroup<V extends Value = string> = {
  label: ReactNode;
  options: Choice<V>[];
};
type Options<V extends Value> = (Choice<V> | ChoiceGroup<V>)[];
type Common<V extends Value> = {
  options: Options<V>;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  clearable?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  onBlur?: () => void;
  onOpenChange?: (open: boolean) => void;
};
const flat = <V extends Value>(options: Options<V>) =>
  options.flatMap((o) => ("options" in o ? o.options : [o]));

const optionText = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(optionText).join(" ")
      : isValidElement<{ children?: ReactNode }>(node)
        ? optionText(node.props.children)
        : "";
/** Search the full inventory before bounding DOM work; never slice before search. */
function boundedOptions<V extends Value>(options: Options<V>, query: string) {
  const search = query.trim().toLocaleLowerCase();
  let remaining = 40,
    total = 0;
  const visible: Options<V> = [];
  for (const group of options) {
    const matches = ("options" in group ? group.options : [group]).filter(
      (option) =>
        !search ||
        [
          String(option.value),
          optionText(option.label),
          option.description,
          option.searchText,
          option["aria-label"],
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(search),
    );
    total += matches.length;
    const shown = matches.slice(0, remaining);
    remaining -= shown.length;
    if (shown.length)
      visible.push(
        ...("options" in group ? [{ ...group, options: shown }] : shown),
      );
  }
  return { visible, total };
}

/** Official shadcn combobox composition, shared by resource and endpoint choices. */
export function ChoiceSelect<V extends Value = string>({
  value,
  onValueChange,
  options,
  placeholder = "请选择",
  selectedLabel,
  emptyMessage = "没有匹配的选项",
  disabled,
  searchable = true,
  clearable,
  className,
  ref,
  onOpenChange,
  onBlur,
  ...aria
}: Common<V> & {
  value?: V;
  onValueChange?: (value: V | undefined) => void;
  selectedLabel?: ReactNode;
  emptyMessage?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasSearch = searchable || flat(options).length > 40;
  const reopeningRetainedContent = useRef(false);
  useImperativeHandle(ref, () => triggerRef.current!, []);
  const [query, setQuery] = useState("");
  const { visible, total } = boundedOptions(options, query);
  const selected = flat(options).find((o) => o.value === value);
  const changeOpen = (next: boolean) => {
    reopeningRetainedContent.current = next && !open && !!contentRef.current?.isConnected;
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setQuery("");
      onBlur?.();
    }
  };
  useLayoutEffect(() => {
    const reopening = reopeningRetainedContent.current;
    reopeningRetainedContent.current = false;
    // Radix autofocus runs on mount. A rapid reopen can reuse content retained
    // for its exit animation, so it needs a new opening focus handoff. Transfer
    // only from our trigger, never from a newer field/picker, and keep motion.
    if (open && reopening && document.activeElement === triggerRef.current) {
      (contentRef.current?.querySelector<HTMLInputElement>("[cmdk-input]") ?? listRef.current)?.focus();
    }
  }, [open]);
  // A read-only transition ends this editing interaction, including its search.
  // Closing also keeps an already-open portal from mutating a locked task.
  useEffect(() => {
    if (disabled && open) changeOpen(false);
  }, [disabled, open]);
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          ref={triggerRef}
          className={cn(
            "h-auto min-h-11 w-full justify-between whitespace-normal font-normal",
            className,
          )}
          {...aria}
        >
          <span
            className={cn(
              "min-w-0 whitespace-normal text-left wrap-anywhere",
              !selected && "text-muted-foreground",
            )}
          >
            {selectedLabel ??
              selected?.label ??
              (value !== undefined ? String(value) : placeholder)}
          </span>
          <ChevronsUpDown
            className="ml-2 size-4 shrink-0 opacity-50"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        className="w-(--radix-popover-trigger-width) p-0"
        align="start"
        aria-hidden={!open || undefined}
        inert={!open}
        onOpenAutoFocus={(event) => {
          if (!hasSearch) {
            // The input-free listbox owns cmdk navigation and active-descendant
            // semantics; the surrounding popover cannot handle those keys.
            event.preventDefault();
            listRef.current?.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          // Exit motion can outlive the next tap. Do not let this picker
          // reclaim focus and dismiss a newer picker that has already opened.
          // A parent sheet may receive fallback focus as this content unmounts;
          // that is not a newer interaction and must still restore the trigger.
          const closingContent = event.target;
          const active = document.activeElement;
          const enclosingDialog = triggerRef.current?.closest(
            '[role="dialog"], [role="alertdialog"]',
          );
          // Own the safe return as well: Radix's non-modal outside-interaction
          // flag can survive a same-content reopen until final unmount, making
          // its default return skip the trigger after the next selection.
          event.preventDefault();
          if (
            closingContent instanceof HTMLElement &&
            active &&
            active !== document.body &&
            active !== enclosingDialog &&
            active.isConnected &&
            !closingContent.contains(active)
          ) return;
          if (triggerRef.current?.isConnected && !triggerRef.current.disabled)
            triggerRef.current.focus();
        }}
      >
        <Command label="搜索选项" shouldFilter={false}>
          {hasSearch && (
            <CommandInput
              value={query}
              onValueChange={setQuery}
              aria-label="搜索选项"
              placeholder="搜索选项…"
            />
          )}
          <CommandList
            ref={listRef}
            label={!hasSearch ? aria["aria-label"] ?? "候选项" : "候选项"}
            aria-labelledby={!hasSearch ? aria["aria-labelledby"] : undefined}
            className={!hasSearch ? "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" : undefined}
          >
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {clearable && value !== undefined && !query.trim() && (
              <CommandGroup>
                <CommandItem
                  value="__clear"
                  disabled={disabled}
                  onSelect={() => {
                    if (disabled) return;
                    onValueChange?.(undefined);
                    changeOpen(false);
                  }}
                >
                  清除选择
                </CommandItem>
              </CommandGroup>
            )}
            {visible.map((group, i) => (
              <CommandGroup
                key={i}
                heading={"options" in group ? group.label : undefined}
              >
                {("options" in group ? group.options : [group]).map(
                  (option) => (
                    <CommandItem
                      key={String(option.value)}
                      value={`${option.value} ${option.searchText ?? (typeof option.label === "string" ? option.label : "")}`}
                      aria-label={option["aria-label"]}
                      disabled={disabled || option.disabled}
                      onSelect={() => {
                        if (disabled) return;
                        onValueChange?.(option.value);
                        changeOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          value === option.value ? "opacity-100" : "opacity-0",
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 wrap-anywhere">
                        <span>{option.label}</span>
                        {option.description && (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </CommandItem>
                  ),
                )}
              </CommandGroup>
            ))}
            {total > 40 && (
              <div
                role="status"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                显示前 40 项，共 {total} 项；输入名称或标识继续搜索。
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Multi-value selection uses Command's keyboard navigation and explicit removable badges. */
export function MultiChoice<V extends Value = string>({
  value: providedValue,
  onValueChange,
  options,
  placeholder = "选择多个选项",
  disabled,
  searchable = true,
  clearable,
  creatable = false,
  className,
  ref,
  onOpenChange,
  onBlur,
  ...aria
}: Common<V> & {
  value?: V[] | null;
  onValueChange?: (value: V[]) => void;
  creatable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const value = providedValue ?? [];
  const choices = flat(options);
  const { visible, total } = boundedOptions(options, query);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setQuery("");
      onBlur?.();
    }
  };
  useEffect(() => {
    if (disabled && open) changeOpen(false);
  }, [disabled, open]);
  // Retained/imported drafts can contain repeated references. Each chip owns
  // its occurrence; ordinary distinct values keep their identity on reorder.
  const selectedOccurrences = new Map<V, number>();
  const toggle = (v: V) => {
    if (disabled) return;
    onValueChange?.(
      value.includes(v) ? value.filter((x) => x !== v) : [...value, v],
    );
  };
  return (
    <div className={cn("grid gap-2", className)}>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            ref={ref}
            className="h-auto min-h-11 w-full justify-between whitespace-normal font-normal"
            {...aria}
          >
            <span className="min-w-0 whitespace-normal text-left wrap-anywhere text-muted-foreground">
              {value.length ? `已选择 ${value.length} 项` : placeholder}
            </span>
            <ChevronsUpDown
              className="size-4 shrink-0 opacity-50"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          align="start"
          aria-hidden={!open || undefined}
          inert={!open}
        >
          <Command label="搜索选项" shouldFilter={false}>
            {(searchable || creatable || choices.length > 40) && (
              <CommandInput
                aria-label="搜索选项"
                value={query}
                onValueChange={setQuery}
                placeholder={creatable ? "搜索或输入新值…" : "搜索选项…"}
              />
            )}
            <CommandList aria-label="候选项">
              <CommandEmpty>没有匹配的选项</CommandEmpty>
              {visible.map((group, i) => (
                <CommandGroup
                  key={i}
                  heading={"options" in group ? group.label : undefined}
                >
                  {("options" in group ? group.options : [group]).map(
                    (option) => (
                      <CommandItem
                        key={String(option.value)}
                        value={`${option.value} ${option.searchText ?? (typeof option.label === "string" ? option.label : "")}`}
                        aria-label={option["aria-label"]}
                        disabled={disabled || option.disabled}
                        onSelect={() => toggle(option.value)}
                      >
                        <Check
                          className={cn(
                            "size-4",
                            value.includes(option.value)
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 wrap-anywhere">
                          <span>{option.label}</span>
                          {option.description && (
                            <span className="block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    ),
                  )}
                </CommandGroup>
              ))}
              {creatable &&
                query.trim() &&
                !choices.some((o) => String(o.value) === query.trim()) &&
                !value.includes(query.trim() as V) && (
                  <CommandGroup>
                    <CommandItem
                      value={query}
                      disabled={disabled}
                      onSelect={() => {
                        if (disabled) return;
                        onValueChange?.([...value, query.trim() as V]);
                        setQuery("");
                      }}
                    >
                      添加“{query.trim()}”
                    </CommandItem>
                  </CommandGroup>
                )}
              {total > 40 && (
                <div
                  role="status"
                  className="px-3 py-2 text-xs text-muted-foreground"
                >
                  显示前 40 项，共 {total} 项；输入名称或标识继续搜索。
                </div>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="已选项目">
          {value.map((v, index) => {
            const occurrence = selectedOccurrences.get(v) ?? 0;
            selectedOccurrences.set(v, occurrence + 1);
            return (
              <Badge
                variant="secondary"
                key={JSON.stringify([v, occurrence])}
                className="h-auto min-h-6 max-w-full gap-1 whitespace-normal"
              >
                <span className="min-w-0 whitespace-normal wrap-anywhere">
                  {choices.find((o) => o.value === v)?.label ?? String(v)}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    className="rounded-sm p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`移除 ${choices.find((o) => o.value === v)?.["aria-label"] || optionText(choices.find((o) => o.value === v)?.label) || String(v)}`}
                    onClick={() =>
                      onValueChange?.(
                        value.filter(
                          (_, selectedIndex) => selectedIndex !== index,
                        ),
                      )
                    }
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </Badge>
            );
          })}
          {clearable && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onValueChange?.([])}
            >
              清除全部
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

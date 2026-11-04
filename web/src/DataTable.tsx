import {
  Columns3,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
} from "lucide-react";
import {
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  Fragment,
  type ReactNode,
  type Ref,
  type CSSProperties,
} from "react";
import {
  useTable,
  tableFeatures,
  rowSortingFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  columnPinningFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  createSortedRowModel,
  createPaginatedRowModel,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  type PaginationState,
  type Updater,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { PageNavigation } from "@/ui-patterns/page-navigation";
import { ItemCount } from "@/ui-patterns/item-count";

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  columnPinningFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
});
export function TableRowActions({
  name,
  children,
  className,
}: {
  name: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // Keep a readable 10rem identity measure even for a single icon action,
      // bounded by the viewport. This minimum applies at every size (§3.3 / §3.6).
      // Wrapping must not depend on measured overflow: changing width in
      // response to overflow can make ResizeObserver alternate both layouts.
      // The repeated target uses inline-size containment so revealing a long
      // name cannot widen the table and keep overflow stuck after a resize.
      // Its block size remains natural, so the full name can wrap without clipping.
      className={cn(
        "table-row-actions ml-auto flex w-max scroll-m-1 min-w-[min(10rem,calc(var(--table-viewport-width,100vw)-2rem))] max-w-[calc(var(--table-viewport-width,100vw)-2rem)] flex-col items-end gap-1.5",
        className,
      )}
      role="group"
      aria-label={`${name} 的操作`}
      onFocusCapture={(event) => {
        const context = event.currentTarget;
        if (
          !context.isConnected ||
          !context.contains(event.target) ||
          !event.target.matches(":focus-visible")
        )
          return;
        if (
          context.closest(".data-table")?.getAttribute("data-overflow") ===
          "true"
        )
          context.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
    >
      <span className="table-row-action-target hidden w-full whitespace-normal text-right text-xs text-muted-foreground [contain:inline-size] [overflow-wrap:anywhere] group-data-[overflow=true]/table:block">
        {name}
      </span>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1">
        {children}
      </div>
    </div>
  );
}
export type Column<T> = {
  key?: string;
  title?: ReactNode;
  accessor?: keyof T | (string | number)[];
  render?: (value: any, record: T, index: number) => ReactNode;
  width?: CSSProperties["width"];
  align?: "left" | "center" | "right";
  className?: string;
  sort?: (a: T, b: T) => number;
  pin?: "left" | "right";
};
export type DataTableHandle = {
  nativeElement: HTMLDivElement | null;
  scrollTo: (options: { top?: number; key?: string; index?: number }) => void;
};
export type DataTableProps<T extends object> = {
  rows?: T[];
  columns?: Column<T>[];
  rowKey?: keyof T | ((record: T) => string);
  empty?: ReactNode;
  summary?: ReactNode;
  /** Only pass total for a confirmed complete collection, before local filters. */
  count?: { total: number; unit?: string; filtered?: boolean };
  minWidth?: number | "max-content";
  maxHeight?: number;
  sticky?: boolean;
  pageSize?: number;
  className?: string;
  compact?: boolean;
  page?: number;
  onPageChange?: (page: number) => void;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  selection?: {
    selectedKeys?: string[];
    onChange?: (keys: string[], rows: T[]) => void;
    pinned?: boolean;
    disabled?: (row: T) => boolean;
  };
  loading?: boolean;
  expandedRow?: (record: T) => ReactNode;
  ref?: Ref<DataTableHandle>;
};
const EMPTY_ROWS: never[] = [];
function updated<T>(change: Updater<T>, previous: T): T {
  return typeof change === "function"
    ? (change as (value: T) => T)(previous)
    : change;
}
export function DataTable<T extends object>({
  rows = EMPTY_ROWS,
  columns = EMPTY_ROWS,
  rowKey,
  empty = "暂无数据",
  summary,
  count,
  minWidth,
  maxHeight,
  sticky,
  pageSize = 10,
  page: controlledPage,
  onPageChange,
  sorting: controlledSorting,
  onSortingChange,
  selection,
  loading,
  className,
  compact,
  expandedRow,
  ref,
}: DataTableProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const lastMeasurement = useRef<{
    viewport: HTMLElement;
    width: number;
    contentWidth: number;
  } | null>(null);
  const summaryId = useId();
  const scrollHintId = useId();
  const [overflows, setOverflows] = useState(false);
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const identity = (row: T, index: number) =>
    String(
      typeof rowKey === "function" ? rowKey(row) : rowKey ? row[rowKey] : index,
    );
  const totalPages =
    pageSize > 0 ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const currentPage = Math.max(1, Math.min(controlledPage ?? page, totalPages));
  const pagination = useMemo<PaginationState>(
    () => ({
      pageIndex: currentPage - 1,
      pageSize: pageSize > 0 ? pageSize : Math.max(rows.length, 1),
    }),
    [currentPage, pageSize, rows.length],
  );
  const activeSorting = controlledSorting ?? sorting;
  const activeSelection = useMemo<RowSelectionState>(
    () =>
      selection?.selectedKeys
        ? Object.fromEntries(
            selection.selectedKeys.map((key) => [key, true as const]),
          )
        : selected,
    [selection?.selectedKeys, selected],
  );
  const valueAt = (row: T, accessor: Column<T>["accessor"]) =>
    Array.isArray(accessor)
      ? accessor.reduce<any>((value, key) => value?.[key], row)
      : accessor
        ? row[accessor]
        : undefined;
  const columnId = (column: Column<T>, index: number) =>
    column.key ??
    (Array.isArray(column.accessor)
      ? column.accessor.join(".")
      : String(column.accessor ?? `column-${index}`));
  const definitions = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      columns.map((column, index) => ({
        id: columnId(column, index),
        accessorFn: (row) => valueAt(row, column.accessor),
        header: () => column.title,
        cell: ({ row, getValue }) =>
          column.render
            ? column.render(getValue(), row.original, row.index)
            : (getValue() as ReactNode),
        enableSorting: !!column.sort,
        sortDescFirst: false,
        sortFn: column.sort
          ? (a, b) => column.sort!(a.original, b.original)
          : undefined,
        size: typeof column.width === "number" ? column.width : 180,
      })),
    [columns],
  );
  const changePage = (next: number) => {
    setPage(next);
    onPageChange?.(next);
  };
  const columnPinning = useMemo(
    () => ({
      start: columns.flatMap((column, index) =>
        column.pin === "left" ? [columnId(column, index)] : [],
      ),
      end: columns.flatMap((column, index) =>
        column.pin === "right" ? [columnId(column, index)] : [],
      ),
    }),
    [columns],
  );
  const table = useTable({
    features,
    data: rows,
    columns: definitions,
    getRowId: identity,
    state: {
      sorting: activeSorting,
      rowSelection: activeSelection,
      pagination,
      columnPinning,
    },
    autoResetPageIndex: false,
    enableRowSelection: (row) =>
      !!selection && !selection.disabled?.(row.original),
    onSortingChange: (updater) => {
      const next = updated(updater, activeSorting);
      setSorting(next);
      onSortingChange?.(next);
      changePage(1);
    },
    onPaginationChange: (updater) =>
      changePage(updated(updater, pagination).pageIndex + 1),
    onRowSelectionChange: (updater) => {
      const next = updated(updater, activeSelection);
      setSelected(next);
      const keys = Object.keys(next).filter((key) => next[key]);
      selection?.onChange?.(
        keys,
        rows.filter((row, index) => next[identity(row, index)]),
      );
    },
  });
  useImperativeHandle(ref, () => ({
    nativeElement: container.current,
    scrollTo(options) {
      const viewport = container.current?.querySelector<HTMLElement>(
        '[data-slot="table-container"]',
      );
      if (options.top !== undefined) viewport?.scrollTo?.({ top: options.top });
      const key =
        options.key ??
        (options.index !== undefined && rows[options.index]
          ? identity(rows[options.index], options.index)
          : undefined);
      if (key !== undefined)
        Array.from(
          container.current?.querySelectorAll<HTMLElement>("[data-row-key]") ??
            [],
        )
          .find((row) => row.dataset.rowKey === key)
          ?.scrollIntoView?.({ block: "nearest" });
    },
  }));
  useLayoutEffect(() => {
    const root = container.current;
    const viewport = root?.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    if (!root || !viewport) return;
    // The official Table always owns horizontal scrolling; content can overflow
    // even without a caller-provided minimum width.
    const measure = () => {
      const width = viewport.clientWidth;
      root.style.setProperty("--table-viewport-width", `${width}px`);
      const contentWidth = viewport.scrollWidth;
      const previous = lastMeasurement.current;
      const resized =
        previous?.viewport === viewport &&
        (previous.width !== width || previous.contentWidth !== contentWidth);
      lastMeasurement.current = { viewport, width, contentWidth };
      const overflows = width > 0 && contentWidth > width + 1;
      setOverflows(overflows);
      // The native scroll viewport, rather than a second wrapper, must be
      // reachable by keyboard. Leave ordinary and empty tables out of the tab
      // order. Attribute changes preserve the viewport and any current focus.
      if (overflows && rows.length) {
        viewport.tabIndex = 0;
        viewport.setAttribute("role", "region");
        viewport.setAttribute("aria-label", "表格滚动区域");
        viewport.setAttribute("aria-describedby", scrollHintId);
        // A focused action emits no new focus event after a resize. Reveal it
        // only for a genuine horizontal size change that leaves its bounded
        // context outside this viewport. Rerenders and user scrolling must not
        // pull an intentionally scrolled-away row back into view.
        const focused = root.ownerDocument.activeElement;
        const actions = focused?.closest<HTMLElement>(".table-row-actions");
        if (
          resized &&
          focused?.matches(":focus-visible") &&
          root.contains(focused) &&
          actions?.closest(".data-table") === root
        ) {
          const bounds = actions.getBoundingClientRect();
          const left =
            viewport.getBoundingClientRect().left + viewport.clientLeft;
          // Match scroll-m-1: the official ring-3 must fit outside the
          // button's border box, including when it is otherwise just visible.
          const focusMargin = 4;
          if (
            bounds.left - focusMargin < left ||
            bounds.right + focusMargin > left + width
          )
            actions.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      } else {
        viewport.removeAttribute("tabindex");
        viewport.removeAttribute("role");
        viewport.removeAttribute("aria-label");
        viewport.removeAttribute("aria-describedby");
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    const element = viewport.querySelector("table");
    if (element) observer.observe(element);
    return () => observer.disconnect();
  });
  const columnStyles = (id: string): CSSProperties => {
    const index = columns.findIndex(
        (column, index) => columnId(column, index) === id,
      ),
      definition = columns[index],
      column = table.getColumn(id);
    if (!definition || !column) return {};
    return {
      width: definition.width,
      ...(definition.pin
        ? {
            position: "sticky",
            zIndex: 1,
            width: column.getSize(),
            [definition.pin]:
              definition.pin === "left"
                ? column.getStart("start") + (selection?.pinned ? 40 : 0)
                : column.getAfter("end"),
          }
        : {}),
    };
  };
  const columnClass = (id: string, header = false) => {
    const index = columns.findIndex(
        (column, index) => columnId(column, index) === id,
      ),
      column = columns[index];
    return cn(
      column?.align === "right" && "text-right",
      column?.align === "center" && "text-center",
      column?.pin &&
        (header
          ? "bg-muted"
          : "bg-background group-hover/row:bg-muted group-focus-within/row:bg-muted group-data-[state=selected]/row:bg-muted"),
      column?.className,
    );
  };
  // Column.render is a render callback, not a component type. Calling it here
  // keeps keyed cell descendants stable when callers rebuild inline columns.
  const renderCell = (id: string, value: unknown, row: T, index: number) => {
    const column = columns.find((column, i) => columnId(column, i) === id);
    return column?.render
      ? column.render(value, row, index)
      : (value as ReactNode);
  };
  const span = columns.length + (expandedRow ? 1 : 0) + (selection ? 1 : 0);
  const tableSummary =
    summary === undefined ? (
      loading ? null : (
        <ItemCount
          total={count?.total ?? rows.length}
          matched={count?.filtered ? rows.length : undefined}
          unit={count?.unit}
          scope={count ? "total" : "loaded"}
        />
      )
    ) : (
      summary
    );
  const hasSummary = tableSummary != null && tableSummary !== false;
  return (
    <div
      className={cn("data-table group/table min-w-0 space-y-3", className)}
      data-overflow={overflows}
      ref={container}
      aria-busy={loading || undefined}
    >
      {!!rows.length && overflows && (
        <p
          id={scrollHintId}
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Columns3 className="size-3.5" aria-hidden="true" />
          <span>向左右滚动查看完整表格</span>
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载…
        </p>
      )}
      <div
        className="overflow-hidden rounded-lg border bg-background [&>[data-slot=table-container]]:max-h-[var(--table-max-height)] [&>[data-slot=table-container]]:focus-visible:outline-2 [&>[data-slot=table-container]]:focus-visible:-outline-offset-2 [&>[data-slot=table-container]]:focus-visible:outline-ring"
        style={
          maxHeight
            ? ({ "--table-max-height": `${maxHeight}px` } as CSSProperties)
            : undefined
        }
      >
        {hasSummary && (
          <div
            id={summaryId}
            className="border-b px-4 py-2.5 text-sm text-muted-foreground"
          >
            {tableSummary}
          </div>
        )}
        <Table
          style={minWidth ? { minWidth } : undefined}
          aria-describedby={hasSummary ? summaryId : undefined}
          className={cn(
            // Headers are quiet labels; data and actions carry the hierarchy.
            // Padding sets a steady rhythm without fixing row height (§2.6 / §3.1.2).
            "[&_th]:px-4 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:px-4",
            compact ? "text-xs" : "[&_td]:py-2.5",
          )}
        >
          <TableHeader
            className={
              sticky || maxHeight ? "sticky top-0 z-20 bg-muted" : "bg-muted"
            }
          >
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {selection && (
                  <TableHead
                    className={cn(
                      "w-10",
                      selection.pinned && "sticky left-0 z-10 bg-muted",
                    )}
                  >
                    <Checkbox
                      aria-label="选择本页全部行"
                      checked={
                        table.getIsAllPageRowsSelected()
                          ? true
                          : table.getIsSomePageRowsSelected()
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(value) =>
                        table.toggleAllPageRowsSelected(value === true)
                      }
                      disabled={
                        !table
                          .getRowModel()
                          .rows.some((row) => row.getCanSelect())
                      }
                    />
                  </TableHead>
                )}
                {expandedRow && (
                  <TableHead className="w-10">
                    <span className="sr-only">详情</span>
                  </TableHead>
                )}
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    style={columnStyles(header.id)}
                    className={columnClass(header.id, true)}
                    aria-sort={
                      header.column.getCanSort()
                        ? header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                  >
                    {header.column.getCanSort() ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-mx-2 h-8 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {
                          columns.find(
                            (column, index) =>
                              columnId(column, index) === header.column.id,
                          )?.title
                        }
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp
                            className="size-3.5 text-foreground"
                            aria-hidden="true"
                          />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown
                            className="size-3.5 text-foreground"
                            aria-hidden="true"
                          />
                        ) : (
                          <ArrowUpDown
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        )}
                      </Button>
                    ) : (
                      columns.find(
                        (column, index) =>
                          columnId(column, index) === header.column.id,
                      )?.title
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className="group/row hover:bg-muted focus-within:bg-muted"
                    data-row-key={row.id}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                  >
                    {selection && (
                      <TableCell
                        className={
                          selection.pinned
                            ? "sticky left-0 z-10 bg-background group-hover/row:bg-muted group-focus-within/row:bg-muted group-data-[state=selected]/row:bg-muted"
                            : undefined
                        }
                      >
                        <Checkbox
                          aria-label={`选择行 ${row.id}`}
                          checked={row.getIsSelected()}
                          disabled={!row.getCanSelect()}
                          onCheckedChange={(value) =>
                            row.toggleSelected(value === true)
                          }
                        />
                      </TableCell>
                    )}
                    {expandedRow && (
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            expanded.has(row.id) ? "收起详情" : "展开详情"
                          }
                          aria-expanded={expanded.has(row.id)}
                          onClick={() =>
                            setExpanded((previous) => {
                              const next = new Set(previous);
                              next.has(row.id)
                                ? next.delete(row.id)
                                : next.add(row.id);
                              return next;
                            })
                          }
                        >
                          {expanded.has(row.id) ? (
                            <ChevronDown />
                          ) : (
                            <ChevronRight />
                          )}
                        </Button>
                      </TableCell>
                    )}
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        style={columnStyles(cell.column.id)}
                        className={cn(
                          "align-middle",
                          columnClass(cell.column.id),
                        )}
                      >
                        {renderCell(
                          cell.column.id,
                          cell.getValue(),
                          row.original,
                          row.index,
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {expandedRow && expanded.has(row.id) && (
                    <TableRow>
                      <TableCell colSpan={span}>
                        {expandedRow(row.original)}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={span || 1}
                  className="h-24 text-center text-muted-foreground"
                >
                  {loading ? null : empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <PageNavigation
          page={currentPage}
          pageSize={pageSize}
          total={rows.length}
          showTotal={false}
          onPageChange={changePage}
        />
      )}
    </div>
  );
}

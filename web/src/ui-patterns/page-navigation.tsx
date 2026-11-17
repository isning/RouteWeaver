import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Metadata } from "@/ui-patterns/metadata";
export function PageNavigation({
  page,
  pageSize,
  total,
  showTotal = true,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  showTotal?: boolean;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label="分页"
      className="flex flex-wrap items-center justify-end gap-3 text-sm"
    >
      <Metadata className="text-muted-foreground">
        {showTotal && <span>共 {total} 项</span>}
        <span>
          第 {page} / {pages} 页
        </span>
      </Metadata>
      <div className="flex items-center gap-2">
        {pages > 2 && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="第一页"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="下一页"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
        {pages > 2 && (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="最后一页"
            disabled={page >= pages}
            onClick={() => onPageChange(pages)}
          >
            <ChevronsRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </nav>
  );
}

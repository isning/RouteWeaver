import { ChevronLeft, ChevronRight } from "lucide-react";
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
    </nav>
  );
}

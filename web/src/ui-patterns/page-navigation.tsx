import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
export function PageNavigation({page,pageSize,total,onPageChange}:{page:number;pageSize:number;total:number;onPageChange:(page:number)=>void}) {
 const pages=Math.max(1,Math.ceil(total/pageSize));
 return <nav aria-label="分页" className="flex flex-wrap items-center justify-end gap-3 text-sm">
  <span className="text-muted-foreground">共 {total} 项 · 第 {page} / {pages} 页</span>
  <Button type="button" variant="outline" size="icon-sm" aria-label="上一页" disabled={page<=1} onClick={()=>onPageChange(page-1)}><ChevronLeft /></Button>
  <Button type="button" variant="outline" size="icon-sm" aria-label="下一页" disabled={page>=pages} onClick={()=>onPageChange(page+1)}><ChevronRight /></Button>
 </nav>;
}

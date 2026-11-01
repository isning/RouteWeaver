// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BackupCapacity } from "./BackupCapacity";
const metric = (count: number, limit: number) => ({ count, limit, atLeast: false, warning: count >= limit * .8, exceeded: count > limit });
const value = {
 checkedAt: "2026-11-01T12:00:00Z", notificationRebuildChunkRows: 1024, backupRecordPlaintextBytes: metric(100,1000), backupLargestRecordBytes: metric(100,1000), backupRows: metric(80, 100), notificationLedgerRows: metric(5, 100),
 notificationLedgerCiphertextBytes: metric(100, 1000), notificationLargestLedgerCiphertextBytes: metric(100,1000), archiveByteLimit: 1024 ** 3, archiveBytes: null,
 databaseFileBytes: 4096, filesystemAvailableBytes: null, warningPercent: 80,
};
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), {status,headers:{"Content-Type":"application/json"}});
function mount() {return render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}><BackupCapacity /></QueryClientProvider>)}
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it("checks on request, warns before cap and distinguishes unknown disk from zero",async()=>{
 const fetch=vi.fn().mockResolvedValue(json(value));vi.stubGlobal("fetch",fetch);mount();expect(fetch).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"检查历史容量"}));
 expect(await screen.findByText("历史容量已达到 80% 提醒线")).toBeTruthy();expect(screen.getByText("未知")).toBeTruthy();
 expect(screen.getByText(/通知用量按每步最多 1,024 条重建/)).toBeTruthy();
 expect(screen.getByText(/备份不会删除或缩减当前数据库/)).toBeTruthy();expect(screen.getByText(/尚未生成；上限/)).toBeTruthy();
 expect(fetch.mock.calls[0][0]).toBe("/api/admin/backups/capacity");
});
it("failed refresh does not display stale headroom and can retry",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(json(value)).mockResolvedValueOnce(json({error:"capacity unknown"},503)).mockResolvedValueOnce(json(value));vi.stubGlobal("fetch",fetch);mount();
 fireEvent.click(screen.getByRole("button",{name:"检查历史容量"}));await screen.findByText("历史容量已达到 80% 提醒线");
 fireEvent.click(screen.getByRole("button",{name:"检查历史容量"}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));await waitFor(()=>expect(screen.queryByText("历史容量已达到 80% 提醒线")).toBeNull());
 fireEvent.click(screen.getByRole("button",{name:"检查历史容量"}));expect(await screen.findByText("历史容量已达到 80% 提醒线")).toBeTruthy();
});

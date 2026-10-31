// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeChanges } from "./NodeChanges";
import type { NodeChanges as Value } from "./types";
afterEach(cleanup);
const available = {version:1,state:"available",beforeCount:2,afterCount:2,addedCount:0,removedCount:0,modifiedCount:1,affectedNodeCount:1,orderChanged:false,omittedRowCount:0,rows:[{kind:"modified",label:"Alpha",settingsChanged:true}]};
it.each([
 { ...available, rows: [{kind:["added"],label:"Alpha"}],addedCount:1,modifiedCount:0,afterCount:3 },
 { ...available, rows: [{kind:{toString:null},label:"Alpha"}] },
 { ...available, rows: undefined },
 { ...available, beforeCount: -1 },
 { ...available, affectedNodeCount: 0 },
 { ...available, afterCount: 3 },
 { ...available, orderChanged: undefined },
 { ...available, rows: [{kind:"modified",label:"Alpha"}] },
 { ...available, rows: [{kind:"mystery",label:"Alpha"}] },
 { ...available, rows: [{kind:"modified",label:42,settingsChanged:true}] },
 { ...available, rows: [{kind:"modified",label:"Alpha",nameChanged:true}] },
 { ...available, version: 2 },
 { ...available, state: "future" },
 {version:1,state:"unavailable"},
])("keeps malformed or unknown node review unavailable rather than empty", value => {
 render(<NodeChanges value={value as Value}/>);
 expect(screen.getByText("无法比较此订阅的节点变化。可查看待发布技术配置。")).toBeTruthy();
 expect(screen.queryByText("节点名称和连接设置未变化。")).toBeNull();
});
it("counts a combined rename/settings row once and distinguishes exported order",()=>{
 render(<NodeChanges value={{...available,orderChanged:true,rows:[{kind:"modified",beforeLabel:"Old",label:"New",nameChanged:true,settingsChanged:true}]} as Value}/>);
 expect(screen.getByText("新增 0 个，移除 0 个，修改 1 个")).toBeTruthy();
 expect(screen.getByText("Old")).toBeTruthy();expect(screen.getByText("New")).toBeTruthy();
 expect(screen.getByText("导出的节点顺序已调整。")).toBeTruthy();
});
it("discloses the exact omitted row count without inventing zero changes",()=>{
 render(<NodeChanges value={{...available,beforeCount:51,afterCount:51,modifiedCount:51,affectedNodeCount:51,omittedRowCount:1,rows:Array.from({length:50},(_,i)=>({kind:"modified",label:`Node ${i}`,settingsChanged:true}))} as Value}/>);
 expect(screen.getAllByRole("listitem")).toHaveLength(50);expect(screen.getByText("另有 1 个节点变化未列出；以上数量包含全部变化。")).toBeTruthy();
});

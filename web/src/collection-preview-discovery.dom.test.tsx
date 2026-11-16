// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollectionPreview } from "./CollectionPreview";
import type { Collection, Preview } from "./types";
afterEach(cleanup);
const collection: Collection = { id: "collection", name: "Example", sources: [], steps: [] };
const hk = { id: "hk", name: "香港入口", region: "HK", connection: { protocol: "socks", host: "hk.example", port: 1080 } } as NonNullable<Preview["endpoints"]>[number];
const jp = { ...hk, id: "jp", name: "日本入口", region: "JP", connection: { ...hk.connection, host: "jp.example" } };
it("keeps the same endpoint search across stages so a filtered-out node can be traced back to input", async () => {
  render(<CollectionPreview collection={collection} sources={[]} value={{ endpoints: [jp], stages: [{ scope: "raw", endpoints: [hk, jp] }] }} />);
  const search = screen.getByRole("searchbox", { name: "搜索预览连接" });
  await userEvent.type(search, "hk.example:1080");
  expect(screen.getByText("没有匹配的连接")).toBeTruthy();
  await userEvent.click(screen.getByRole("tab", { name: "原始输入" }));
  const input = screen.getByRole("tabpanel", { name: "原始输入" });
  expect(within(input).getByText("香港入口")).toBeTruthy();
  expect(within(input).queryByText("日本入口")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "清除搜索输入" }));
  expect(within(input).getByText("日本入口")).toBeTruthy();
  expect(document.activeElement).toBe(search);
});

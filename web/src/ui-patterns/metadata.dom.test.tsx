// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Metadata, MetadataItem } from "./metadata";
import { MultiChoice } from "./choice-select";

afterEach(cleanup);

it("groups facts without decorative separators and keeps readable text order", () => {
  render(
    <p>
      <Metadata aria-label="订阅信息">
        <MetadataItem>mihomo</MetadataItem>
        <MetadataItem>完整配置</MetadataItem>
        {false && <MetadataItem>隐藏</MetadataItem>}
        <MetadataItem>已发布</MetadataItem>
      </Metadata>
    </p>,
  );
  const facts = screen.getByLabelText("订阅信息");
  expect(facts.textContent).toBe("mihomo 完整配置 已发布");
  expect(facts.className).toContain("flex-wrap");
  expect(facts.className).toContain("gap-x-3");
  expect(facts.querySelectorAll("span")).toHaveLength(3);
});

it("preserves user-authored punctuation and wraps long metadata", () => {
  const name = "用户命名 \u00b7 Tokyo";
  render(
    <Metadata>
      <MetadataItem>{name}</MetadataItem>
    </Metadata>,
  );
  expect(screen.getByText(name).textContent).toBe(name);
  expect(screen.getByText(name).className).toContain("wrap-anywhere");
});

it("names removal actions from the visible rich choice identity", () => {
  const change = vi.fn();
  render(
    <MultiChoice
      value={["endpoint-1"]}
      onValueChange={change}
      options={[
        {
          value: "endpoint-1",
          label: (
            <Metadata>
              <MetadataItem>Tokyo</MetadataItem>
              <MetadataItem>来源 Personal</MetadataItem>
            </Metadata>
          ),
        },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "移除 Tokyo 来源 Personal" }),
  );
  expect(change).toHaveBeenCalledWith([]);
});

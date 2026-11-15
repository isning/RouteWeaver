// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChartTooltip } from "./ChartTooltip";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps a readout within a narrow chart and flips at the right edge", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const tip = this.getAttribute("role") === "tooltip";
      return {
        left: 0,
        top: 0,
        width: tip ? 200 : 240,
        height: tip ? 100 : 160,
        right: tip ? 200 : 240,
        bottom: tip ? 100 : 160,
        x: 0,
        y: 0,
        toJSON() {},
      };
    },
  );
  const view = render(
    <div style={{ position: "relative" }}>
      <ChartTooltip id="tip" anchor={{ x: 235, y: 150 }}>
        真实数据
      </ChartTooltip>
    </div>,
  );
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("23px");
  expect(tip.style.top).toBe("38px");
  view.rerender(
    <div style={{ position: "relative" }}>
      <ChartTooltip id="tip" anchor={{ x: -10, y: -10 }}>
        真实数据
      </ChartTooltip>
    </div>,
  );
  expect(tip.style.left).toBe("8px");
  expect(tip.style.top).toBe("8px");
  expect(tip.className).toContain("max-w-[calc(100%-1rem)]");
});

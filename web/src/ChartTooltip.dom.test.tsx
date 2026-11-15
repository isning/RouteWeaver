// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ChartTooltip } from "./ChartTooltip";
let chart = { left: 100, top: 100, width: 240, height: 32 };
let resize: () => void;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  chart = { left: 100, top: 100, width: 240, height: 32 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const box =
        this.getAttribute("role") === "tooltip"
          ? { left: 0, top: 0, width: 200, height: 100 }
          : chart;
      return {
        ...box,
        right: box.left + box.width,
        bottom: box.top + box.height,
        x: box.left,
        y: box.top,
        toJSON() {},
      };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  return render(
    <div data-testid="chart" style={{ overflow: "hidden", height: 32 }}>
      <ChartTooltip id="tip" anchor={{ x: 120, y: 16 }}>
        真实数据
      </ChartTooltip>
    </div>,
  );
}
it("escapes clipped chart containers and can be taller than a 32px plot", () => {
  mount();
  const tip = screen.getByRole("tooltip");
  expect(tip.parentElement).toBe(document.body);
  expect(screen.getByTestId("chart").contains(tip)).toBe(false);
  expect(tip.style.left).toBe("232px");
  expect(tip.style.top).toBe("128px");
  expect(tip.className).toContain("fixed");
  expect(tip.className).toContain("bg-popover");
});
it("flips at screen edges, not at chart edges", () => {
  chart.left = 600;
  chart.top = 500;
  mount();
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("508px");
  expect(tip.style.top).toBe("404px");
});
it("follows nested scrolling and resizes without overflowing the viewport", () => {
  const view = mount();
  const tip = screen.getByRole("tooltip");
  chart.top = 50;
  act(() => screen.getByTestId("chart").dispatchEvent(new Event("scroll")));
  expect(tip.style.top).toBe("78px");
  chart.width = 480;
  act(() => resize());
  expect(tip.style.left).toBe("352px");
  vi.stubGlobal("innerWidth", 320);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(tip.style.left).toBe("112px");
  expect(tip.style.maxWidth).toBe("304px");
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("clamps offscreen anchors to the viewport gutter", () => {
  chart.left = -300;
  chart.top = -300;
  mount();
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("8px");
  expect(tip.style.top).toBe("8px");
});
it("keeps resized anchor alignment when readout data refreshes", () => {
  const view = mount();
  chart.width = 480;
  act(() => resize());
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("352px");
  view.rerender(
    <div data-testid="chart">
      <ChartTooltip id="tip" anchor={{ x: 120, y: 16 }}>
        更新后的真实数据
      </ChartTooltip>
    </div>,
  );
  expect(tip.style.left).toBe("352px");
});
it("respects the visible viewport after zoom or keyboard resize", () => {
  const viewport = new EventTarget();
  Object.assign(viewport, {
    offsetLeft: 20,
    offsetTop: 30,
    width: 320,
    height: 240,
  });
  vi.stubGlobal("visualViewport", viewport);
  mount();
  const tip = screen.getByRole("tooltip");
  expect(tip.style.left).toBe("28px");
  expect(tip.style.top).toBe("128px");
  Object.assign(viewport, { offsetTop: 100 });
  chart.top = -100;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(tip.style.top).toBe("108px");
});
it("uses the workspace portal host so session overlays retain their scope", async () => {
  const { PortalHostProvider } = await import("./ui-patterns/portal-host");
  const host = document.createElement("div");
  document.body.append(host);
  const view = render(
    <PortalHostProvider container={host}>
      <div>
        <ChartTooltip id="scoped" anchor={{ x: 20, y: 10 }}>
          工作空间数据
        </ChartTooltip>
      </div>
    </PortalHostProvider>,
  );
  expect(screen.getByRole("tooltip").parentElement).toBe(host);
  view.unmount();
  expect(host.childElementCount).toBe(0);
  host.remove();
});

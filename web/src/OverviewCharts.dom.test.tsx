// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DailyUsageChart, RouteUsageChart } from "./OverviewCharts";
beforeAll(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  ),
);
afterEach(cleanup);
const daily = [
  { date: "2026-11-14", rawBytes: 0, weightedBytes: 0 },
  { date: "2026-11-15", rawBytes: 1024, weightedBytes: 2048 },
];
it("opens local daily readout on focus with actual values, dismisses on Escape and blur", () => {
  render(<DailyUsageChart daily={daily} timezone="UTC" />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  const day = screen.getByRole("button", { name: "2026-11-15用量" });
  fireEvent.focus(day);
  const tip = screen.getByRole("tooltip");
  expect(tip.textContent).toContain("2026-11-15");
  expect(tip.textContent).toContain("1,024 B");
  expect(tip.textContent).toContain("2,048 B");
  expect(day.getAttribute("aria-describedby")).toBe(tip.id);
  fireEvent.pointerLeave(day.parentElement!.parentElement!.parentElement!);
  expect(screen.getByRole("tooltip")).not.toBeNull();
  fireEvent.keyDown(day, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(day);
  fireEvent.blur(day);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("supports pointer movement, zero data, and touch dismissal outside", () => {
  render(<DailyUsageChart daily={daily} timezone="UTC" />);
  const day = screen.getByRole("button", { name: "2026-11-14用量" });
  fireEvent.pointerMove(day, { clientX: 20, clientY: 40 });
  expect(screen.getByRole("tooltip").textContent).toContain("0 B");
  fireEvent.pointerLeave(day.parentElement!.parentElement!.parentElement!);
  expect(screen.queryByRole("tooltip")).toBeNull();
  const touch = new Event("pointerdown", { bubbles: true });
  Object.defineProperties(touch, {
    pointerType: { value: "touch" },
    clientX: { value: 20 },
    clientY: { value: 40 },
  });
  fireEvent(day, touch);
  fireEvent.click(day);
  fireEvent.pointerLeave(day.parentElement!.parentElement!.parentElement!);
  expect(screen.getByRole("tooltip")).not.toBeNull();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("route readout contains actual raw, weighted bytes and percentage", () => {
  render(
    <RouteUsageChart
      routes={[
        { routeId: "a", rawBytes: 100, weightedBytes: 200 },
        { routeId: "b", rawBytes: 300, weightedBytes: 300 },
      ]}
      names={new Map([["a", "东京"]])}
      palette={["bg-primary"]}
      fallbackName="历史线路"
    />,
  );
  fireEvent.focus(screen.getByRole("button", { name: "东京用量占比" }));
  const tip = screen.getByRole("tooltip");
  expect(tip.textContent).toContain("100 B");
  expect(tip.textContent).toContain("200 B");
  expect(tip.textContent).toContain("25.00%");
  fireEvent.focus(screen.getByRole("button", { name: "历史线路用量占比" }));
  expect(screen.getByRole("tooltip").textContent).toContain("75.00%");
});
it("zero-total routes stay keyboard accessible without invented usage", () => {
  render(
    <RouteUsageChart
      routes={[{ routeId: "a", rawBytes: 0, weightedBytes: 0 }]}
      names={new Map()}
      palette={["bg-primary"]}
      fallbackName="历史线路"
    />,
  );
  fireEvent.focus(screen.getByRole("button"));
  expect(screen.getByRole("tooltip").textContent).toContain("0.00%");
  expect(screen.getByRole("tooltip").textContent).not.toContain("NaN");
});

it("does not draw a minimum colored share for zero usage", () => {
  render(
    <RouteUsageChart
      routes={[
        { routeId: "a", rawBytes: 0, weightedBytes: 0 },
        { routeId: "b", rawBytes: 100, weightedBytes: 100 },
      ]}
      names={
        new Map([
          ["a", "零流量"],
          ["b", "全部"],
        ])
      }
      palette={["bg-primary"]}
      fallbackName="历史线路"
    />,
  );
  expect(
    screen.getByRole("button", { name: "零流量用量占比" }).style.width,
  ).toBe("0%");
  expect(screen.getByRole("button", { name: "全部用量占比" }).style.width).toBe(
    "100%",
  );
});


it("keeps refreshed values for the same route but dismisses a reordered selection", () => {
  const routes = [
    { routeId: "a", rawBytes: 100, weightedBytes: 100 },
    { routeId: "b", rawBytes: 200, weightedBytes: 300 },
  ];
  const props = { names: new Map([["a", "东京"], ["b", "伦敦"]]), palette: ["bg-primary"], fallbackName: "历史线路" };
  const view = render(<RouteUsageChart {...props} routes={routes} />);
  fireEvent.focus(screen.getByRole("button", { name: "伦敦用量占比" }));
  expect(screen.getByRole("tooltip").textContent).toContain("伦敦");
  const updated = [routes[0], { ...routes[1], rawBytes: 250 }];
  view.rerender(<RouteUsageChart {...props} routes={updated} />);
  expect(screen.getByRole("tooltip").textContent).toContain("250 B");
  view.rerender(<RouteUsageChart {...props} routes={[updated[1], updated[0]]} />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "伦敦用量占比" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "伦敦用量占比" }), { detail: 0 });
  expect(screen.getByRole("tooltip").textContent).toContain("伦敦");
  expect(screen.getByRole("tooltip").textContent).toContain("250 B");
});

it("retires a pinned touch readout on a new daily window and allows another tap", () => {
  const view = render(<DailyUsageChart daily={daily} timezone="UTC" />);
  const tap = (name: string) => {
    const button = screen.getByRole("button", { name });
    const event = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(event, {
      pointerType: { value: "touch" }, clientX: { value: 20 }, clientY: { value: 40 },
    });
    fireEvent(button, event);
    fireEvent.click(button);
    fireEvent.pointerLeave(button.parentElement!.parentElement!.parentElement!);
  };
  tap("2026-11-15用量");
  expect(screen.getByRole("tooltip").textContent).toContain("2026-11-15");
  const next = [...daily.slice(1), { date: "2026-11-16", rawBytes: 300, weightedBytes: 300 }];
  view.rerender(<DailyUsageChart daily={next} timezone="UTC" />);
  expect(screen.queryByRole("tooltip")).toBeNull();
  tap("2026-11-16用量");
  expect(screen.getByRole("tooltip").textContent).toContain("2026-11-16");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

// @vitest-environment jsdom
// No layout claims: jsdom cannot calculate intrinsic or lh pixel geometry.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { compile } from "tailwindcss";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { ScrollableTabsList } from "./ui-patterns/scrollable-tabs-list";
import { CollectionPreview } from "./CollectionPreview";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {} unobserve() {} disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["configuration", "collection"] as const)(
  "%s uses text-relative minimums without replacing compact primitive heights",
  async (kind) => {
    render(<>
      <Tabs defaultValue="baseline">
        <TabsList aria-label="Primitive baseline"><TabsTrigger value="baseline">Baseline</TabsTrigger></TabsList>
      </Tabs>
      {kind === "configuration" ? <Tabs defaultValue="one">
        <ScrollableTabsList aria-label="Adaptive list"><TabsTrigger value="one">分流规则</TabsTrigger></ScrollableTabsList>
      </Tabs> : <CollectionPreview
        collection={{id: "one", name: "One", sources: [], steps: []}}
        sources={[]}
        value={{endpoints: [], stages: [{scope: "merged", endpoints: []}]}}
      />}
    </>);
    const rail = screen.getByRole("tablist", {name: kind === "configuration" ? "Adaptive list" : "处理阶段"});
    const baseline = screen.getByRole("tablist", {name: "Primitive baseline"});
    const primitiveTab = within(baseline).getByRole("tab");
    const tabs = within(rail).getAllByRole("tab");
    const style = document.createElement("style");
    style.textContent = (await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")).build(
      [...document.body.querySelectorAll<HTMLElement>("[class]")].flatMap(node => [...node.classList]),
    );
    document.head.append(style);
    try {
      expect(getComputedStyle(rail).minHeight).toBe("min-content");
      expect(style.textContent).toMatch(/min-height:\s*1lh/);
      for (const tab of tabs) {
        expect(getComputedStyle(tab).height).toBe(getComputedStyle(primitiveTab).height);
        // Check both normal and doubled specified font/line heights. The
        // relative minimum must not become a fixed px workaround at either.
        const minimums: number[] = [];
        for (const [font, line] of [[14, 20], [28, 40]]) {
          tab.style.fontSize = `${font}px`;
          tab.style.lineHeight = `${line}px`;
          expect(getComputedStyle(tab).lineHeight).toBe(`${line}px`);
          minimums.push(Number.parseFloat(getComputedStyle(tab).minHeight));
        }
        expect(minimums[0]).toBeGreaterThan(0);
        expect(minimums[1]).toBeCloseTo(minimums[0] * 2, 5);
      }
      expect(getComputedStyle(rail).height).toBe(getComputedStyle(baseline).height);
      if (kind === "collection") expect(rail.closest('[data-slot="scroll-area"]')).toBeTruthy();
    } finally { style.remove(); }
  },
);

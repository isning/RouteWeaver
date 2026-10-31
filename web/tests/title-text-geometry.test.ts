// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { measureTitleText } from "./title-text-geometry";
afterEach(() => vi.restoreAllMocks());
// Explicit measurements test classification only; jsdom does not render glyphs.
function fixture(lines: number) {
  const cell = document.createElement("td");
  cell.textContent = "线路维护通知";
  cell.style.lineHeight = "20px";
  vi.spyOn(cell, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 192, 120),
  );
  vi.spyOn(document, "createRange").mockReturnValue({
    selectNodeContents() {},
    getClientRects: () =>
      Array.from(
        { length: lines },
        (_, i) => new DOMRect(8, 8 + 20 * i, 100, 18),
      ),
  } as unknown as Range);
  return cell;
}
it("measures glyphs rather than action-driven table row height", () => {
  const geometry = measureTitleText(fixture(1));
  expect(geometry).toEqual({
    width: 192,
    lineHeight: 20,
    textHeight: 18,
    lineCount: 1,
  });
});
it("detects six actual text lines even when the cell has sufficient width", () => {
  const geometry = measureTitleText(fixture(6));
  expect(geometry.lineCount).toBe(6);
  expect(geometry.textHeight).toBeGreaterThan(geometry.lineHeight * 2 + 1);
});

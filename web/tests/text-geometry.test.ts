// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditTextGeometry } from "./text-geometry";

// These fixtures supply explicit browser measurements to exercise the auditor's
// classification, not to claim jsdom renders fonts, scrolling or real pixels.
const rect = (top: number, height: number) => new DOMRect(0, top, 200, height);
let glyphs: Map<Node, DOMRect>;
function box<T extends HTMLElement>(element: T, top: number, height: number) {
  Object.defineProperties(element, {
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(top, height),
    },
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: height },
  });
  return element;
}
function container(
  parent: Element,
  top: number,
  height: number,
  overflow: string,
  contentHeight = height,
) {
  const element = box(document.createElement("div"), top, height);
  element.style.overflowY = overflow;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: contentHeight,
  });
  parent.append(element);
  return element;
}
function text(
  parent: Element,
  top: number,
  height: number,
  paintedTop = top + 2,
  paintedHeight = height - 4,
  tag = "button",
) {
  const element = box(document.createElement(tag), top, height);
  element.textContent = "重新检查";
  parent.append(element);
  glyphs.set(element.firstChild!, rect(paintedTop, paintedHeight));
  return element;
}
function root(height = 140) {
  return container(document.body, 0, height, "clip");
}
beforeEach(() => {
  glyphs = new Map();
  vi.spyOn(document, "createRange").mockImplementation(() => {
    let selected: Node;
    return {
      selectNodeContents(node: Node) {
        selected = node;
      },
      getClientRects() {
        return glyphs.has(selected) ? [glyphs.get(selected)!] : [];
      },
    } as unknown as Range;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: () => ({
      actualBoundingBoxAscent: 30,
      actualBoundingBoxDescent: 8,
    }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("text geometry at scroll and clipping boundaries", () => {
  it.each(["auto", "scroll"])(
    "does not compare legitimately off-scroll text to an outer clip (%s)",
    (overflow) => {
      const scope = root();
      const viewport = container(scope, 10, 100, overflow, 500);
      text(viewport, -180, 40);
      expect(auditTextGeometry(scope)).toEqual({
        checkedControlsAndLabels: 1,
        issues: [],
      });
    },
  );

  it("does not treat a nonoverflowing auto wrapper as evidence that clipped content is reachable", () => {
    const scope = root();
    const viewport = container(scope, 10, 100, "auto");
    text(viewport, 150, 40);
    expect(auditTextGeometry(scope).issues).toEqual([
      expect.objectContaining({
        issue: "text vertically clipped by an overflow-hidden ancestor",
      }),
    ]);
  });

  it("still rejects an inner hidden clip before reaching a legitimate scroll viewport", () => {
    const scope = root();
    const viewport = container(scope, 10, 100, "auto", 500);
    const hidden = container(viewport, 20, 20, "hidden");
    text(hidden, 20, 40, 30, 20);
    expect(auditTextGeometry(scope).issues).toEqual([
      expect.objectContaining({
        issue: "text vertically clipped by an overflow-hidden ancestor",
        availableHeight: 20,
      }),
    ]);
  });

  it("still rejects intrinsic label clipping even when the label is off-scroll", () => {
    const scope = root();
    const viewport = container(scope, 10, 100, "auto", 500);
    text(viewport, -180, 20, -185, 35, "label");
    expect(auditTextGeometry(scope).issues).toEqual([
      expect.objectContaining({
        issue: "text extends vertically beyond its control/label",
        availableHeight: 20,
      }),
    ]);
  });

  it.each(["input", "textarea"])(
    "still rejects oversized %s glyphs in an otherwise reachable field",
    (tag) => {
      const scope = root();
      const viewport = container(scope, 10, 100, "auto", 500);
      const field = box(document.createElement(tag), 20, 20) as
        HTMLInputElement | HTMLTextAreaElement;
      field.value = "Readable value";
      viewport.append(field);
      expect(auditTextGeometry(scope).issues).toEqual([
        expect.objectContaining({
          issue: "input glyphs taller than its inner control",
          paintedHeight: 38,
          availableHeight: 20,
        }),
      ]);
    },
  );

  it("preserves the one CSS pixel intrinsic tolerance", () => {
    const scope = root();
    text(scope, 10, 20, 9.25, 21.5);
    expect(auditTextGeometry(scope).issues).toEqual([]);
    const clipped = text(scope, 50, 20, 48.9, 22.2);
    clipped.textContent = "真实裁切";
    glyphs.set(clipped.firstChild!, rect(48.9, 22.2));
    expect(auditTextGeometry(scope).issues).toEqual([
      expect.objectContaining({
        control: "真实裁切",
        issue: "text extends vertically beyond its control/label",
      }),
    ]);
  });

  it("allows nested scroll viewports to bring their content into view", () => {
    const scope = root(100);
    const outer = container(scope, 0, 100, "auto", 1000);
    const inner = container(outer, 200, 100, "auto", 800);
    text(inner, 450, 40);
    expect(auditTextGeometry(scope).issues).toEqual([]);
  });

  it("still rejects a scroll viewport itself cut off by an outer hidden boundary", () => {
    const scope = root(100);
    const viewport = container(scope, 10, 150, "auto", 500);
    text(viewport, 200, 40);
    expect(auditTextGeometry(scope).issues).toEqual([
      expect.objectContaining({
        issue:
          "scroll viewport vertically clipped by an overflow-hidden ancestor",
        paintedHeight: 150,
        availableHeight: 100,
      }),
    ]);
  });
});

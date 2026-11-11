// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { observeValidationGeometry } from "./admin-validation-evidence";

// Browser measurements are supplied explicitly. These tests classify evidence;
// they do not claim that jsdom paints, hit-tests, or clips actual pixels.
const failures = { checkFailure: "检查失败", removalFailure: "删除失败" };
const originalHitTest = Object.getOwnPropertyDescriptor(
  document,
  "elementFromPoint",
);

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHitTest)
    Object.defineProperty(document, "elementFromPoint", originalHitTest);
  else Reflect.deleteProperty(document, "elementFromPoint");
  document.body.replaceChildren();
});

function pending() {
  const row = document.createElement("div");
  const button = document.createElement("button");
  button.setAttribute("aria-label", "校验链路");
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  button.style.cssText = "pointer-events: none !important; color: red;";
  row.append(button);
  document.body.append(row);
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
    new DOMRect(20, 20, 44, 44),
  );
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () =>
      getComputedStyle(button).pointerEvents === "none" ? row : button,
  });
  return button;
}

it("observes a visible disabled pending control without treating pointer suppression as occlusion", () => {
  const button = pending();
  const before = button.getAttribute("style");
  expect(observeValidationGeometry(document.body, failures).controls).toEqual([
    expect.objectContaining({
      inViewport: true,
      unobscured: true,
      busy: "true",
      occlusionProbe: "temporary-pointer-events-auto",
    }),
  ]);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("style")).toBe(before);
});

it("still rejects a covering element instead of assuming disabled means visible", () => {
  const button = pending();
  const overlay = document.createElement("div");
  document.body.append(overlay);
  vi.spyOn(document, "elementFromPoint").mockReturnValue(overlay);
  const before = button.getAttribute("style");
  expect(
    observeValidationGeometry(document.body, failures).controls[0],
  ).toMatchObject({
    inViewport: true,
    unobscured: false,
  });
  expect(button.getAttribute("style")).toBe(before);
});

it("rejects an ancestor hit when the control center is clipped", () => {
  const button = pending();
  vi.spyOn(document, "elementFromPoint").mockReturnValue(button.parentElement);
  expect(
    observeValidationGeometry(document.body, failures).controls[0],
  ).toMatchObject({
    inViewport: true,
    unobscured: false,
  });
});

it("still rejects a partly offscreen control even if its center is unobscured", () => {
  const button = pending();
  vi.mocked(button.getBoundingClientRect).mockReturnValue(
    new DOMRect(-10, 20, 44, 44),
  );
  expect(
    observeValidationGeometry(document.body, failures).controls[0],
  ).toMatchObject({
    inViewport: false,
    unobscured: true,
  });
});

it.each([null, "", "pointer-events: none !important; color: red;"])(
  "restores the exact inline style (%j) and disabled state when the hit test throws",
  (before) => {
    const button = pending();
    if (before === null) button.removeAttribute("style");
    else button.setAttribute("style", before);
    const css = document.createElement("style");
    css.textContent = "button:disabled { pointer-events: none; }";
    document.body.prepend(css);
    vi.spyOn(document, "elementFromPoint").mockImplementation(() => {
      throw new Error("hit test interrupted");
    });
    expect(() => observeValidationGeometry(document.body, failures)).toThrow(
      "hit test interrupted",
    );
    expect(button.getAttribute("style")).toBe(before);
    expect(button.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
  },
);

it.each([null, ""])(
  "restores the exact CSS-only style baseline (%j)",
  (before) => {
    const button = pending();
    if (before === null) button.removeAttribute("style");
    else button.setAttribute("style", before);
    const css = document.createElement("style");
    css.textContent = "button:disabled { pointer-events: none; }";
    document.body.prepend(css);
    expect(
      observeValidationGeometry(document.body, failures).controls[0],
    ).toMatchObject({
      unobscured: true,
      occlusionProbe: "temporary-pointer-events-auto",
    });
    expect(button.getAttribute("style")).toBe(before);
    expect(button.hasAttribute("style")).toBe(before !== null);
    expect(getComputedStyle(button).pointerEvents).toBe("none");
  },
);

it("does not alter a control whose pointer hit testing is already enabled", () => {
  const button = pending();
  button.style.pointerEvents = "auto";
  const before = button.getAttribute("style");
  expect(
    observeValidationGeometry(document.body, failures).controls[0],
  ).toMatchObject({
    unobscured: true,
    occlusionProbe: "unchanged",
  });
  expect(button.getAttribute("style")).toBe(before);
});

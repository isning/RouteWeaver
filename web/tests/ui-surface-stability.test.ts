// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { surfaceMotionState } from "./ui-surface-stability";

afterEach(() => document.body.replaceChildren());

function surface(className: string) {
  const element = document.createElement("button");
  element.className = className;
  element.style.opacity = "1";
  // jsdom has no animation engine. Empty Web Animations is the explicit static
  // condition under test; browser integration still checks real running motion.
  element.getAnimations = () => [];
  document.body.append(element);
  return element;
}

it.each(["inline-flex items-center justify-center", "text-center", "content-center"])(
  "does not treat static layout class %s as enter motion",
  (classes) => {
    expect(surfaceMotionState(surface(classes))).toEqual({
      opacity: "1", preparing: false, running: false,
    });
  },
);

it.each(["enter", "enter-active", "appear-prepare", "rc-dialog-enter-active", "rc-motion-appear", "prepare"])(
  "still blocks the real motion phase %s even before an animation starts",
  (phase) => {
    expect(surfaceMotionState(surface(`items-center ${phase}`))).toEqual({
      opacity: "1", preparing: true, running: false,
    });
  },
);

it("still checks an owning task overlay phase for a child", () => {
  const overlay = surface("rc-dialog-appear-prepare");
  overlay.setAttribute("data-task-overlay", "dialog");
  const child = surface("items-center");
  overlay.append(child);
  expect(surfaceMotionState(child).preparing).toBe(true);
  overlay.className = "items-center";
  expect(surfaceMotionState(child).preparing).toBe(false);
  overlay.style.opacity = "0.5";
  expect(surfaceMotionState(child).opacity).toBe("0.5");
});

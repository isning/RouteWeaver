// Runs inside Chromium via Locator.evaluate. Keep this function self-contained.
export function surfaceMotionState(el: Element) {
  // Radix task content owns dialog/sheet entrance and exit motion.
  const motion = el.closest("[data-task-overlay]") || el;
  const completedLoadingDecoration = (animation: Animation) => {
    if (
      !(animation instanceof CSSAnimation) ||
      animation.animationName !== "spin" ||
      !(animation.effect instanceof KeyframeEffect) ||
      animation.effect.getTiming().iterations !== Infinity
    )
      return false;
    const target = animation.effect.target;
    if (
      !(target instanceof Element) ||
      !target.matches('[data-slot="spinner"]')
    )
      return false;
    const icon = target.closest("[data-loading-decoration]") || target;
    const button = icon?.closest("button");
    if (
      !icon ||
      !button ||
      button.disabled ||
      button.getAttribute("data-loading") === "true" ||
      button.getAttribute("aria-busy") === "true"
    )
      return false;
    const targetRect = target.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    // Exclude only a proven transparent, zero-area completed decoration.
    // Busy controls and all visible or unrelated animations remain blocking.
    return (
      targetRect.width === 0 &&
      targetRect.height === 0 &&
      iconRect.width === 0 &&
      iconRect.height === 0 &&
      getComputedStyle(icon).opacity === "0"
    );
  };
  return {
    opacity: getComputedStyle(motion).opacity,
    preparing: /(?:appear|enter|prepare)(?:-|\s|$)/.test(
      `${el.className} ${motion.className}`,
    ),
    running: motion
      .getAnimations({ subtree: true })
      .some(
        (animation) =>
          animation.playState === "running" &&
          !completedLoadingDecoration(animation),
      ),
  };
}

// Self-contained for Playwright evaluation; the same public observation seam is
// exercised by explicit DOM measurements and native-browser regressions.
export function observeValidationGeometry(
  _body: Element,
  {
    checkFailure,
    removalFailure,
  }: { checkFailure: string; removalFailure: string },
) {
  const targets = [
    ...document.querySelectorAll<HTMLElement>(
      'button, [role="dialog"], [role="alert"]',
    ),
  ];
  const controls = targets
    .filter((el) => {
      const label = el.getAttribute("aria-label") || el.textContent || "";
      return (
        label.includes("校验") ||
        el.getAttribute("role") === "dialog" ||
        label.includes(checkFailure) ||
        label.includes(removalFailure)
      );
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      const pointerSuppressed = getComputedStyle(el).pointerEvents === "none";
      const originalStyle = el.getAttribute("style");
      let hit: Element | null;
      try {
        // Occlusion is not actionability: disabled shadcn controls deliberately
        // suppress pointer hits. Probe only this element, synchronously, without
        // enabling, focusing, scrolling, or clicking it. Covering elements and
        // ancestor clips still participate in the browser's actual hit test.
        if (pointerSuppressed) {
          // Keep the live element out of the CSSOM mutation path: native evidence
          // showed an absent attribute becoming empty after setProperty/removeAttribute.
          // Parse/override a detached declaration, then use the attribute API for
          // both the temporary value and the exact restoration below.
          const probeStyle = document.createElement("span").style;
          probeStyle.cssText = originalStyle ?? "";
          probeStyle.setProperty("pointer-events", "auto", "important");
          el.setAttribute("style", probeStyle.cssText);
        }
        hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
      } finally {
        if (pointerSuppressed) {
          if (originalStyle === null) el.removeAttribute("style");
          else el.setAttribute("style", originalStyle);
        }
      }
      return {
        role: el.getAttribute("role") || "button",
        kind:
          el.getAttribute("role") === "dialog"
            ? "result"
            : (el.textContent || "").includes("配置结构校验完成")
              ? "result-copy"
              : (el.textContent || "").includes(removalFailure)
                ? "removal-error"
                : (el.textContent || "").includes(checkFailure)
                  ? "validation-error"
                  : "validation-control",
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        inViewport:
          r.width > 0 &&
          r.height > 0 &&
          r.top >= 0 &&
          r.left >= 0 &&
          r.right <= innerWidth + 1 &&
          r.bottom <= innerHeight + 1,
        // This is a center occlusion sample, not proof of every painted pixel.
        unobscured: !!hit && el.contains(hit),
        occlusionProbe: pointerSuppressed
          ? "temporary-pointer-events-auto"
          : "unchanged",
        focused: el === document.activeElement,
        busy: el.getAttribute("aria-busy"),
      };
    });
  const result = document.querySelector<HTMLElement>('[data-slot="sheet-content"][data-state="open"][role="dialog"]');
  const title = result?.querySelector<HTMLElement>('[data-slot="sheet-title"]');
  const close = result?.querySelector<HTMLElement>('button[aria-label="关闭"]');
  const titleBox = title?.getBoundingClientRect();
  const closeBox = close?.getBoundingClientRect();
  return {
    resultHeader: titleBox && closeBox ? {
      titleRight: titleBox.right,
      closeLeft: closeBox.left,
      clearance: closeBox.left - titleBox.right,
    } : null,
    viewport: { width: innerWidth, height: innerHeight },
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    controls,
  };
}

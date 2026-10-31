import type { FocusEvent, KeyboardEvent, SyntheticEvent } from "react";
import { visibleFocusCandidates } from "./ui-patterns/focus-candidates";

// Nearest-edge movement; an oversized control already spanning the clip stays put.
const nearestDelta = (start: number, end: number, low: number, high: number) =>
  start < low && end > high
    ? 0
    : start < low
      ? Math.max(start - low, end - high)
      : end > high
        ? Math.min(start - low, end - high)
        : 0;

function rendered(target: HTMLElement, view: Window) {
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0" ||
      style.contentVisibility === "hidden"
    )
      return false;
  }
  return true;
}

/** Pending submit actions remain native focus stops, but cannot be activated again. */
function disabledForReveal(target: HTMLElement) {
  if (
    target.matches(":disabled") ||
    target.parentElement?.closest('[aria-disabled="true"]')
  )
    return true;
  const disabledOwner = target.closest('[aria-disabled="true"]');
  if (!disabledOwner) return false;
  return !(
    disabledOwner === target &&
    target instanceof HTMLButtonElement &&
    target.getAttribute("aria-busy") === "true"
  );
}

// Shared paint geometry only: callers establish their distinct physical owner.
function revealInScroller(
  target: HTMLElement,
  body: HTMLElement,
  view: Window,
  wholePixelMovement = false,
) {
  if (!rendered(target, view)) return;
  const box = target.getBoundingClientRect(),
    outer = body.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return;
  const outline = view.getComputedStyle(target),
    width = Number.parseFloat(outline.outlineWidth);
  const transparent =
    outline.outlineColor === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?%?\s*\)$/.test(outline.outlineColor) ||
    /\/\s*0(?:\.0+)?%?\s*\)$/.test(outline.outlineColor);
  const outset =
    !["none", "hidden"].includes(outline.outlineStyle) &&
    !transparent &&
    Number.isFinite(width) &&
    width > 0
      ? Math.max(0, width + (Number.parseFloat(outline.outlineOffset) || 0))
      : 0;
  const left = Math.max(0, outer.left + body.clientLeft);
  const top = Math.max(0, outer.top + body.clientTop);
  const right = Math.min(
    view.innerWidth,
    outer.left + body.clientLeft + body.clientWidth,
  );
  const bottom = Math.min(
    view.innerHeight,
    outer.top + body.clientTop + body.clientHeight,
  );
  if (right <= left || bottom <= top) return;
  const dx = nearestDelta(box.left - outset, box.right + outset, left, right);
  const dy = nearestDelta(box.top - outset, box.bottom + outset, top, bottom);
  // Modal scroll offsets can quantize fractional movement toward a clipped edge.
  // Round only a required move outward; Drawer callers retain their exact arithmetic.
  const movement = (delta: number) =>
    wholePixelMovement
      ? delta < 0
        ? Math.floor(delta)
        : Math.ceil(delta)
      : delta;
  if (dx) body.scrollLeft += movement(dx);
  if (dy) body.scrollTop += movement(dy);
}

/** Reveal native focus, never choose it. The current Drawer body is the only scroller. */
export function revealFocusedDrawerControl(event: FocusEvent<HTMLFormElement>) {
  const form = event.currentTarget,
    target = event.target;
  const doc = form.ownerDocument,
    view = doc.defaultView;
  if (
    !view ||
    !(target instanceof HTMLElement) ||
    !form.isConnected ||
    !target.isConnected ||
    doc.activeElement !== target ||
    !doc.hasFocus() ||
    doc.visibilityState !== "visible" ||
    !form.contains(target) ||
    target.closest("form") !== form ||
    !target.matches('button, input:not([type="hidden"]), select, textarea') ||
    target.matches(':disabled, [aria-disabled="true"]') ||
    target.closest(
      '[hidden], [inert], [aria-hidden="true"], [data-session-workspace][aria-busy="true"]',
    )
  )
    return;
  const dialog = form.closest('[role="dialog"]');
  const body = form.closest<HTMLElement>("[data-task-overlay-body]");
  if (
    !dialog ||
    !body ||
    !body.isConnected ||
    body.closest('[role="dialog"]') !== dialog ||
    target.closest('[role="dialog"],[role="alertdialog"]') !== dialog
  )
    return;
  revealInScroller(target, body, view);
}

const excluded =
  '[hidden], [inert], [aria-hidden="true"], [data-session-workspace][aria-busy="true"]';
const composite =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="tree"], [role="treegrid"], [role="grid"], [role="combobox"], [role="radiogroup"], [role="tablist"]';
const disclosure =
  '[data-slot="accordion-trigger"][aria-expanded]:not([aria-haspopup]),[data-slot="collapsible-trigger"][aria-expanded]:not([aria-haspopup])';
function firstSummary(node: HTMLElement) {
  const details = node.parentElement;
  return (
    node.tagName === "SUMMARY" &&
    details?.tagName === "DETAILS" &&
    Array.from(details.children).find(
      (child) => child.tagName === "SUMMARY",
    ) === node
  );
}
function policyControl(node: HTMLElement) {
  return (
    node.matches('button, input[type="checkbox"]') ||
    firstSummary(node) ||
    node.matches(disclosure) ||
    (node.matches("a[tabindex]") && !!node.closest('[data-slot="pagination"]'))
  );
}
function inComposite(node: HTMLElement) {
  if (node.closest(composite)) return true;
  const expanded = node.closest<HTMLElement>('[aria-expanded="true"]');
  // An opened read-only Collapse header is a disclosure, not a popup trigger.
  return !!expanded && !expanded.matches(disclosure);
}
function closedDetailsContent(node: HTMLElement) {
  for (
    let details = node.parentElement?.closest("details:not([open])");
    details;
    details = details.parentElement?.closest("details:not([open])")
  ) {
    const summary = Array.from(details.children).find(
      (child) => child.tagName === "SUMMARY",
    );
    if (!summary?.contains(node)) return true;
  }
  return false;
}
// Shadcn controls paint their own focus ring; do not inspect internal wrappers.
function modalPaint(node: HTMLElement, view: Window) {
  if (!rendered(node, view)) return null;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? node : null;
}
function modalOwner(wrap: HTMLDivElement, target: EventTarget) {
  const doc = wrap.ownerDocument,
    view = doc.defaultView;
  if (
    !view ||
    !wrap.isConnected ||
    !wrap.matches("[data-task-overlay],[data-task-overlay-wrap]") ||
    !(target instanceof HTMLElement) ||
    !target.isConnected ||
    !wrap.contains(target) ||
    doc.activeElement !== target ||
    !doc.hasFocus() ||
    doc.visibilityState !== "visible" ||
    !policyControl(target) ||
    target.matches(":disabled") ||
    disabledForReveal(target) ||
    target.closest(excluded) ||
    closedDetailsContent(target)
  )
    return null;
  const panels = wrap.matches(
    '[data-task-overlay][role="dialog"], [data-task-overlay][role="alertdialog"]',
  )
    ? [wrap]
    : Array.from(wrap.children).filter((node) =>
        node.matches('[data-task-overlay][aria-modal="true"]'),
      );
  const dialog = panels[0];
  if (
    panels.length !== 1 ||
    !(dialog instanceof HTMLElement) ||
    (target.closest("[data-task-overlay-wrap]") &&
      target.closest("[data-task-overlay-wrap]") !== wrap) ||
    target.closest('[role="dialog"],[role="alertdialog"]') !== dialog
  )
    return null;
  const paint = modalPaint(target, view);
  return paint ? { dialog, target, view, paint } : null;
}

/** Reveal only current read-only confirmation controls; Drawer eligibility is unchanged. */
export function revealFocusedPolicyModalControl(
  event: Pick<SyntheticEvent<HTMLDivElement>, "currentTarget" | "target">,
) {
  const owner = modalOwner(event.currentTarget, event.target);
  if (owner) {
    const body = owner.target.closest<HTMLElement>("[data-task-overlay-body]");
    const scroller =
      body && body.closest("[data-task-overlay]") === owner.dialog
        ? body
        : event.currentTarget;
    revealInScroller(owner.paint, scroller, owner.view, true);
  }
}

/** User-initiated local boundary response, never inactive-document focus recovery. */
export function wrapPolicyModalTab(event: KeyboardEvent<HTMLDivElement>) {
  if (
    event.key !== "Tab" ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.nativeEvent.isComposing
  )
    return;
  const wrap = event.currentTarget;
  // Radix handles native tab wrapping in actual task dialogs, sheets and decisions.
  if (
    wrap.matches(
      "[data-slot='dialog-content'],[data-slot='sheet-content'],[data-slot='alert-dialog-content']",
    )
  )
    return;
  const owner = modalOwner(wrap, event.target);
  if (!owner || inComposite(owner.target)) return;
  const { dialog, target, view } = owner;
  // Include intrinsic summaries on legacy non-Radix review surfaces;
  // explicit tabindex (including -1) still wins over its native default.
  const tabIndex = (node: HTMLElement) =>
    firstSummary(node) && !node.hasAttribute("tabindex") ? 0 : node.tabIndex;
  const controls = Array.from(
    new Set([
      ...visibleFocusCandidates(dialog),
      ...Array.from(dialog.querySelectorAll<HTMLElement>("summary")).filter(
        firstSummary,
      ),
    ]),
  )
    .filter((node) => {
      if (
        !node.isConnected ||
        tabIndex(node) < 0 ||
        !wrap.contains(node) ||
        (node.closest("[data-task-overlay-wrap]") &&
          node.closest("[data-task-overlay-wrap]") !== wrap) ||
        node.closest('[role="dialog"]') !== dialog ||
        node.closest(excluded) ||
        node.matches(":disabled") ||
        node.closest('[aria-disabled="true"]') ||
        closedDetailsContent(node)
      )
        return false;
      return !!modalPaint(node, view);
    })
    .sort((a, b) => {
      const order = (node: HTMLElement) =>
        tabIndex(node) > 0 ? tabIndex(node) : Infinity;
      const difference = order(a) - order(b);
      return (
        difference ||
        (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1)
      );
    });
  // This confirmation is read-only apart from checkboxes/disclosures/pagination.
  // An unexpected editable or composite sequence belongs to its own controller.
  if (controls.some((node) => !policyControl(node) || inComposite(node)))
    return;
  const first = controls[0],
    last = controls[controls.length - 1];
  const destination =
    event.shiftKey && target === first
      ? last
      : !event.shiftKey && target === last
        ? first
        : null;
  if (!destination) return;
  event.preventDefault();
  destination.focus({ preventScroll: true });
}

/** The reset section is outside the policy Form; reveal only its physical native controls. */
export function revealFocusedUsageResetControl(
  event: FocusEvent<HTMLDivElement>,
) {
  const section = event.currentTarget,
    target = event.target;
  const doc = section.ownerDocument,
    view = doc.defaultView;
  if (
    !view ||
    !(target instanceof HTMLElement) ||
    !section.isConnected ||
    !target.isConnected ||
    !section.matches("[data-policy-usage-reset]") ||
    doc.activeElement !== target ||
    !doc.hasFocus() ||
    doc.visibilityState !== "visible" ||
    !section.contains(target) ||
    target.closest("[data-policy-usage-reset]") !== section ||
    target.closest("form") ||
    !target.matches("button, textarea") ||
    target.matches(':disabled, [aria-disabled="true"]') ||
    target.closest(
      '[hidden], [inert], [aria-hidden="true"], [data-session-workspace][aria-busy="true"]',
    )
  )
    return;
  const dialog = section.closest('[role="dialog"]');
  const body = section.closest<HTMLElement>("[data-task-overlay-body]");
  if (
    !dialog ||
    !body ||
    !body.isConnected ||
    body.closest('[role="dialog"]') !== dialog ||
    target.closest('[role="dialog"],[role="alertdialog"]') !== dialog
  )
    return;
  revealInScroller(target, body, view, true);
}

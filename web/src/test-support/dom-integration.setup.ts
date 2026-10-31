import { afterEach, vi } from "vitest";
import { toast } from "sonner";
import { FUNCTIONAL_DOM_TEST_TIMEOUT_MS } from "./functional-dom-contract";

// jsdom files exercise functional user tasks, not a product response SLA.
// The project chooses a bounded 20 s whole-test default; this is not a
// performance improvement or an explanation of earlier deadline failures.
// Node tests keep their default 5 s; explicit per-test budgets take priority.
// Ordinary RTL waits, hooks, real events and visibility checks are unchanged.
// Vitest exposes this instance only in jsdom (not native Browser Mode).
if ("jsdom" in globalThis) {
  vi.setConfig({ testTimeout: FUNCTIONAL_DOM_TEST_TIMEOUT_MS });
}

// Radix and Command use native scrolling/pointer APIs. jsdom has no layout or
// pointer capture; geometric browser checks remain separate and may override these.
if (typeof window !== "undefined") {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!HTMLElement.prototype.hasPointerCapture) HTMLElement.prototype.hasPointerCapture = () => false;
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
}
if (typeof window !== "undefined" && typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe() {} unobserve() {} disconnect() {}
  };
}

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({matches:false,media:query,onchange:null,addListener() {},removeListener() {},addEventListener() {},removeEventListener() {},dispatchEvent:() => false});
}

// Sonner owns a module-level queue; isolate user notifications between mounted tasks.
afterEach(() => { toast.dismiss(); });

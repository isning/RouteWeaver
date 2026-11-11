// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { captureTextScaleFailure } from "./text-scale-failure";
import type { Locator, Page, TestInfo } from "@playwright/test";
vi.mock("node:fs/promises", () => ({ writeFile: vi.fn() }));

it("keeps failure evidence at the original viewport with masked text and controls", async () => {
  const screenshot = vi.fn();
  const locator = vi.fn(() => "masked-controls");
  const attach = vi.fn();
  const evaluate = vi.fn(async () => ({ intersection: { ratio: 65 / 66 } }));
  await captureTextScaleFailure({ screenshot, locator } as unknown as Page,
    { outputPath: (name: string) => name, attach } as unknown as TestInfo,
    { evaluate } as unknown as Locator);
  expect(attach).toHaveBeenCalledWith("lower-group-200pct-reading-failure", {
    body: JSON.stringify({ intersection: { ratio: 65 / 66 } }, null, 2), contentType: "application/json",
  });
  expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({
    path: "lower-group-200pct-reading-failure.png", fullPage: false,
    animations: "allow", mask: ["masked-controls"],
    style: expect.stringContaining("-webkit-text-fill-color: transparent !important"),
  }));
  expect(locator).toHaveBeenCalledWith("input, textarea, select, [contenteditable], img, svg, canvas, video, iframe");
});

it("attempts the screenshot after numeric evidence fails and suppresses capture errors", async () => {
  const screenshot = vi.fn().mockRejectedValue(new Error("capture unavailable"));
  await expect(captureTextScaleFailure({ screenshot, locator: vi.fn() } as unknown as Page,
    { outputPath: (name: string) => name } as unknown as TestInfo,
    { evaluate: vi.fn().mockRejectedValue(new Error("target unavailable")) } as unknown as Locator,
  )).resolves.toBeUndefined();
  expect(screenshot).toHaveBeenCalledOnce();
});

it("exports geometry categories without DOM text, identifiers, values or URLs", async () => {
  const target = document.createElement("input");
  target.id = "secret-id";
  target.value = "secret-value";
  target.setAttribute("aria-label", "secret-label");
  target.className = "secret-class";
  document.body.append(target);
  const attach = vi.fn();
  const bounds = new DOMRect(10, 20, 100, 66);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: unknown[]) => void) {}
    disconnect() {}
    observe() { this.callback([{ intersectionRatio: 65 / 66, isIntersecting: true,
      boundingClientRect: bounds, intersectionRect: new DOMRect(10, 21, 100, 65), rootBounds: new DOMRect(0, 0, 390, 844) }]); }
  });
  const animations = Object.getOwnPropertyDescriptor(document, "getAnimations");
  const hit = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  try {
    await captureTextScaleFailure({ screenshot: vi.fn(), locator: vi.fn() } as unknown as Page,
      { outputPath: (name: string) => name, attach } as unknown as TestInfo,
      { evaluate: (callback: (element: HTMLElement) => unknown) => callback(target) } as unknown as Locator);
    expect(attach).toHaveBeenCalledOnce();
    const body = attach.mock.calls[0][1].body;
    expect(body).not.toContain("secret-");
    const evidence = JSON.parse(body);
    expect(evidence.intersection.ratio).toBe(65 / 66);
    expect(evidence.intersection.intersection.height).toBe(65);
    expect(evidence.ancestors[0].depth).toBe(0);
    expect(evidence.centerHitsTarget).toBe(true);
  } finally {
    target.remove();
    vi.unstubAllGlobals();
    for (const [key, descriptor] of [["getAnimations", animations], ["elementFromPoint", hit]] as const) {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else Reflect.deleteProperty(document, key);
    }
  }
});

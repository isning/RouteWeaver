// @vitest-environment jsdom
// Real TemplatesPage/Ant controls; only ResizeObserver/layout boundaries are fake.
// These tests establish scroll/focus ownership, not actual browser fit or paint.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TemplatesPage } from "./Templates";

let viewportWidth = 900;
const observers: {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
}[] = [];
const rect = (left: number, width: number) =>
  ({
    x: left,
    y: 100,
    left,
    right: left + width,
    top: 100,
    bottom: 144,
    width,
    height: 44,
    toJSON() {},
  }) as DOMRect;

beforeEach(() => {
  viewportWidth = 900;
  observers.length = 0;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  });
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    computed(element),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      disconnected = false;
      constructor(public callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (
        this.matches('.template-bindings-table [data-slot="table-container"]')
      )
        return rect(33, viewportWidth);
      if (this.matches(".template-bindings-table table")) return rect(33, 650);
      if (this.matches(".template-binding-identity")) return rect(33, 104);
      if (this.matches(".template-binding-action button")) {
        const viewport = this.closest<HTMLElement>(
          '[data-slot="table-container"]',
        )!;
        return rect(547 - viewport.scrollLeft, 122);
      }
      return originalRect.call(this);
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(
        '.template-bindings-table [data-slot="table-container"]',
      )
        ? viewportWidth
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(
        '.template-bindings-table [data-slot="table-container"]',
      )
        ? 650
        : 0;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openLoadedMine() {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (init?.method && init.method !== "GET")
        throw new Error("No mutations expected");
      const url = String(input);
      if (url === "/api/templates")
        return json([
          {
            id: "template",
            name: "日常分流模板",
            kind: "client-profile",
            version: 2,
            spec: {},
          },
        ]);
      if (url === "/api/me/template-bindings")
        return json([
          {
            id: "binding",
            templateId: "template",
            targetKind: "profiles",
            targetId: "target",
            mode: "pinned",
            appliedVersion: 1,
            bindings: {},
          },
        ]);
      if (url === "/api/me/profiles")
        return json([
          {
            id: "target",
            name: "家庭配置",
            ir: { endpoints: [], groups: [], resources: [], rules: [] },
          },
        ]);
      if (url === "/api/me/collections") return json([]);
      throw new Error(`Unexpected read: ${url}`);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <TemplatesPage />
      </UIProviders>
    </QueryClientProvider>,
  );
  await screen.findByText("日常分流模板");
  // Data is already loaded before Tabs lazily mounts the actual table.
  await waitFor(() =>
    expect(client.getQueryData(["template-bindings"])).toBeTruthy(),
  );
  expect(screen.queryByRole("table")).toBeNull();
  await userEvent.click(screen.getByRole("tab", { name: "我的引用" }));
  const action = await screen.findByRole("button", {
    name: "查看固定版本 家庭配置",
  });
  const viewport = action.closest<HTMLElement>(
    '[data-slot="table-container"]',
  )!;
  action.style.outlineWidth = "3px";
  action.style.outlineStyle = "solid";
  action.style.outlineColor = "rgb(104, 156, 142)";
  action.style.outlineOffset = "1px";
  return { ...view, action, viewport };
}
function resize(viewport: HTMLElement, width: number) {
  viewportWidth = width;
  act(() => {
    for (const observer of [...observers]) {
      if (!observer.disconnected && observer.targets.has(viewport))
        observer.callback([], observer as unknown as ResizeObserver);
    }
  });
}

it("keeps the same focused action and outline visible after lazy-table resize without vertical scrolling", async () => {
  const view = await openLoadedMine();
  act(() => view.action.focus());
  const focus = vi.spyOn(view.action, "focus");
  const pageScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  view.viewport.scrollTop = 27;
  let left = 0;
  let writes = 0;
  Object.defineProperty(view.viewport, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = value;
      writes++;
    },
  });
  resize(view.viewport, 254);
  expect(view.viewport.scrollLeft).toBe(386);
  expect(writes).toBe(1);
  expect(document.activeElement).toBe(view.action);
  expect(view.viewport.scrollTop).toBe(27);
  expect(focus).not.toHaveBeenCalled();
  expect(pageScroll).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "查看固定版本 家庭配置" })).toBe(
    view.action,
  );
  resize(view.viewport, 254);
  expect(writes).toBe(1); // Unchanged width is a no-op, not a scroll feedback loop.
  resize(view.viewport, 0);
  expect(writes).toBe(1); // A hidden container must not move the table.
  resize(view.viewport, 254);
  expect(writes).toBe(1); // Already visible within the measured outline inset.
  const owned = observers.filter((observer) =>
    observer.targets.has(view.viewport),
  );
  expect(owned.length).toBeGreaterThan(0);
  view.unmount();
  expect(owned.every((observer) => observer.disconnected)).toBe(true);
  act(() => {
    for (const observer of owned)
      observer.callback([], observer as unknown as ResizeObserver);
  });
  expect(writes).toBe(1); // Even a queued callback after cleanup cannot act.
});

it("does not move the table or steal focus when resize belongs to an unfocused action", async () => {
  viewportWidth = 324;
  const view = await openLoadedMine();
  const tab = screen.getByRole("tab", { name: "我的引用" });
  act(() => tab.focus());
  view.viewport.scrollLeft = 100; // Valid at BOTH widths: no native max-scroll clamp.
  view.viewport.scrollTop = 19;
  const focus = vi.spyOn(view.action, "focus");
  resize(view.viewport, 254);
  expect(view.viewport.scrollLeft).toBe(100);
  expect(view.viewport.scrollTop).toBe(19);
  expect(document.activeElement).toBe(tab);
  expect(focus).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { UIProviders } from "./ui-patterns/providers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { revealFocusedDrawerControl } from "./drawer-control-visibility";
import { ServicePolicyEditor } from "./ServicePolicyEditor";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import { ownedClickScenario } from "./test-support/owned-click-scenario";

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  width,
  height,
  toJSON() {
    return {};
  },
});
// jsdom has no layout. Explicit box/client geometry and focus-paint values are
// supplied here; native Tab and actual ring paint are covered in the browser.
function geometry(
  body: HTMLElement,
  target: HTMLElement,
  box = rect(50, 550, 100, 38),
) {
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
    rect(20, 100, 300, 400),
  );
  for (const [name, value] of Object.entries({
    clientLeft: 2,
    clientTop: 2,
    clientWidth: 296,
    clientHeight: 396,
  }))
    vi.spyOn(body, name as "clientLeft", "get").mockReturnValue(value);
  const targetBox = vi
    .spyOn(target, "getBoundingClientRect")
    .mockReturnValue(box);
  body.scrollTop = 10;
  body.scrollLeft = 5;
  return targetBox;
}
function surface(children: ReactNode = <button>Preview</button>) {
  const rendered = render(
    <section role="dialog" aria-label="Current">
      <div data-task-overlay-body>
        <form onFocusCapture={revealFocusedDrawerControl}>{children}</form>
      </div>
    </section>,
  );
  const body = rendered.container.querySelector<HTMLElement>(
    "[data-task-overlay-body]",
  )!;
  const form = rendered.container.querySelector("form")!;
  return { ...rendered, body, form };
}

it("reveals the already-focused native action by the nearest body-only delta", () => {
  const { body, container } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  geometry(body, target);
  container.scrollTop = 25;
  const focus = vi.spyOn(target, "focus");
  target.focus({ preventScroll: true });
  expect(document.activeElement).toBe(target);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(body.scrollTop).toBe(100); // 588 - (100 + 2 + 396) = 90, not an alignment-to-top jump.
  expect(body.scrollLeft).toBe(5);
  expect(container.scrollTop).toBe(25);
});

it("leaves an already-visible focused control and its body position unchanged", () => {
  const { body } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  geometry(body, target, rect(50, 150, 100, 38));
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(10);
  expect(body.scrollLeft).toBe(5);
});

it.each([
  "0 0 0 3px rgba(180, 180, 180, 0.5)",
  "0 0 0 calc(3px + 0px) color-mix(in oklab, oklch(0.708 0 0) 50%, transparent)",
])(
  "reveals the 3px Tailwind ring target before its box-shadow transition finishes: %s",
  (ring) => {
    const { body, container } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target, rect(50, 460, 100, 38));
    target.style.setProperty("--tw-ring-shadow", ring);
    // The animated shadow may still be at its start during focus capture.
    target.style.boxShadow = "none";
    container.scrollTop = 25;
    const focus = vi.spyOn(target, "focus");
    target.focus({ preventScroll: true });
    expect(document.activeElement).toBe(target);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(body.scrollTop).toBe(13); // Border ends at 498; only the ring's 3px were clipped.
    expect(body.scrollLeft).toBe(5);
    expect(container.scrollTop).toBe(25);
  },
);

it("does not move again once the focused ring fits the current clip", () => {
  const { body } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  const box = geometry(body, target, rect(50, 460, 100, 38));
  target.style.setProperty(
    "--tw-ring-shadow",
    "0 0 0 calc(3px + 0px) rgb(180, 180, 180)",
  );
  target.focus({ preventScroll: true });
  expect(body.scrollTop).toBe(13);
  box.mockReturnValue(rect(50, 457, 100, 38)); // The 3px move leaves the whole ring visible.
  fireEvent.focusIn(target);
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(13);
  expect(body.scrollLeft).toBe(5);
});

it.each([
  {
    outline: "0px",
    ring: "0 0 0 calc(3px + 2px) rgb(180, 180, 180)",
    scroll: 15,
  },
  {
    outline: "4px",
    ring: "0 0 0 calc(3px + 0px) rgb(180, 180, 180)",
    scroll: 17,
  },
])(
  "uses the outermost ring or outline without adding their extents: $scroll",
  ({ outline, ring, scroll }) => {
    const { body } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target, rect(50, 460, 100, 38));
    Object.assign(target.style, {
      outlineStyle: "solid",
      outlineWidth: "3px",
      outlineOffset: outline,
      outlineColor: "rgb(22, 117, 101)",
    });
    target.style.setProperty("--tw-ring-shadow", ring);
    target.focus({ preventScroll: true });
    expect(body.scrollTop).toBe(scroll);
  },
);

it.each([
  "",
  "0 0 #0000",
  "0 0 0 3px transparent",
  "0 0 0 3px #0000",
  "0 0 0 3px rgba(0, 0, 0, 0)",
  "inset 0 0 0 3px rgb(180, 180, 180)",
  "2px 0 0 3px rgb(180, 180, 180)",
  "0 0 4px 3px rgb(180, 180, 180)",
])(
  "does not invent an outer focus ring for unsupported or unpainted shadow %s",
  (ring) => {
    const { body } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target, rect(50, 460, 100, 38));
    target.style.setProperty("--tw-ring-shadow", ring);
    target.focus({ preventScroll: true });
    expect(body.scrollTop).toBe(10);
    expect(body.scrollLeft).toBe(5);
  },
);

it.each([
  { offset: "4px", scroll: 17 },
  { offset: "-1px", scroll: 12 },
  { offset: "-3px", scroll: 10 },
])(
  "reveals the computed 3px focus outline with signed $offset offset, not an arbitrary gap",
  ({ offset, scroll }) => {
    const { body } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target, rect(50, 460, 100, 38)); // Border box is visible; painted outline may extend past498.
    Object.assign(target.style, {
      outlineStyle: "solid",
      outlineWidth: "3px",
      outlineOffset: offset,
      outlineColor: "rgb(22, 117, 101)",
    });
    target.focus({ preventScroll: true });
    expect(document.activeElement).toBe(target);
    expect(body.scrollTop).toBe(scroll);
    expect(body.scrollLeft).toBe(5);
  },
);

it.each([
  { name: "absent", style: "none", width: "3px", color: "rgb(22, 117, 101)" },
  {
    name: "transparent",
    style: "solid",
    width: "3px",
    color: "rgba(22, 117, 101, 0)",
  },
  {
    name: "zero-width",
    style: "solid",
    width: "0px",
    color: "rgb(22, 117, 101)",
  },
])(
  "does not invent an outset for an $name outline",
  ({ style, width, color }) => {
    const { body } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target, rect(50, 460, 100, 38));
    Object.assign(target.style, {
      outlineStyle: style,
      outlineWidth: width,
      outlineOffset: "4px",
      outlineColor: color,
    });
    target.focus({ preventScroll: true });
    expect(document.activeElement).toBe(target);
    expect(body.scrollTop).toBe(10);
    expect(body.scrollLeft).toBe(5);
  },
);

it("uses border-aware top and left clipping without redirecting input focus", () => {
  const { body } = surface(<input aria-label="Name" />);
  const target = screen.getByRole("textbox", { name: "Name" });
  geometry(body, target, rect(10, 90, 100, 38));
  body.scrollTop = 100;
  body.scrollLeft = 50;
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(88);
  expect(body.scrollLeft).toBe(38);
});

it("intersects the current body clip with the viewport instead of scrolling the page", () => {
  const { body, container } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  geometry(body, target, rect(50, window.innerHeight - 18, 100, 38));
  vi.mocked(body.getBoundingClientRect).mockReturnValue(
    rect(20, window.innerHeight - 168, 300, 400),
  );
  container.scrollTop = 25;
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(30);
  expect(container.scrollTop).toBe(25);
});

it("does not oscillate an oversized control already spanning the clipping rectangle", () => {
  const { body } = surface(<textarea aria-label="Notes" />);
  const target = screen.getByRole("textbox", { name: "Notes" });
  geometry(body, target, rect(0, 50, 400, 500));
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(10);
  expect(body.scrollLeft).toBe(5);
});

it.each([
  [
    "hidden",
    (node: HTMLElement) => {
      node.hidden = true;
    },
  ],
  ["inert", (node: HTMLElement) => node.setAttribute("inert", "")],
  [
    "aria-hidden",
    (node: HTMLElement) => node.setAttribute("aria-hidden", "true"),
  ],
  [
    "display none",
    (node: HTMLElement) => {
      node.style.display = "none";
    },
  ],
  [
    "visibility hidden",
    (node: HTMLElement) => {
      node.style.visibility = "hidden";
    },
  ],
  [
    "opacity zero",
    (node: HTMLElement) => {
      node.style.opacity = "0";
    },
  ],
  [
    "inactive workspace",
    (node: HTMLElement) => {
      node.setAttribute("data-session-workspace", "");
      node.setAttribute("aria-busy", "true");
    },
  ],
] as const)("does not reveal through a %s owner", (_name, hide) => {
  const { body, form } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  target.style.setProperty(
    "--tw-ring-shadow",
    "0 0 0 calc(3px + 0px) rgb(180, 180, 180)",
  );
  const box = geometry(body, target, rect(50, 150, 100, 38));
  target.focus();
  box.mockReturnValue(rect(50, 550, 100, 38));
  hide(form);
  fireEvent.focusIn(target);
  expect(body.scrollTop).toBe(10);
  expect(body.scrollLeft).toBe(5);
});

it.each(["unfocused", "hidden"] as const)(
  "does not reveal in an %s document",
  (state) => {
    const { body } = surface();
    const target = screen.getByRole("button", { name: "Preview" });
    geometry(body, target);
    if (state === "unfocused")
      vi.mocked(document.hasFocus).mockReturnValue(false);
    else vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    target.focus();
    expect(body.scrollTop).toBe(10);
    expect(body.scrollLeft).toBe(5);
  },
);

it.each(["alert", "group"])(
  "does not intercept an owned or passive %s summary",
  (role) => {
    const { body } = surface(
      <div role={role} tabIndex={-1}>
        Error summary
      </div>,
    );
    const target = screen.getByText("Error summary");
    geometry(body, target);
    target.focus();
    expect(document.activeElement).toBe(target);
    expect(body.scrollTop).toBe(10);
  },
);

it("ignores a synthetic focus event whose target is not actually focused", () => {
  const { body } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  target.style.setProperty(
    "--tw-ring-shadow",
    "0 0 0 calc(3px + 0px) rgb(180, 180, 180)",
  );
  geometry(body, target);
  fireEvent.focusIn(target);
  expect(document.activeElement).not.toBe(target);
  expect(body.scrollTop).toBe(10);
});

it("ignores a React-bubbling portal control outside the physical form", () => {
  const { body } = surface(
    <>
      {createPortal(<button>Portal control</button>, document.body)}
      <button>Preview</button>
    </>,
  );
  const target = screen.getByRole("button", { name: "Portal control" });
  geometry(body, target);
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(10);
});

it("does not take scrolling ownership from a nested dialog", () => {
  const { body } = surface(
    <section role="dialog" aria-label="Nested">
      <button>Nested action</button>
    </section>,
  );
  const target = screen.getByRole("button", { name: "Nested action" });
  geometry(body, target);
  target.focus();
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(10);
});

it("ignores disconnected forms and targets", () => {
  const { body, container } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  geometry(body, target);
  container.remove();
  target.focus();
  fireEvent.focusIn(target);
  expect(body.scrollTop).toBe(10);
});

it("ignores a control without a rendered box", () => {
  const { body } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  geometry(body, target, rect(50, 550, 0, 0));
  target.focus();
  expect(body.scrollTop).toBe(10);
});

it("does not reveal a control disabled after it received focus", () => {
  const { body } = surface();
  const target = screen.getByRole("button", { name: "Preview" });
  const box = geometry(body, target, rect(50, 150, 100, 38));
  target.focus();
  box.mockReturnValue(rect(50, 550, 100, 38));
  target.setAttribute("aria-disabled", "true");
  fireEvent.focusIn(target);
  expect(body.scrollTop).toBe(10);
});

it("wires visibility reveal to the actual guarded service form without submitting or changing its draft", async (context) => {
  const owner = ownedClickScenario(context);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const saved = {
    id: "plan",
    name: "标准方案",
    quotaBytes: 50 * 1024 ** 3,
    routeIds: [],
    onlineIpLimit: 0,
    connectionLimit: 0,
    entryRateBps: 0,
    cycle: {
      mode: "monthly",
      day: 31,
      days: 17,
      anchor: "2026-01-01T00:00:00.123456789+08:00",
      timezone: "Asia/Shanghai",
    },
  };
  const fixture = serviceEditFixture(saved, "opened-plan");
  const fetch = vi.fn(async (url, init) => {
    if (
      String(url).endsWith("/access-policy/edit-context/service/plan") &&
      (!init?.method || init.method === "GET")
    )
      return new Response(JSON.stringify(fixture.context()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <ServicePolicyEditor
          initial={saved}
          users={[]}
          services={[saved]}
          routes={[]}
          onClose={() => {}}
        />
      </UIProviders>
    </QueryClientProvider>,
  );
  const name = await screen.findByLabelText("服务方案名称");
  owner.assertActive();
  const target = screen.getByRole("button", { name: "预览影响" });
  const body = target.closest<HTMLElement>("[data-task-overlay-body]")!;
  geometry(body, target);
  // Explicit public paint seam: this wiring assertion does not depend on theme CSS.
  Object.assign(target.style, {
    outlineStyle: "solid",
    outlineWidth: "3px",
    outlineOffset: "4px",
    outlineColor: "rgb(22, 117, 101)",
  });
  target.focus({ preventScroll: true });
  expect(document.activeElement).toBe(target);
  expect(body.scrollTop).toBe(107);
  expect((name as HTMLInputElement).value).toBe("标准方案");
  expect((screen.getByLabelText("每月几号") as HTMLInputElement).value).toBe(
    "31",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull();
});

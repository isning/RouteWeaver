// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { useState, type ReactNode } from "react";
import { UIProviders } from "./ui-patterns/providers";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./components/ui/checkbox";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  revealFocusedPolicyModalControl,
  wrapPolicyModalTab,
} from "./drawer-control-visibility";
import { usePolicyChange } from "./AccessPolicy";
import { ownedClickScenario } from "./test-support/owned-click-scenario";
import { serviceEditFixture } from "./test-support/service-edit-fixture";
import type { Service } from "./types";
import type { EffectivePolicy } from "./access-policy-model";

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
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
  const original = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) =>
    original(node),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
// Layout is the explicit browser seam in jsdom. No focus utility or adapter is mocked.
// This does not simulate native Tab traversal; the unchanged actual diagnostic owns that proof.
function geometry(
  wrap: HTMLElement,
  target: HTMLElement,
  box = rect(50, 550, 100, 38),
) {
  if (!vi.isMockFunction(wrap.getBoundingClientRect)) {
    vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue(
      rect(20, 100, 300, 400),
    );
    for (const [name, value] of Object.entries({
      clientLeft: 2,
      clientTop: 2,
      clientWidth: 296,
      clientHeight: 396,
    }))
      vi.spyOn(wrap, name as "clientLeft", "get").mockReturnValue(value);
  }
  if (vi.isMockFunction(target.getBoundingClientRect))
    vi.mocked(target.getBoundingClientRect).mockReturnValue(box);
  else vi.spyOn(target, "getBoundingClientRect").mockReturnValue(box);
}
function outline(target: HTMLElement, offset = "4px") {
  Object.assign(target.style, {
    outlineStyle: "solid",
    outlineWidth: "3px",
    outlineOffset: offset,
    outlineColor: "rgb(22, 117, 101)",
  });
}
function focus(target: HTMLElement) {
  act(() => target.focus({ preventScroll: true }));
}
function key(target: HTMLElement, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, { key: "Tab", ...init });
}
function surface(
  children: ReactNode = (
    <>
      <button>Close</button>
      <input aria-label="Consent" type="checkbox" />
      <button>Return</button>
      <button disabled>Update</button>
    </>
  ),
) {
  const view = render(
    <div
      data-task-overlay-wrap
      onFocusCapture={revealFocusedPolicyModalControl}
      onKeyDown={wrapPolicyModalTab}
    >
      <div
        data-task-overlay="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Current"
      >
        {children}
      </div>
    </div>,
  );
  const wrap = view.container.querySelector<HTMLElement>(
    "[data-task-overlay-wrap]",
  )!;
  const dialog = within(view.container).getByRole("dialog", {
    name: "Current",
  });
  for (const node of dialog.querySelectorAll<HTMLElement>(
    "button, input, select, textarea, [tabindex], summary",
  ))
    geometry(wrap, node, rect(50, 150, 100, 38));
  wrap.scrollTop = 10;
  wrap.scrollLeft = 5;
  return { ...view, wrap, dialog };
}

it("reveals the existing native footer focus and painted outline using only its current modal wrapper", () => {
  const { wrap, container } = surface();
  const target = screen.getByRole("button", { name: "Return" });
  geometry(wrap, target);
  outline(target);
  container.scrollTop = 25;
  const focusCall = vi.spyOn(target, "focus");
  focus(target);
  expect(document.activeElement).toBe(target);
  expect(focusCall).toHaveBeenCalledTimes(1);
  expect(wrap.scrollTop).toBe(107);
  expect(wrap.scrollLeft).toBe(5);
  expect(container.scrollTop).toBe(25);
});

it.each(["busy", "native-disabled", "disabled-owner"] as const)(
  "reveals only a natively focusable busy action (%s)",
  (mode) => {
    const { wrap } = surface(
      <div aria-disabled={mode === "disabled-owner" ? "true" : undefined}>
        <button
          aria-busy="true"
          aria-disabled="true"
          disabled={mode === "native-disabled"}
        >
          Saving
        </button>
      </div>,
    );
    const target = screen.getByRole("button", { name: "Saving" });
    geometry(wrap, target);
    outline(target);
    focus(target);
    if (mode === "busy") {
      expect(document.activeElement).toBe(target);
      expect(wrap.scrollTop).toBe(107);
    } else expect(wrap.scrollTop).toBe(10);
  },
);

it.each([
  { offset: "4px", scroll: 17 },
  { offset: "-1px", scroll: 12 },
  { offset: "-3px", scroll: 10 },
])(
  "respects the painted outline's signed $offset extent at the visible edge",
  ({ offset, scroll }) => {
    const { wrap } = surface();
    const target = screen.getByRole("button", { name: "Return" });
    geometry(wrap, target, rect(50, 460, 100, 38));
    outline(target, offset);
    focus(target);
    expect(wrap.scrollTop).toBe(scroll);
    expect(document.activeElement).toBe(target);
  },
);

it.each([
  { edge: "above", top: 108.5625, scroll: 9 },
  { edge: "below", top: 453.4375, scroll: 11 },
])(
  "rounds a required fractional $edge movement outward without changing native focus",
  ({ top, scroll }) => {
    const { wrap } = surface();
    const target = screen.getByRole("button", { name: "Return" });
    geometry(wrap, target, rect(50, top, 100, 38));
    outline(target);
    // Explicit layout seam: an integer-quantizing browser would discard +/-0.4375.
    let actualScroll = 10;
    const requested: number[] = [];
    Object.defineProperty(wrap, "scrollTop", {
      configurable: true,
      get: () => actualScroll,
      set: (value: number) => {
        requested.push(value);
        actualScroll = Math.round(value);
      },
    });
    const focusCall = vi.spyOn(target, "focus");
    const documentScroll = document.documentElement.scrollTop;
    focus(target);
    expect(requested).toEqual([scroll]);
    expect(wrap.scrollTop).toBe(scroll);
    expect(document.activeElement).toBe(target);
    expect(focusCall).toHaveBeenCalledTimes(1);
    expect(wrap.scrollLeft).toBe(5);
    expect(document.documentElement.scrollTop).toBe(documentScroll);
  },
);

it("leaves already-visible focus and wrapper position unchanged", () => {
  const { wrap } = surface();
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  expect(wrap.scrollTop).toBe(10);
  expect(wrap.scrollLeft).toBe(5);
  expect(document.activeElement).toBe(target);
});

it.each([false, true])(
  "wraps a genuine native-button boundary with shift=%s and reveals the destination",
  (shiftKey) => {
    const { wrap } = surface();
    const first = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Return" });
    const source = shiftKey ? first : last,
      destination = shiftKey ? last : first;
    focus(source);
    geometry(wrap, destination);
    outline(destination);
    const destinationFocus = vi.spyOn(destination, "focus");
    expect(key(source, { shiftKey })).toBe(false);
    expect(destinationFocus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(document.activeElement).toBe(destination);
    expect(wrap.scrollTop).toBe(107);
    expect(
      screen.getByRole("button", { name: "Update" }).matches(":disabled"),
    ).toBe(true);
  },
);

it("keeps shadcn checkbox focus while revealing its own painted outline without toggling consent", () => {
  const { wrap } = surface(
    <>
      <button>Close</button>
      <Checkbox aria-label="Painted consent" />
    </>,
  );
  const target = screen.getByRole("checkbox", { name: "Painted consent" });
  expect(target.matches("button[data-slot='checkbox']")).toBe(true);
  geometry(wrap, target, rect(50, 482, 16, 16));
  outline(target);
  const targetFocus = vi.spyOn(target, "focus");
  focus(target);
  expect(document.activeElement).toBe(target);
  expect(wrap.scrollTop).toBe(17);
  expect(key(target)).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Close" }),
  );
  expect(key(document.activeElement as HTMLElement, { shiftKey: true })).toBe(
    false,
  );
  expect(document.activeElement).toBe(target);
  expect(target.getAttribute("aria-checked")).toBe("false");
  expect(targetFocus).toHaveBeenCalledTimes(2);
});

it.each([
  "hidden paint",
  "transparent paint",
  "wrong wrapper",
  "unrelated input",
  "two native inputs",
] as const)("does not borrow visibility from a %s checkbox shape", (shape) => {
  const native = (
    <input
      type="checkbox"
      aria-label="Consent"
      data-hidden-control={shape === "unrelated input" ? undefined : "checkbox"}
      style={{ opacity: 0 }}
    />
  );
  const { wrap } = surface(
    <>
      <button>Close</button>
      {shape === "wrong wrapper" ? (
        <div data-control-wrapper>{native}</div>
      ) : (
        <span data-control-wrapper>{native}</span>
      )}
    </>,
  );
  const target = screen.getByRole("checkbox", { name: "Consent" });
  const paint = target.parentElement!;
  geometry(wrap, target);
  geometry(wrap, paint);
  outline(paint);
  if (shape === "hidden paint") paint.style.display = "none";
  if (shape === "transparent paint") paint.style.opacity = "0";
  if (shape === "two native inputs")
    paint.append(document.createElement("input"));
  focus(target);
  expect(key(target)).toBe(true);
  expect(wrap.scrollTop).toBe(10);
});

it("orders positive tabindex before zero instead of confusing DOM order with sequential boundaries", () => {
  surface(
    <>
      <button>Close</button>
      <button tabIndex={2}>Second positive</button>
      <button tabIndex={1}>First positive</button>
      <button>Return</button>
    </>,
  );
  const first = screen.getByRole("button", { name: "First positive" });
  const last = screen.getByRole("button", { name: "Return" });
  focus(last);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(first);
  expect(key(first, { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
});

it.each([
  { name: "Alt", init: { altKey: true } },
  { name: "Control", init: { ctrlKey: true } },
  { name: "Meta", init: { metaKey: true } },
  { name: "composition", init: { isComposing: true } },
  { name: "Escape", init: { key: "Escape" } },
])("leaves $name keyboard events to their existing owner", ({ init }) => {
  surface();
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  expect(key(target, init)).toBe(true);
  expect(document.activeElement).toBe(target);
});

it("does not reinterpret interior Tab or an unfocused synthetic target", () => {
  surface();
  const middle = screen.getByRole("checkbox", { name: "Consent" });
  const last = screen.getByRole("button", { name: "Return" });
  focus(middle);
  expect(key(middle)).toBe(true);
  expect(key(last)).toBe(true);
  expect(document.activeElement).toBe(middle);
});

it("respects descendant prevention and does not stop the existing ancestor key handler", () => {
  const bubbled = vi.fn();
  const { container } = surface(
    <>
      <button>Close</button>
      <button onKeyDown={(event) => event.preventDefault()}>Return</button>
    </>,
  );
  container.addEventListener("keydown", bubbled);
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  expect(key(target)).toBe(false);
  expect(document.activeElement).toBe(target);
  expect(bubbled).toHaveBeenCalledTimes(1);
  container.removeEventListener("keydown", bubbled);
});

it.each(["menu", "listbox", "tree", "grid", "combobox", "radiogroup"])(
  "does not steal keys from an active %s composite",
  (role) => {
    surface(
      <>
        <button>Close</button>
        <div role={role}>
          <button>Return</button>
        </div>
      </>,
    );
    const target = screen.getByRole("button", { name: "Return" });
    focus(target);
    expect(key(target)).toBe(true);
    expect(document.activeElement).toBe(target);
  },
);

it("does not steal keys from an expanded popup trigger", () => {
  surface(
    <>
      <button>Close</button>
      <button aria-expanded="true">Return</button>
    </>,
  );
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  expect(key(target)).toBe(true);
  expect(document.activeElement).toBe(target);
});

it("wraps both directions through a checkbox-first pending shape without toggling consent", () => {
  surface(
    <>
      <input aria-label="Consent" type="checkbox" />
      <button disabled>Return</button>
      <button aria-busy="true">Update</button>
    </>,
  );
  const first = screen.getByRole("checkbox", { name: "Consent" });
  const last = screen.getByRole("button", { name: "Update" });
  focus(first);
  expect(key(first, { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(first);
  expect((first as HTMLInputElement).checked).toBe(false);
});

it("uses the first intrinsic summary in DOM order and excludes a closed details body and later summaries", () => {
  const { wrap } = surface(
    <>
      <details>
        <summary>Identity</summary>
        <button>Closed body</button>
        <summary>Not the disclosure</summary>
      </details>
      <input type="checkbox" aria-label="Consent" />
      <button>Update</button>
    </>,
  );
  const first = screen.getByText("Identity", { selector: "summary" });
  const last = screen.getByRole("button", { name: "Update" });
  focus(last);
  geometry(wrap, first);
  outline(first);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(first);
  expect(wrap.scrollTop).toBe(107);
  expect(key(first, { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
  expect(first.parentElement!.hasAttribute("open")).toBe(false);
});

it("honors a summary's explicit negative tabindex instead of forcing its native default", () => {
  surface(
    <>
      <details>
        <summary tabIndex={-1}>Identity</summary>
      </details>
      <input type="checkbox" aria-label="Consent" />
      <button>Update</button>
    </>,
  );
  const first = screen.getByRole("checkbox", { name: "Consent" });
  const last = screen.getByRole("button", { name: "Update" });
  focus(last);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(first);
});

it("sorts explicit positive summary tabindex with native controls before default DOM order", () => {
  surface(
    <>
      <button>Close</button>
      <details>
        <summary tabIndex={1}>Identity</summary>
      </details>
      <button tabIndex={2}>Second</button>
      <button>Update</button>
    </>,
  );
  const last = screen.getByRole("button", { name: "Update" });
  focus(last);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByText("Identity", { selector: "summary" }),
  );
});

it.each([false, true])(
  "wraps the actual read-only disclosure header with expanded=%s, without expanding it",
  (expanded) => {
    const { wrap } = surface(
      <>
        <div
          data-slot="accordion-trigger"
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
        >
          Rules
        </div>
        <input type="checkbox" aria-label="Consent" />
        <button>Update</button>
      </>,
    );
    const first = screen.getByRole("button", { name: "Rules" });
    const last = screen.getByRole("button", { name: "Update" });
    focus(last);
    geometry(wrap, first);
    outline(first);
    expect(key(last)).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(wrap.scrollTop).toBe(107);
    expect(key(first, { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    expect(first.getAttribute("aria-expanded")).toBe(String(expanded));
  },
);

it("preserves pagination's explicit list-item tab stops while excluding disabled and negative-index icon buttons", () => {
  surface(
    <>
      <ul data-slot="pagination">
        <li aria-disabled="true">Previous</li>
        <li>
          <a tabIndex={0}>Page one</a>
        </li>
        <li>
          <a tabIndex={0}>
            Next<span>Icon</span>
          </a>
        </li>
      </ul>
      <button>Update</button>
    </>,
  );
  const first = screen.getByText("Page one");
  const last = screen.getByRole("button", { name: "Update" });
  focus(last);
  expect(key(last)).toBe(false);
  expect(document.activeElement).toBe(first);
  expect(key(first, { shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(last);
});

it.each(["editable", "unknown tabindex", "popup disclosure"])(
  "fails closed rather than inventing traversal for an unexpected %s sequence",
  (shape) => {
    surface(
      <>
        {shape === "editable" ? (
          <input aria-label="Editable" />
        ) : shape === "unknown tabindex" ? (
          <div tabIndex={0}>Unknown</div>
        ) : (
          <div
            data-slot="accordion-trigger"
            role="button"
            tabIndex={0}
            aria-expanded="true"
            aria-haspopup="menu"
          >
            Popup
          </div>
        )}
        <button>Update</button>
      </>,
    );
    const last = screen.getByRole("button", { name: "Update" });
    focus(last);
    expect(key(last)).toBe(true);
    expect(document.activeElement).toBe(last);
  },
);

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
] as const)(
  "neither reveals nor redirects focus through a %s owner",
  (_name, hide) => {
    const { wrap, dialog } = surface();
    const target = screen.getByRole("button", { name: "Return" });
    focus(target);
    geometry(wrap, target);
    hide(dialog);
    fireEvent.focusIn(target);
    expect(key(target)).toBe(true);
    expect(wrap.scrollTop).toBe(10);
    expect(document.activeElement).toBe(target);
  },
);

it.each(["unfocused", "hidden"] as const)(
  "does not recover an %s document",
  (state) => {
    const { wrap } = surface();
    const target = screen.getByRole("button", { name: "Return" });
    focus(target);
    geometry(wrap, target);
    if (state === "unfocused")
      vi.mocked(document.hasFocus).mockReturnValue(false);
    else vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent.focusIn(target);
    expect(key(target)).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(wrap.scrollTop).toBe(10);
  },
);

it.each(["alert", "group"])(
  "leaves the owned non-native %s summary focus unchanged",
  (role) => {
    const { wrap } = surface(
      <div tabIndex={-1} role={role}>
        Error summary
      </div>,
    );
    const target = screen.getByText("Error summary");
    geometry(wrap, target);
    focus(target);
    expect(key(target)).toBe(true);
    expect(wrap.scrollTop).toBe(10);
    expect(document.activeElement).toBe(target);
  },
);

it("ignores a React-bubbling foreign modal portal", () => {
  const { wrap } = surface(
    <>
      <button>Close</button>
      {createPortal(
        <div data-task-overlay-wrap>
          <div data-task-overlay="dialog" role="dialog" aria-modal="true">
            <button>Foreign</button>
          </div>
        </div>,
        document.body,
      )}
      <button>Return</button>
    </>,
  );
  const target = screen.getByRole("button", { name: "Foreign" });
  geometry(wrap, target);
  focus(target);
  expect(key(target)).toBe(true);
  expect(document.activeElement).toBe(target);
  expect(wrap.scrollTop).toBe(10);
});

it("leaves an inline nested dialog to its own physical owner", () => {
  const { wrap } = surface(
    <section role="dialog" aria-label="Nested">
      <button>Nested action</button>
    </section>,
  );
  const target = screen.getByRole("button", { name: "Nested action" });
  geometry(wrap, target);
  focus(target);
  expect(key(target)).toBe(true);
  expect(document.activeElement).toBe(target);
  expect(wrap.scrollTop).toBe(10);
});

it.each(["missing", "multiple"])(
  "fails closed with %s directly owned panels",
  (shape) => {
    const { wrap, dialog } = surface();
    const target = screen.getByRole("button", { name: "Return" });
    focus(target);
    geometry(wrap, target);
    if (shape === "missing") dialog.removeAttribute("data-task-overlay");
    else wrap.append(dialog.cloneNode(true));
    fireEvent.focusIn(target);
    expect(key(target)).toBe(true);
    expect(wrap.scrollTop).toBe(10);
    expect(document.activeElement).toBe(target);
  },
);

it("excludes a disabled fieldset destination and a subsequently aria-disabled active target", () => {
  const { wrap } = surface(
    <>
      <button>Close</button>
      <button>Return</button>
      <fieldset disabled>
        <button>Disabled destination</button>
      </fieldset>
    </>,
  );
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  expect(key(target)).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Close" }),
  );
  focus(target);
  geometry(wrap, target);
  target.setAttribute("aria-disabled", "true");
  fireEvent.focusIn(target);
  expect(key(target)).toBe(true);
  expect(document.activeElement).toBe(target);
  expect(wrap.scrollTop).toBe(10);
});

it("ignores non-rendered and disconnected owners without focus recovery", () => {
  const { wrap, container } = surface();
  const target = screen.getByRole("button", { name: "Return" });
  focus(target);
  geometry(wrap, target, rect(50, 550, 0, 0));
  fireEvent.focusIn(target);
  expect(key(target)).toBe(true);
  expect(wrap.scrollTop).toBe(10);
  geometry(wrap, target);
  container.remove();
  fireEvent.focusIn(target);
  expect(key(target)).toBe(true);
  expect(wrap.scrollTop).toBe(10);
});

const saved: Service = {
  id: "plan",
  name: "Standard",
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
const proposed: Service = { ...saved, quotaBytes: 100 * 1024 ** 3 };
const consent = "我已核对本次授权变更";
type Variant = "resource" | "affected" | "zero";
const entitlementChange = {
  entitlement: {
    userId: "user",
    startsAt: "2026-01-01T00:00:00Z",
    cycle: saved.cycle,
  },
};
const before: EffectivePolicy = {
  userId: "user",
  groupIds: [],
  routeIds: [],
  quotaBytes: 0,
  onlineIpLimit: 0,
  connectionLimit: 0,
  entryRateBps: 0,
  status: "active",
  provenance: {},
  entitlement: entitlementChange.entitlement,
};
const groupChange = {
  group: {
    id: "group",
    name: "Family",
    serviceId: saved.id,
    priority: 1,
    memberIds: Array.from({ length: 6 }, (_, index) => `user-${index}`),
  },
};
const affected = groupChange.group.memberIds.map((userId) => {
  const prior = {
    ...before,
    userId,
    entitlement: { ...before.entitlement, userId },
  };
  return {
    userId,
    before: prior,
    after: {
      ...prior,
      groupIds: ["group"],
      serviceId: saved.id,
      service: saved,
      quotaBytes: saved.quotaBytes,
      provenance: { service: "group", quotaBytes: `service:${saved.id}` },
    },
  };
});
const legacyChange = (variant: Variant) =>
  variant === "affected" ? groupChange : entitlementChange;
function Caller({ variant }: { variant: Variant }) {
  const [draft, setDraft] = useState("Unchanged draft");
  const policy = usePolicyChange({
    mode: variant === "resource" ? "guarded-service" : "legacy-replacement",
    users: [],
    services: [saved],
    routes: [],
    onApplied: () => {},
  });
  return (
    <section role="dialog" aria-label="Underlying editor">
      <div data-task-overlay-body>
        <input
          aria-label="Draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          onClick={() =>
            variant === "resource"
              ? policy.propose(
                  { service: proposed },
                  { exists: true, revision: "opened-modal" },
                )
              : policy.propose(legacyChange(variant))
          }
        >
          Preview
        </button>
        {policy.dialog}
      </div>
    </section>
  );
}
async function openActual(
  owner: ReturnType<typeof ownedClickScenario>,
  variant: Variant = "resource",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <UIProviders>
        <Caller variant={variant} />
      </UIProviders>
    </QueryClientProvider>,
  );
  await owner.click(() => screen.getByRole("button", { name: "Preview" }));
  const dialog = await screen.findByRole("dialog", { name: "确认授权变更" });
  owner.assertActive();
  // Radix owns the task focus scope; body is the only scrollable task surface.
  const body = dialog.querySelector<HTMLElement>("[data-task-overlay-body]")!;
  expect(body).toBeTruthy();
  return {
    dialog,
    body,
    overlay: document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!,
  };
}
function transport(deferApply = false, variant: Variant = "resource") {
  const fixture = serviceEditFixture(saved, "opened-modal");
  let complete: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const writes: { path: string; body: unknown }[] = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fetch = vi.fn(async (url, init) => {
    const path = String(url);
    if (init?.method !== "POST") throw new Error(`Unexpected read: ${path}`);
    const body = JSON.parse(init.body);
    writes.push({ path, body });
    if (path === "/api/access-policy/preview")
      return json(
        variant === "resource"
          ? fixture.preview(body.change.service, {
              revision: "modal-reviewed",
              affected: [],
              blockers: [],
            })
          : {
              revision: "modal-reviewed",
              affected: variant === "affected" ? affected : [],
              blockers: [],
            },
      );
    if (path === "/api/access-policy/apply")
      return deferApply ? pending : json({});
    throw new Error(`Unexpected write: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  let completed = false;
  return {
    writes,
    complete: () => {
      if (!completed) {
        completed = true;
        complete(json({}));
      }
    },
  };
}

it("wires native Radix boundaries through the actual policy task without changing draft, consent or payload", async (context) => {
  const owner = ownedClickScenario(context);
  const { writes } = transport();
  const { dialog, body } = await openActual(owner);
  const user = userEvent.setup();
  const target = within(dialog).getByRole("button", { name: "返回编辑" });
  const close = within(dialog).getByRole("button", { name: "关闭" });
  const drawer = screen
    .getByLabelText("Draft")
    .closest("[data-task-overlay-body]") as HTMLElement;
  body.scrollTop = 22;
  drawer.scrollTop = 33;
  const documentScroll = document.documentElement.scrollTop;
  focus(target);
  expect(document.activeElement).toBe(target);
  // Footer is fixed outside the scroll body, so focusing it must not move content.
  expect(body.scrollTop).toBe(22);
  expect(drawer.scrollTop).toBe(33);
  expect(document.documentElement.scrollTop).toBe(documentScroll);
  await user.tab();
  expect(document.activeElement).toBe(close);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(target);
  expect(
    within(dialog)
      .getByRole("checkbox", { name: consent })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
    "Unchanged draft",
  );
  expect(writes).toEqual([
    {
      path: "/api/access-policy/preview",
      body: {
        change: { service: proposed },
        precondition: { exists: true, revision: "opened-modal" },
      },
    },
  ]);
});

it.for(["Escape", "mask", "return"] as const)(
  "preserves actual %s dismissal and removes the current review handlers",
  async (method, context) => {
    const owner = ownedClickScenario(context);
    const { writes } = transport();
    const { dialog, body, overlay } = await openActual(owner);
    const target = within(dialog).getByRole("button", { name: "返回编辑" });
    focus(target);
    if (method === "Escape") await userEvent.keyboard("{Escape}");
    else if (method === "mask") await owner.click(() => overlay);
    else await owner.click(() => target);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
    );
    owner.assertActive();
    expect(writes).toHaveLength(1);
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(
      "Unchanged draft",
    );
    const position = body.scrollTop;
    fireEvent.focusIn(target);
    expect(key(target)).toBe(true);
    expect(body.scrollTop).toBe(position);
  },
);

it.for(["resource", "affected", "zero"] as const)(
  "keeps both pending %s boundaries inside the actual task while preserving dismiss guards and exact requests",
  async (variant, context) => {
    const owner = ownedClickScenario(context);
    const { writes, complete } = transport(true, variant);
    context.onTestFinished(complete);
    const { dialog, body, overlay } = await openActual(owner, variant);
    const user = userEvent.setup();
    if (variant === "zero")
      await owner.click(() =>
        within(dialog).getByRole("button", { name: "授权规则" }),
      );
    await owner.click(() =>
      within(dialog).getByRole("checkbox", { name: consent }),
    );
    const update = within(dialog).getByRole("button", { name: "更新授权" });
    await owner.click(() => update);
    await waitFor(() => expect(update.getAttribute("aria-busy")).toBe("true"));
    owner.assertActive();
    try {
      expect(within(dialog).queryByRole("button", { name: "关闭" })).toBeNull();
      expect(
        within(dialog)
          .getByRole("button", { name: "返回编辑" })
          .matches(":disabled"),
      ).toBe(true);
      expect(update.matches(":disabled")).toBe(false);
      const first =
        variant === "resource"
          ? within(dialog).getByText("方案标识", { selector: "summary" })
          : variant === "affected"
            ? within(dialog).getByRole("checkbox", { name: "显示完整授权" })
            : within(dialog).getByRole("button", { name: "授权规则" });
      const agreement = within(dialog).getByRole("checkbox", { name: consent });
      body.scrollTop = 22;
      focus(first);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(update);
      await user.tab();
      expect(document.activeElement).toBe(first);
      expect(agreement.getAttribute("aria-checked")).toBe("true");
      if (variant === "resource")
        expect(first.parentElement!.hasAttribute("open")).toBe(false);
      if (variant === "affected") {
        expect(first.getAttribute("aria-checked")).toBe("false");
        expect(
          within(
            within(dialog).getByRole("navigation", { name: "分页" }),
          ).getAllByRole("button").length,
        ).toBeGreaterThan(0);
      }
      if (variant === "zero")
        expect(first.getAttribute("aria-expanded")).toBe("true");
      await owner.click(() => agreement);
      await waitFor(() => expect(update.matches(":disabled")).toBe(true));
      owner.assertActive();
      expect(update.getAttribute("aria-busy")).toBe("true");
      expect(agreement.getAttribute("aria-checked")).toBe("false");
      focus(agreement);
      await user.tab();
      expect(document.activeElement).toBe(first);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(agreement);
      expect(agreement.getAttribute("aria-checked")).toBe("false");
      await user.keyboard("{Escape}");
      await owner.click(() => overlay);
      expect(screen.getByRole("dialog", { name: "确认授权变更" })).toBe(dialog);
      const change =
        variant === "resource" ? { service: proposed } : legacyChange(variant);
      expect(writes).toEqual([
        {
          path: "/api/access-policy/preview",
          body:
            variant === "resource"
              ? {
                  change,
                  precondition: { exists: true, revision: "opened-modal" },
                }
              : change,
        },
        {
          path: "/api/access-policy/apply",
          body: { change, revision: "modal-reviewed" },
        },
      ]);
    } finally {
      await act(async () => complete());
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "确认授权变更" })).toBeNull(),
    );
    owner.assertActive();
  },
);

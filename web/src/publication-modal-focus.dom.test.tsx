// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { wrapPublicationModalTab } from "./publication-modal-focus";

// jsdom has no layout: supply only the rendered-box seam used by rc's list.
// Native sequential/document-focus behavior is separately asserted in browser.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let shown = true;
    for (let node: HTMLElement | null = this; node; node = node.parentElement) {
      if (node.hidden || getComputedStyle(node).display === "none") shown = false;
    }
    return { x: 0, y: 0, top: 0, left: 0, right: shown ? 100 : 0, bottom: shown ? 40 : 0,
      width: shown ? 100 : 0, height: shown ? 40 : 0, toJSON() { return {}; } };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const surface = (children: ReactNode) => render(<section role="dialog" aria-label="Publication"><div onKeyDown={wrapPublicationModalTab}>{children}</div></section>);
const button = (name: string) => screen.getByRole("button", { name });
const ordinary = () => surface(<><button>Close</button><input aria-label="Name" /><button>Cancel</button></>);

it("wraps the last button forward to the first", async () => {
  ordinary(); await userEvent.click(button("Cancel"));
  expect(fireEvent.keyDown(button("Cancel"), { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(button("Close"));
});
it("wraps the first button backward to the last", async () => {
  ordinary(); await userEvent.click(button("Close"));
  expect(fireEvent.keyDown(button("Close"), { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(button("Cancel"));
});
it("leaves interior traversal to the native default", async () => {
  ordinary(); const input = screen.getByRole("textbox", { name: "Name" }); await userEvent.click(input);
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(input);
});
it.each(["altKey", "ctrlKey", "metaKey"])("does not intercept Tab with %s", async (modifier) => {
  ordinary(); await userEvent.click(button("Cancel"));
  expect(fireEvent.keyDown(button("Cancel"), { key: "Tab", [modifier]: true })).toBe(true);
  expect(document.activeElement).toBe(button("Cancel"));
});
it("respects a child that already prevented default", async () => {
  surface(<><button>Close</button><button onKeyDown={(event) => event.preventDefault()}>Cancel</button></>);
  await userEvent.click(button("Cancel")); fireEvent.keyDown(button("Cancel"), { key: "Tab" });
  expect(document.activeElement).toBe(button("Cancel"));
});
it("does not take ownership from a nested dialog", async () => {
  surface(<><button>Close</button><section role="dialog"><button>Nested first</button><button>Nested last</button></section><button>Cancel</button></>);
  await userEvent.click(button("Nested last"));
  expect(fireEvent.keyDown(button("Nested last"), { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(button("Nested last"));
});
it("does not intercept a React-bubbling portal popup", async () => {
  surface(<><button>Close</button><button>Cancel</button>{createPortal(<div role="listbox"><button>Popup control</button></div>, document.body)}</>);
  await userEvent.click(button("Popup control"));
  expect(fireEvent.keyDown(button("Popup control"), { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(button("Popup control"));
});
it("skips hidden, inert, disabled and negative-tabindex candidates", async () => {
  surface(<><div hidden><button>Hidden</button></div><div inert><button>Inert</button></div><div aria-hidden="true"><button>Aria hidden</button></div><fieldset disabled><button>Disabled fieldset</button></fieldset><button aria-disabled="true">Aria disabled</button><button style={{ visibility: "hidden" }}>Invisible</button><button style={{ display: "none" }}>No box</button><button tabIndex={-1}>Negative</button><button>Close</button><button>Cancel</button><button disabled>Publish</button></>);
  await userEvent.click(button("Cancel"));
  expect(fireEvent.keyDown(button("Cancel"), { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(button("Close"));
});
it("orders positive tabindex before ordinary controls", async () => {
  surface(<><button>Close</button><button tabIndex={2}>Second priority</button><button tabIndex={1}>First priority</button><button>Cancel</button></>);
  await userEvent.click(button("Cancel")); fireEvent.keyDown(button("Cancel"), { key: "Tab" });
  expect(document.activeElement).toBe(button("First priority"));
  fireEvent.keyDown(button("First priority"), { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(button("Cancel"));
});
it("does not reinterpret nonbutton composite boundaries", async () => {
  surface(<><input type="radio" aria-label="Choice" /><button>Cancel</button></>);
  await userEvent.click(button("Cancel"));
  expect(fireEvent.keyDown(button("Cancel"), { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(button("Cancel"));
});
it("leaves an expanded popup trigger in control of its Tab", async () => {
  surface(<><button>Close</button><button aria-expanded="true">Popup trigger</button></>);
  await userEvent.click(button("Popup trigger"));
  expect(fireEvent.keyDown(button("Popup trigger"), { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(button("Popup trigger"));
});

it("opts only an ordinary trailing href into link wrapping without activating it", () => {
  const activate = vi.fn();
  render(<section role="dialog" aria-label="Access"><div onKeyDown={(event) => wrapPublicationModalTab(event, { allowTrailingLink: true })}><button>Close</button><input aria-label="Read-only address" readOnly /><a href="/synthetic-download" onClick={activate}>Download</a></div></section>);
  const link = screen.getByRole("link", { name: "Download" });
  link.focus();
  expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(button("Close"));
  const focusLink = vi.spyOn(link, "focus");
  expect(fireEvent.keyDown(button("Close"), { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(link);
  expect(focusLink).toHaveBeenCalledExactlyOnceWith();
  expect(activate).not.toHaveBeenCalled();
});
it("opts native scrolling into a button boundary without changing the default call", () => {
  render(<section role="dialog" aria-label="Source"><div onKeyDown={(event) => wrapPublicationModalTab(event, { scroll: "native" })}><button>Close</button><input aria-label="Name" /><button>Save</button></div></section>);
  const save = button("Save"); button("Close").focus(); const focusSave = vi.spyOn(save, "focus");
  expect(fireEvent.keyDown(button("Close"), { key: "Tab", shiftKey: true })).toBe(false);
  expect(document.activeElement).toBe(save);
  expect(focusSave).toHaveBeenCalledExactlyOnceWith();
});

it("leaves link boundaries unchanged unless the explicit trailing-link option is enabled", () => {
  surface(<><button>Close</button><a href="/synthetic-download">Download</a></>);
  const link = screen.getByRole("link", { name: "Download" }); link.focus();
  expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(link);
});
it("keeps native button focus scrolling suppressed by default", () => {
  ordinary(); button("Close").focus(); const last = button("Cancel"), focusLast = vi.spyOn(last, "focus");
  expect(fireEvent.keyDown(button("Close"), { key: "Tab", shiftKey: true })).toBe(false);
  expect(focusLast).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
});
it("does not turn native scrolling alone into permission to wrap a trailing anchor", () => {
  render(<section role="dialog"><div onKeyDown={(event) => wrapPublicationModalTab(event, { scroll: "native" })}><button>Close</button><a href="/synthetic-download">Download</a></div></section>);
  const link = screen.getByRole("link", { name: "Download" }); link.focus();
  expect(fireEvent.keyDown(link, { key: "Tab" })).toBe(true);
});
it.each(["leading-link", "no-href"])("does not reinterpret the unapproved %s boundary", (kind) => {
  render(<section role="dialog"><div onKeyDown={(event) => wrapPublicationModalTab(event, { allowTrailingLink: true })}>{kind === "leading-link" ? <><a href="/synthetic-download">Leading</a><button>Last</button></> : <><button>Close</button><a tabIndex={0}>No destination</a></>}</div></section>);
  const last = kind === "leading-link" ? button("Last") : screen.getByText("No destination"); last.focus();
  expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(last);
});
it("retains modifier and nested-owner exclusions with the trailing link opt-in", () => {
  render(<section role="dialog"><div onKeyDown={(event) => wrapPublicationModalTab(event, { allowTrailingLink: true })}><button>Close</button><a href="/synthetic-download">Download</a>{createPortal(<section role="dialog"><a href="/nested">Nested link</a></section>, document.body)}</div></section>);
  const link = screen.getByRole("link", { name: "Download" }); link.focus();
  expect(fireEvent.keyDown(link, { key: "Tab", ctrlKey: true })).toBe(true);
  const nested = screen.getByRole("link", { name: "Nested link" }); nested.focus();
  expect(fireEvent.keyDown(nested, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(nested);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "./components/ui/sidebar";
import { SidebarNavigationGroup } from "./App";

// Keep exiting children mounted, as CSS Presence does during the real 150 ms exit.
vi.mock("./components/ui/collapsible", async () => {
  const actual = await vi.importActual<typeof import("./components/ui/collapsible")>("./components/ui/collapsible");
  return { ...actual, CollapsibleContent: (props: React.ComponentProps<typeof actual.CollapsibleContent>) => <actual.CollapsibleContent {...props} forceMount /> };
});
afterEach(cleanup);
const view = (active = false) => <SidebarProvider>
  <SidebarNavigationGroup key={`materials:${active}`} defaultOpen={active} label="订阅素材">
    <a href="#sources">订阅来源</a>
  </SidebarNavigationGroup>
  <button>下一组</button>
</SidebarProvider>;

it("makes retained exit content inert immediately across rapid keyboard toggles", async () => {
  render(view(true));
  const trigger = screen.getByRole("button", { name: "订阅素材" });
  const link = screen.getByRole("link", { name: "订阅来源" });
  const content = link.closest('[data-slot="collapsible-content"]')!;
  trigger.focus();
  await userEvent.keyboard("{Enter}{Enter}{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(link.isConnected).toBe(true);
  // JSDOM does not implement inert tab suppression; assert the native browser contract.
  expect(content.hasAttribute("inert")).toBe(true);
  expect(content.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(trigger);
  await userEvent.keyboard("{Enter}");
  expect(content.hasAttribute("inert")).toBe(false);
  expect(content.getAttribute("aria-hidden")).toBe("false");
});

it("recovers focus only from closing children, not from a newer focus destination", () => {
  render(view(true));
  const trigger = screen.getByRole("button", { name: "订阅素材" });
  screen.getByRole("link", { name: "订阅来源" }).focus();
  fireEvent.click(trigger); // Programmatic close does not first move focus like a pointer click.
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const next = screen.getByRole("button", { name: "下一组" });
  next.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(next);
});

it("preserves keyed current-route opening and default-open semantics", () => {
  const { rerender } = render(view(false));
  const trigger = () => screen.getByRole("button", { name: "订阅素材" });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  rerender(view(true));
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(trigger());
  rerender(view(true));
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  rerender(view(false));
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  rerender(view(true));
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

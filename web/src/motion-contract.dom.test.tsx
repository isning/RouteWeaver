// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { Progress } from "./components/ui/progress";

afterEach(cleanup);

it("exposes determinate progress to assistive technology and updates it with the visible value", () => {
  const { rerender } = render(<Progress value={18} aria-label="已用额度" />);
  const progress = screen.getByRole("progressbar", { name: "已用额度" });
  expect(progress.getAttribute("aria-valuenow")).toBe("18");
  rerender(<Progress value={42} aria-label="已用额度" />);
  expect(progress.getAttribute("aria-valuenow")).toBe("42");
  rerender(<Progress value={null} aria-label="已用额度" />);
  expect(progress.hasAttribute("aria-valuenow")).toBe(false);
  rerender(<Progress aria-label="已用额度" />);
  expect(progress.hasAttribute("aria-valuenow")).toBe(false);
});

it("keeps collapsed navigation out of the tab sequence and survives rapid close/reopen", async () => {
  function NavigationGroup() {
    const [open, setOpen] = useState(false);
    return <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger>网络资源</CollapsibleTrigger>
      <CollapsibleContent><a href="#servers">服务器</a></CollapsibleContent>
    </Collapsible>;
  }
  render(<NavigationGroup />);
  const trigger = screen.getByRole("button", { name: "网络资源" });
  expect(screen.queryByRole("link", { name: "服务器" })).toBeNull();
  await userEvent.click(trigger);
  const link = screen.getByRole("link", { name: "服务器" });
  const content = link.closest('[data-slot="collapsible-content"]')!;
  // A motion contract, not a computed-animation or visual-quality assertion.
  expect(content.classList.contains("data-open:animate-accordion-down")).toBe(true);
  expect(content.classList.contains("motion-reduce:animate-none")).toBe(true);
  await userEvent.dblClick(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("link", { name: "服务器" })).toBeTruthy();
  await userEvent.click(trigger);
  expect(screen.queryByRole("link", { name: "服务器" })).toBeNull();
  trigger.focus();
  await userEvent.tab();
  expect(document.activeElement?.textContent).not.toBe("服务器");
});

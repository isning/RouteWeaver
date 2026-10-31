// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { TaskDialog, TaskSheet } from "./ui-patterns/task-overlays";
import { Checkbox } from "./components/ui/checkbox";
import { Switch } from "./components/ui/switch";
import { Button } from "./components/ui/button";

afterEach(cleanup);
it.each([false, true])("keeps footer toggles intrinsic while action buttons retain touch sizing (sheet=%s)", async (sheet) => {
  const Overlay = sheet ? TaskSheet : TaskDialog;
  render(<Overlay open onOpenChange={() => {}} title="检查执行内容" footer={<div>
    <label><Checkbox aria-label="确认执行" />我已确认执行内容</label>
    <Switch aria-label="附加检查" />
    <button role="radio" aria-checked="false" aria-label="执行模式" />
    <Button>执行任务</Button>
  </div>}><p>确认目标与影响。</p></Overlay>);
  const action = screen.getByRole("button", { name: "执行任务" });
  const footer = action.closest('[data-slot="dialog-footer"],[data-slot="sheet-footer"]')!;
  const stylesheet = document.createElement("style");
  // Real installed Tailwind compilation exercises descendant selector matching;
  // jsdom does not paint pixels, so actual geometry is independently reviewed.
  stylesheet.textContent = (await compile("@theme { --spacing: 0.25rem; --breakpoint-sm: 40rem; } @tailwind utilities;")).build([...footer.classList]);
  document.head.append(stylesheet);
  try {
    expect(getComputedStyle(action).minHeight).toBe("calc(var(--spacing) * 11)");
    for (const control of [screen.getByRole("checkbox"), screen.getByRole("switch"), screen.getByRole("radio")]) {
      expect(getComputedStyle(control).minHeight).toBe("auto");
    }
  } finally {
    stylesheet.remove();
  }
});

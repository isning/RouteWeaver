// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { PasswordInput } from "./ui-patterns/password-input";
import { Command, CommandInput } from "./components/ui/command";

afterEach(cleanup);
async function withStyles(check: () => void) {
  const stylesheet = document.createElement("style");
  stylesheet.textContent = (await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;"))
    .build([...document.body.querySelectorAll<HTMLElement>("[class]")].flatMap(node => [...node.classList]));
  document.head.append(stylesheet);
  try { check(); } finally { stylesheet.remove(); }
}
it("keeps the password input, outline and reveal target sized together", async () => {
  render(<PasswordInput aria-label="密码" />);
  const input = screen.getByLabelText("密码");
  const reveal = screen.getByRole("button", { name: "显示密码" });
  await withStyles(() => {
    for (const control of [input, input.parentElement!, reveal])
      expect(getComputedStyle(control).minHeight).toBe("calc(var(--spacing) * 11)");
    expect(getComputedStyle(input.parentElement!).height).toBe("auto");
  });
});
it("gives the actual command search input a touch target, not just its outline", async () => {
  render(<Command><CommandInput aria-label="搜索选项" /></Command>);
  await withStyles(() => {
    const input = screen.getByLabelText("搜索选项");
    expect(getComputedStyle(input).minHeight).toBe("calc(var(--spacing) * 11)");
    expect(getComputedStyle(input.parentElement!).height).toBe("auto");
  });
});

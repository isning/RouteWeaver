// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { ActionButton } from "./ui-patterns/actions";

afterEach(cleanup);
it.each([undefined, "sm", "icon"] as const)(
  "keeps real task action hit targets at least 44px (size=%s)",
  async (size) => {
    render(
      <>
        <ActionButton size={size}>保存草稿</ActionButton>
        <ActionButton size={size} asChild>
          <a href="#draft">打开草稿</a>
        </ActionButton>
      </>,
    );
    const controls = [
      screen.getByRole("button", { name: "保存草稿" }),
      screen.getByRole("link", { name: "打开草稿" }),
    ];
    const style = document.createElement("style");
    style.textContent = (
      await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
    ).build(controls.flatMap((node) => [...node.classList]));
    document.head.append(style);
    try {
      for (const control of controls) {
        expect(getComputedStyle(control).minHeight).toBe(
          "calc(var(--spacing) * 11)",
        );
        expect(getComputedStyle(control).minWidth).toBe(
          "calc(var(--spacing) * 11)",
        );
      }
    } finally {
      style.remove();
    }
  },
);

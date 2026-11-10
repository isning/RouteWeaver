// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
  FieldDescription,
} from "./components/ui/field";
afterEach(cleanup);

// Semantic/keyboard regression coverage only. Real painted focus is asserted in
// focus-components.ui.spec.ts, since jsdom cannot validate Tailwind paint.
it.each([
  ["standalone", false],
  ["standalone", true],
  ["card", false],
  ["card", true],
  ["plain-label", false],
  ["plain-label", true],
] as const)(
  "retains invalid checkbox label/error and keyboard state (wrapper=%s, checked=%s)",
  async (wrapper, checked) => {
    const control = (
      <Checkbox
        id="choice"
        defaultChecked={checked}
        aria-invalid="true"
        aria-describedby="error"
        aria-labelledby="title"
      />
    );
    render(
      <>
        <button>Before</button>
        {wrapper === "card" ? (
          <FieldLabel htmlFor="choice">
            <Field orientation="horizontal" data-invalid="true">
              {control}
              <FieldContent>
                <FieldTitle id="title">Choice</FieldTitle>
                <FieldDescription id="error">
                  Correct this choice
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldLabel>
        ) : wrapper === "plain-label" ? (
          <>
            <FieldLabel htmlFor="choice">
              {control}
              <span id="title">Choice</span>
            </FieldLabel>
            <p id="error">Correct this choice</p>
          </>
        ) : (
          <>
            {control}
            <label id="title" htmlFor="choice">
              Choice
            </label>
            <p id="error">Correct this choice</p>
          </>
        )}
        <button>After</button>
      </>,
    );
    const user = userEvent.setup();
    const checkbox = screen.getByRole("checkbox", { name: "Choice" });
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe(String(checked));
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    expect(checkbox.getAttribute("aria-describedby")).toBe(
      screen.getByText("Correct this choice").id,
    );
    await user.keyboard(" ");
    expect(checkbox.getAttribute("aria-checked")).toBe(String(!checked));
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    await user.click(screen.getByText("Choice"));
    expect(checkbox.getAttribute("aria-checked")).toBe(String(checked));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "After" }),
    );
  },
);

// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OperationalIntegerInput } from "./OperationalIntegerInput";
import { NumericInput } from "./ui-patterns/numeric-input";

afterEach(cleanup);

it.each([
  ["+0443", false],
  ["4.43e2", false],
  ["443.000", false],
  ["1e", true],
  ["", true],
  ["443.00000000000000000001", true],
] as const)(
  "retains raw operational input %j on first mount, blur and remount",
  (raw, invalid) => {
    const input = (
      <OperationalIntegerInput
        aria-label="Port"
        value={raw}
        min={1}
        max={65535}
      />
    );
    const first = render(input);
    const field = screen.getByRole("spinbutton", {
      name: "Port",
    }) as HTMLInputElement;
    expect(field.value).toBe(raw);
    fireEvent.blur(field);
    expect(field.value).toBe(raw);
    expect(field.getAttribute("aria-invalid") === "true").toBe(invalid);
    first.unmount();
    render(input);
    expect(
      (screen.getByRole("spinbutton", { name: "Port" }) as HTMLInputElement)
        .value,
    ).toBe(raw);
  },
);

it("still accepts an explicitly changed parent numeric value", () => {
  const view = render(
    <OperationalIntegerInput
      aria-label="Port"
      value="+0443"
      min={1}
      max={65535}
    />,
  );
  view.rerender(
    <OperationalIntegerInput
      aria-label="Port"
      value={9443}
      min={1}
      max={65535}
    />,
  );
  expect(
    (screen.getByRole("spinbutton", { name: "Port" }) as HTMLInputElement)
      .value,
  ).toBe("9443");
});

it("accepts a parent value round trip back to the initial number", () => {
  const view = render(
    <OperationalIntegerInput
      aria-label="Port"
      value={443}
      min={1}
      max={65535}
    />,
  );
  const field = screen.getByRole("spinbutton", {
    name: "Port",
  }) as HTMLInputElement;
  expect(field.value).toBe("443");
  view.rerender(
    <OperationalIntegerInput
      aria-label="Port"
      value={9443}
      min={1}
      max={65535}
    />,
  );
  expect(field.value).toBe("9443");
  view.rerender(
    <OperationalIntegerInput
      aria-label="Port"
      value={443}
      min={1}
      max={65535}
    />,
  );
  expect(field.value).toBe("443");
});

it("preserves a same-number edit when the parent receives its raw spelling", () => {
  let emitted = "";
  const onInputText = (text: string) => {
    emitted = text;
  };
  const view = render(
    <OperationalIntegerInput
      aria-label="Port"
      value={443}
      min={1}
      max={65535}
      onInputText={onInputText}
    />,
  );
  const field = screen.getByRole("spinbutton", {
    name: "Port",
  }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "+00443" } });
  expect(emitted).toBe("+00443");
  view.rerender(
    <OperationalIntegerInput
      aria-label="Port"
      value={emitted}
      min={1}
      max={65535}
      onInputText={onInputText}
    />,
  );
  expect(field.value).toBe("+00443");
});

it("does not change NumericInput defaults or reset behavior for other callers", () => {
  const view = render(
    <NumericInput aria-label="Count" value={12} resetKey="first" />,
  );
  const field = screen.getByRole("spinbutton", {
    name: "Count",
  }) as HTMLInputElement;
  expect(field.value).toBe("12");
  fireEvent.change(field, { target: { value: "1e" } });
  fireEvent.blur(field);
  expect(field.value).toBe("1e");
  view.rerender(
    <NumericInput aria-label="Count" value={12} resetKey="second" />,
  );
  expect(
    (screen.getByRole("spinbutton", { name: "Count" }) as HTMLInputElement)
      .value,
  ).toBe("12");
});

// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useState } from "react";
import { hasUnsavedChanges, useUnsavedChanges } from "./navigation";

afterEach(cleanup);

it("registers committed dirty input before a native navigation can observe the pre-passive-effect window", () => {
  const observed: boolean[] = [];
  function Editor() {
    const [dirty, setDirty] = useState(false);
    useUnsavedChanges(dirty);
    // Browser history events can arrive after commit but before passive effects.
    // Observe that exact boundary rather than awaiting an effect-flushing helper.
    useLayoutEffect(() => {
      if (dirty) observed.push(hasUnsavedChanges());
    }, [dirty]);
    return <button onClick={() => setDirty(true)}>Edit draft</button>;
  }
  const view = render(
    <StrictMode>
      <Editor />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  expect(observed).toEqual([true]);
  expect(hasUnsavedChanges()).toBe(true);
  view.unmount();
  expect(hasUnsavedChanges()).toBe(false);
});
